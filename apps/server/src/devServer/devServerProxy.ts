/**
 * devServerProxy — HTTP and WebSocket reverse proxy for the dev server preview feature.
 *
 * Exposes a single path prefix (/__devproxy/<projectId>/) that proxies all HTTP
 * requests and WebSocket upgrades to the running dev server for that project.
 *
 * On HTML responses, two shims are injected right after `<head>`:
 *   1. `<base href="/__devproxy/<projectId>/">` — makes all relative asset URLs
 *      resolve through the proxy automatically, for every bundler.
 *   2. A `<script>` that patches `window.WebSocket` — any same-host WebSocket
 *      connection (HMR) is automatically prefixed with `/__devproxy/<projectId>`
 *      before the browser sends the upgrade request. This is the universal fix
 *      that works with Vite, Webpack, Next.js, Parcel, and any other bundler.
 *
 * WebSocket upgrades on `/__devproxy/<projectId>/*` are forwarded to the dev
 * server bidirectionally (messages, binary frames, close, error).
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { ProjectId } from "@t3tools/contracts";
import type { DevServerManager } from "./DevServerManager.ts";

// ── Constants ────────────────────────────────────────────────────────

export const DEV_PROXY_PATH_PREFIX = "/__devproxy/";

// ── Helpers ──────────────────────────────────────────────────────────

interface ParsedProxyUrl {
  projectId: string;
  /** Stripped path + search, e.g. "/foo/bar?q=1" */
  strippedPath: string;
}

/**
 * Parse a dev proxy URL into projectId and the path to forward to the upstream.
 *
 * /__devproxy/abc123/foo/bar?q=1 → { projectId: "abc123", strippedPath: "/foo/bar?q=1" }
 * /__devproxy/abc123/            → { projectId: "abc123", strippedPath: "/" }
 * /__devproxy/abc123             → { projectId: "abc123", strippedPath: "/" }
 */
function parseDevProxyUrl(url: URL): ParsedProxyUrl | null {
  const after = url.pathname.slice(DEV_PROXY_PATH_PREFIX.length);
  if (!after) return null;

  const slashIdx = after.indexOf("/");
  if (slashIdx === -1) {
    // No trailing slash — root of the project
    return { projectId: after, strippedPath: "/" + url.search };
  }

  const projectId = after.slice(0, slashIdx);
  if (!projectId) return null;

  const rest = after.slice(slashIdx); // starts with "/"
  return { projectId, strippedPath: rest + url.search };
}

/**
 * Resolve the upstream origin URL for a project.
 * Returns null with an error message if the dev server is not running.
 */
function resolveUpstream(
  projectId: string,
  manager: DevServerManager,
): { origin: URL } | { error: string; status: number } {
  let info;
  try {
    info = manager.getStatus(ProjectId.makeUnsafe(projectId));
  } catch {
    return { error: `Unknown project "${projectId}"`, status: 404 };
  }

  if (info.status !== "running" || !info.url) {
    return {
      error: `Dev server for project "${projectId}" is not running (status: ${info.status})`,
      status: 502,
    };
  }

  try {
    return { origin: new URL(info.url) };
  } catch {
    return { error: "Dev server URL is invalid", status: 502 };
  }
}

/**
 * Build the HTML injection string to insert after the opening `<head>` tag.
 *
 * Contains:
 *   - `<base href="…">` for automatic relative-URL resolution
 *   - A `window.WebSocket` monkey-patch that prefixes same-host WS URLs with
 *     the proxy path, so HMR connections go through the T3 server instead of
 *     directly to the (unreachable from the browser) dev server port.
 */
function buildHtmlInjection(projectId: string): Buffer {
  const prefix = `${DEV_PROXY_PATH_PREFIX}${projectId}`;
  const html =
    `<base href="${prefix}/">` +
    `<script>(function(){` +
    // p = the proxy prefix path for this project
    `var p=${JSON.stringify(prefix)};` +
    `var O=window.WebSocket;` +
    // Patched WebSocket constructor
    `function W(u,r){` +
    `try{` +
    `var x=new URL(u,location.origin);` +
    // Only rewrite same-host connections that don't already carry the prefix
    `if(x.host===location.host&&!x.pathname.startsWith(p)){` +
    `x.pathname=p+x.pathname;u=x.toString();` +
    `}` +
    `}catch(e){}` +
    `return new O(u,r);` +
    `}` +
    // Preserve static properties so code checking WebSocket.OPEN etc. still works
    `W.prototype=O.prototype;` +
    `W.CONNECTING=O.CONNECTING;` +
    `W.OPEN=O.OPEN;` +
    `W.CLOSING=O.CLOSING;` +
    `W.CLOSED=O.CLOSED;` +
    `window.WebSocket=W;` +
    `})();</script>`;
  return Buffer.from(html, "utf8");
}

// ── HTTP proxy ────────────────────────────────────────────────────────

/**
 * Handle a `/__devproxy/<projectId>/<path>` HTTP request.
 * Forwards the request to the running dev server and streams the response back.
 * HTML responses receive the base-tag + WebSocket-patch injection.
 */
export function handleDevProxyRequest(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  manager: DevServerManager,
): void {
  const parsed = parseDevProxyUrl(url);
  if (!parsed) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid dev proxy path");
    return;
  }

  const upstream = resolveUpstream(parsed.projectId, manager);
  if ("error" in upstream) {
    res.writeHead(upstream.status, { "Content-Type": "text/plain" });
    res.end(upstream.error);
    return;
  }

  const { origin } = upstream;
  const targetPath = parsed.strippedPath;

  // Forward most headers, stripping hop-by-hop and internal ones.
  const forwardHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "cookie" ||
      key === "authorization" ||
      key === "connection" ||
      key === "upgrade" ||
      key === "proxy-authorization" ||
      value === undefined
    ) {
      continue;
    }
    forwardHeaders[key] = value as string | string[];
  }
  // Force identity encoding — we need to inspect HTML without decompressing.
  forwardHeaders["accept-encoding"] = "identity";
  forwardHeaders["host"] = origin.host;

  const proxyReq = http.request(
    {
      hostname: origin.hostname,
      port: origin.port || (origin.protocol === "https:" ? "443" : "80"),
      path: targetPath,
      method: req.method ?? "GET",
      headers: forwardHeaders,
      timeout: 30_000,
    },
    (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] ?? "";
      const isHtml = contentType.startsWith("text/html");

      // Build response headers, rewriting Location on redirects.
      const responseHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };

      const rawLocation = proxyRes.headers["location"];
      if (rawLocation) {
        const locationStr = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
        if (typeof locationStr === "string") {
          try {
            const locationUrl = new URL(locationStr, `${origin.protocol}//${origin.host}`);
            if (locationUrl.host === origin.host) {
              responseHeaders["location"] =
                `${DEV_PROXY_PATH_PREFIX}${parsed.projectId}${locationUrl.pathname}${locationUrl.search}`;
            }
          } catch {
            // Leave Location as-is if parsing fails
          }
        }
      }

      if (!isHtml) {
        // Non-HTML: pipe directly without buffering
        res.writeHead(proxyRes.statusCode ?? 200, responseHeaders);
        proxyRes.pipe(res, { end: true });
        return;
      }

      // HTML: inject base tag + WS patch right after the opening <head> tag.
      // content-length is dropped because we're adding bytes.
      delete responseHeaders["content-length"];

      res.writeHead(proxyRes.statusCode ?? 200, responseHeaders);

      const injection = buildHtmlInjection(parsed.projectId);
      let injected = false;
      let pending = Buffer.alloc(0);

      proxyRes.on("data", (chunk: Buffer) => {
        if (injected) {
          res.write(chunk);
          return;
        }

        pending = Buffer.concat([pending, chunk]);
        const str = pending.toString("utf8");

        // Locate the end of the opening <head> tag (handles <head> and <head ...>)
        const headMatch = /<head(?:[^>]*)>/i.exec(str);
        if (headMatch?.index !== undefined) {
          const insertAt = headMatch.index + headMatch[0].length;
          res.write(pending.subarray(0, insertAt));
          res.write(injection);
          res.write(pending.subarray(insertAt));
          pending = Buffer.alloc(0);
          injected = true;
        } else if (pending.length > 8192) {
          // No <head> found yet but buffer is large — flush as-is and stop trying.
          // This handles responses that have no <head> tag (unusual but possible).
          res.write(pending);
          pending = Buffer.alloc(0);
          injected = true;
        }
      });

      proxyRes.on("end", () => {
        if (pending.length > 0) {
          res.write(pending);
        }
        res.end();
      });

      proxyRes.on("error", () => {
        if (!res.writableEnded) res.end();
      });
    },
  );

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "text/plain" });
      res.end("Dev server gateway timeout");
    }
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Dev server proxy error: ${err.message}`);
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });

  // Pipe request body (needed for POST, PUT, etc.)
  req.pipe(proxyReq, { end: true });
}

// ── WebSocket proxy ───────────────────────────────────────────────────

/**
 * A temporary WebSocketServer used only to complete HTTP upgrade handshakes.
 * Shared across all WS proxy connections to avoid creating one per connection.
 */
const upgradeWss = new WebSocketServer({ noServer: true });

/**
 * Handle a WebSocket upgrade request on `/__devproxy/<projectId>/*`.
 *
 * 1. Accepts the browser WebSocket (completes the HTTP 101 handshake).
 * 2. Opens a WebSocket connection to the dev server.
 * 3. Pipes messages, binary frames, close codes, and errors bidirectionally.
 *
 * This handles HMR connections from any bundler (Vite, Webpack, Next.js, etc.)
 * because the WebSocket constructor patch in the HTML injection routes all
 * same-host WS connections through `/__devproxy/<projectId>/*`.
 */
export function handleDevProxyWsUpgrade(
  url: URL,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  manager: DevServerManager,
): void {
  const parsed = parseDevProxyUrl(url);
  if (!parsed) {
    socket.destroy();
    return;
  }

  const upstream = resolveUpstream(parsed.projectId, manager);
  if ("error" in upstream) {
    socket.destroy();
    return;
  }

  const { origin } = upstream;

  // Replace http(s) with ws(s) for the target WebSocket URL.
  const wsProtocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const targetWsUrl = `${wsProtocol}//${origin.host}${parsed.strippedPath}`;

  // Step 1: Accept the browser connection immediately.
  upgradeWss.handleUpgrade(request, socket, head, (browserWs) => {
    // Step 2: Connect to the dev server.
    const upstreamHeaders: Record<string, string> = {};

    // Forward Sec-WebSocket-Protocol (e.g. "vite-hmr") so the dev server
    // responds with the matching protocol and doesn't reject the handshake.
    const proto = request.headers["sec-websocket-protocol"];
    if (proto) {
      upstreamHeaders["sec-websocket-protocol"] = Array.isArray(proto) ? proto.join(", ") : proto;
    }

    const targetWs = new WebSocket(targetWsUrl, {
      headers: upstreamHeaders,
    });

    // Step 3: Pipe messages bidirectionally.
    browserWs.on("message", (data, isBinary) => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data, { binary: isBinary });
      }
    });

    targetWs.on("message", (data, isBinary) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(data, { binary: isBinary });
      }
    });

    // Forward close in both directions.
    browserWs.on("close", (code, reason) => {
      if (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING) {
        targetWs.close(code, reason);
      }
    });

    targetWs.on("close", (code, reason) => {
      if (
        browserWs.readyState === WebSocket.OPEN ||
        browserWs.readyState === WebSocket.CONNECTING
      ) {
        browserWs.close(code, reason);
      }
    });

    // On upstream error, close the browser side cleanly.
    targetWs.on("error", () => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.close(1011, "Upstream WebSocket error");
      }
    });

    browserWs.on("error", () => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.terminate();
      }
    });
  });
}
