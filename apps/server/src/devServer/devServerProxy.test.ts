import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import type { ProjectId } from "@t3tools/contracts";
import type { DevServerManager } from "./DevServerManager.ts";
import {
  DEV_PROXY_PATH_PREFIX,
  parseDevProxyUrl,
  buildHtmlInjection,
  handleDevProxyRequest,
  handleDevProxyWsUpgrade,
  closeProxyWsConnectionsForProject,
} from "./devServerProxy.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal DevServerManager mock. Only implements getStatus. */
function makeManager(
  sessions: Record<string, { status: string; url?: string }> = {},
): DevServerManager {
  return {
    getStatus: vi.fn((projectId: ProjectId) => {
      const id = projectId as unknown as string;
      const s = sessions[id];
      if (!s) return { projectId: id, status: "idle" };
      return { projectId: id, status: s.status, url: s.url };
    }),
  } as unknown as DevServerManager;
}

/** Start a plain HTTP server on a random port. Returns { server, baseUrl, close }. */
async function startFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err?: Error) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Start a proxy HTTP server that calls handleDevProxyRequest for every
 * request on /__devproxy/*, returning { proxyBaseUrl, close }.
 */
async function startProxyServer(
  manager: DevServerManager,
): Promise<{ proxyBaseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith(DEV_PROXY_PATH_PREFIX)) {
      handleDevProxyRequest(url, req, res, manager);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no address");
  const proxyBaseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    proxyBaseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err?: Error) => (err ? reject(err) : resolve())),
      ),
  };
}

// ── parseDevProxyUrl ──────────────────────────────────────────────────────────

describe("parseDevProxyUrl", () => {
  it("parses a standard path with sub-path and search params", () => {
    const url = new URL("/__devproxy/abc123/foo/bar?q=1", "http://localhost");
    expect(parseDevProxyUrl(url)).toEqual({
      projectId: "abc123",
      strippedPath: "/foo/bar?q=1",
    });
  });

  it("parses root with trailing slash", () => {
    const url = new URL("/__devproxy/abc123/", "http://localhost");
    expect(parseDevProxyUrl(url)).toEqual({
      projectId: "abc123",
      strippedPath: "/",
    });
  });

  it("parses root without trailing slash", () => {
    const url = new URL("/__devproxy/abc123", "http://localhost");
    expect(parseDevProxyUrl(url)).toEqual({
      projectId: "abc123",
      strippedPath: "/",
    });
  });

  it("returns null for empty projectId (double slash)", () => {
    const url = new URL("/__devproxy//foo", "http://localhost");
    expect(parseDevProxyUrl(url)).toBeNull();
  });

  it("returns null for bare prefix with no projectId", () => {
    const url = new URL("/__devproxy/", "http://localhost");
    expect(parseDevProxyUrl(url)).toBeNull();
  });

  it("preserves query string on sub-path", () => {
    const url = new URL("/__devproxy/proj1/@vite/client?t=123", "http://localhost");
    const result = parseDevProxyUrl(url);
    expect(result?.strippedPath).toBe("/@vite/client?t=123");
    expect(result?.projectId).toBe("proj1");
  });

  it("handles path with multiple segments", () => {
    const url = new URL("/__devproxy/p/a/b/c/d", "http://localhost");
    expect(parseDevProxyUrl(url)).toEqual({ projectId: "p", strippedPath: "/a/b/c/d" });
  });
});

// ── buildHtmlInjection ────────────────────────────────────────────────────────

describe("buildHtmlInjection", () => {
  it("returns a Buffer", () => {
    expect(buildHtmlInjection("myproject")).toBeInstanceOf(Buffer);
  });

  it("contains a <base href> tag pointing to the proxy prefix", () => {
    const injection = buildHtmlInjection("proj123").toString("utf8");
    expect(injection).toContain(`<base href="/__devproxy/proj123/">`);
  });

  it("contains a <script> tag with the WebSocket patch", () => {
    const injection = buildHtmlInjection("proj123").toString("utf8");
    expect(injection).toContain("<script>");
    expect(injection).toContain("window.WebSocket");
  });

  it("embeds the projectId prefix in the WebSocket patch", () => {
    const injection = buildHtmlInjection("myproj").toString("utf8");
    // The prefix is JSON-stringified inside the script
    expect(injection).toContain('"/__devproxy/myproj"');
  });

  it("preserves all four WebSocket static constants", () => {
    const injection = buildHtmlInjection("x").toString("utf8");
    expect(injection).toContain("W.CONNECTING=O.CONNECTING");
    expect(injection).toContain("W.OPEN=O.OPEN");
    expect(injection).toContain("W.CLOSING=O.CLOSING");
    expect(injection).toContain("W.CLOSED=O.CLOSED");
  });

  it("different projectIds produce different injections", () => {
    const a = buildHtmlInjection("proj-a").toString("utf8");
    const b = buildHtmlInjection("proj-b").toString("utf8");
    expect(a).not.toBe(b);
    expect(a).toContain("proj-a");
    expect(b).toContain("proj-b");
  });
});

// ── handleDevProxyRequest ─────────────────────────────────────────────────────

describe("handleDevProxyRequest — error paths", () => {
  it("returns 400 for invalid proxy path", async () => {
    const manager = makeManager();
    const { proxyBaseUrl, close } = await startProxyServer(manager);
    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/`);
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("returns 502 when dev server is idle (not running)", async () => {
    const manager = makeManager({ proj1: { status: "idle" } });
    const { proxyBaseUrl, close } = await startProxyServer(manager);
    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/proj1/`);
      expect(res.status).toBe(502);
    } finally {
      await close();
    }
  });

  it("returns 502 when dev server url is from a non-local hostname", async () => {
    const manager = makeManager({ proj1: { status: "running", url: "http://example.com:3000" } });
    const { proxyBaseUrl, close } = await startProxyServer(manager);
    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/proj1/`);
      expect(res.status).toBe(502);
    } finally {
      await close();
    }
  });
});

describe("handleDevProxyRequest — non-HTML proxying", () => {
  it("proxies a plain text response without modification", async () => {
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello world");
    });

    const manager = makeManager({ proj1: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/proj1/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("hello world");
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });

  it("strips CORS headers from upstream response", async () => {
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST",
      });
      res.end("export default 42;");
    });

    const manager = makeManager({ proj1: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/proj1/bundle.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-methods")).toBeNull();
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });

  it("rewrites Location header on 302 redirect to local upstream", async () => {
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((req, res) => {
      // Only redirect the first request; serve normally on /target
      if (req.url === "/") {
        // redirect to an absolute URL on the same host
        const upstreamOrigin = new URL(upstreamUrl);
        res.writeHead(302, { Location: `${upstreamOrigin.origin}/target` });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("target page");
      }
    });

    const manager = makeManager({ proj1: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/proj1/`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      // Location must point through the proxy, not directly to the upstream
      expect(location).toBe("/__devproxy/proj1/target");
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });

  it("forwards the upstream status code", async () => {
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("upstream not found");
    });

    const manager = makeManager({ proj1: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/proj1/missing`);
      expect(res.status).toBe(404);
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });
});

describe("handleDevProxyRequest — HTML injection", () => {
  it("injects base tag and script into HTML responses", async () => {
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><head><title>App</title></head><body>Hi</body></html>");
    });

    const manager = makeManager({ myapp: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/myapp/`);
      expect(res.status).toBe(200);
      const body = await res.text();

      // base tag injected right after <head>
      expect(body).toContain('<base href="/__devproxy/myapp/">');
      // WebSocket patch script injected
      expect(body).toContain("window.WebSocket");
      // Original content preserved
      expect(body).toContain("<title>App</title>");
      expect(body).toContain("<body>Hi</body>");
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });

  it("injects after <head> with attributes", async () => {
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end('<html><head lang="en"><title>x</title></head><body></body></html>');
    });

    const manager = makeManager({ p: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/p/`);
      const body = await res.text();
      // Must be injected AFTER <head lang="en">, not before it
      const headIdx = body.indexOf('<head lang="en">') + '<head lang="en">'.length;
      const baseIdx = body.indexOf("<base href=");
      expect(baseIdx).toBeGreaterThanOrEqual(headIdx);
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });

  it("removes content-length from HTML responses (because bytes are added)", async () => {
    const html = "<!DOCTYPE html><html><head></head><body>Hello</body></html>";
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": String(Buffer.byteLength(html)),
      });
      res.end(html);
    });

    const manager = makeManager({ p: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/p/`);
      // content-length must be absent (or not match original) since we added bytes
      const cl = res.headers.get("content-length");
      if (cl !== null) {
        // If present, it must be larger than the original (injection was added)
        expect(Number(cl)).toBeGreaterThan(Buffer.byteLength(html));
      }
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });

  it("strips CORS headers from HTML responses too", async () => {
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Access-Control-Allow-Origin": "*",
      });
      res.end("<html><head></head><body></body></html>");
    });

    const manager = makeManager({ p: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      const res = await fetch(`${proxyBaseUrl}/__devproxy/p/`);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });

  it("strips path prefix when forwarding sub-resource requests", async () => {
    let receivedPath = "";
    const { baseUrl: upstreamUrl, close: closeUpstream } = await startFakeUpstream((req, res) => {
      receivedPath = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end("// js");
    });

    const manager = makeManager({ p: { status: "running", url: upstreamUrl } });
    const { proxyBaseUrl, close: closeProxy } = await startProxyServer(manager);

    try {
      await fetch(`${proxyBaseUrl}/__devproxy/p/@vite/client`);
      // Upstream must receive stripped path, not the full proxy path
      expect(receivedPath).toBe("/@vite/client");
    } finally {
      await closeProxy();
      await closeUpstream();
    }
  });
});

// ── closeProxyWsConnectionsForProject ─────────────────────────────────────────

describe("closeProxyWsConnectionsForProject", () => {
  it("is a no-op when no connections are tracked for a project", () => {
    // Should not throw
    expect(() => closeProxyWsConnectionsForProject("nonexistent")).not.toThrow();
  });

  it("closes open WS connections for the project when dev server stops", async () => {
    // We spin up a full proxy + fake WS upstream to get a real tracked connection,
    // then call closeProxyWsConnectionsForProject and verify the browser WS closes.

    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const wsPort = (wss.address() as { port: number }).port;

    const manager = makeManager({
      proj: { status: "running", url: `http://127.0.0.1:${wsPort}` },
    });

    // Proxy server that handles WS upgrades via handleDevProxyWsUpgrade
    const httpServer = http.createServer();
    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith(DEV_PROXY_PATH_PREFIX)) {
        handleDevProxyWsUpgrade(url, req, socket, head, manager);
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
    });
    const proxyPort = (httpServer.address() as { port: number }).port;

    const closeServers = async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    };

    try {
      // Open a browser-side WS connection through the proxy
      const browserWs = new WebSocket(`ws://127.0.0.1:${proxyPort}/__devproxy/proj/`);
      await new Promise<void>((resolve, reject) => {
        browserWs.once("open", resolve);
        browserWs.once("error", reject);
      });

      expect(browserWs.readyState).toBe(WebSocket.OPEN);

      // Now simulate dev server stopping
      const closePromise = new Promise<void>((resolve) => {
        browserWs.once("close", resolve);
      });
      closeProxyWsConnectionsForProject("proj");

      await closePromise;
      expect(browserWs.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await closeServers();
    }
  });
});

// ── handleDevProxyWsUpgrade ───────────────────────────────────────────────────

describe("handleDevProxyWsUpgrade", () => {
  // Track servers to close after each test
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
  });

  async function setupWsProxy(
    manager: DevServerManager,
  ): Promise<{ proxyPort: number; forceClose: () => void }> {
    const httpServer = http.createServer();
    const activeSockets = new Set<import("node:stream").Duplex>();

    httpServer.on("upgrade", (req, socket, head) => {
      activeSockets.add(socket);
      socket.once("close", () => activeSockets.delete(socket));
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith(DEV_PROXY_PATH_PREFIX)) {
        handleDevProxyWsUpgrade(url, req, socket, head, manager);
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
    });
    const proxyPort = (httpServer.address() as { port: number }).port;

    const forceClose = () => {
      for (const s of activeSockets) s.destroy();
      activeSockets.clear();
    };

    cleanups.push(() => {
      forceClose();
      return new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    return { proxyPort, forceClose };
  }

  async function setupFakeWsUpstream(): Promise<{ wsPort: number; wss: WebSocketServer }> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const wsPort = (wss.address() as { port: number }).port;
    cleanups.push(() => {
      // Terminate all connected clients before closing the server
      for (const client of wss.clients) client.terminate();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    return { wsPort, wss };
  }

  it("destroys socket for invalid proxy path", async () => {
    const manager = makeManager();
    const { proxyPort } = await setupWsProxy(manager);

    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/__devproxy/`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
      ws.once("error", () => resolve(-1));
    });
    // Socket was destroyed — either closed or errored
    expect(closeCode).toBeDefined();
  });

  it("destroys socket when dev server is not running", async () => {
    const manager = makeManager({ p: { status: "idle" } });
    const { proxyPort } = await setupWsProxy(manager);

    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/__devproxy/p/`);
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.once("error", () => resolve());
    });
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("proxies messages from browser to upstream", async () => {
    const { wsPort, wss } = await setupFakeWsUpstream();
    const manager = makeManager({ p: { status: "running", url: `http://127.0.0.1:${wsPort}` } });
    const { proxyPort, forceClose } = await setupWsProxy(manager);

    // Wait for upstream to receive the message — fully event-driven
    const messageReceivedByUpstream = new Promise<string>((resolve) => {
      wss.once("connection", (ws) => {
        ws.once("message", (data) => resolve(data.toString()));
      });
    });

    const browserWs = new WebSocket(`ws://127.0.0.1:${proxyPort}/__devproxy/p/`);
    await new Promise<void>((resolve, reject) => {
      browserWs.once("open", resolve);
      browserWs.once("error", reject);
    });

    // Give the proxy one microtask tick to open the targetWs after accepting
    // the browser handshake — both happen synchronously within the callback
    // but the targetWs `open` event fires asynchronously.
    await new Promise<void>((resolve) => setImmediate(resolve));

    browserWs.send("hello from browser");
    const received = await messageReceivedByUpstream;

    // Clean up before afterEach to prevent server.close() hanging on open sockets
    browserWs.terminate();
    forceClose();

    expect(received).toBe("hello from browser");
  });

  it("proxies messages from upstream to browser", async () => {
    const { wsPort, wss } = await setupFakeWsUpstream();
    const manager = makeManager({ p: { status: "running", url: `http://127.0.0.1:${wsPort}` } });
    const { proxyPort, forceClose } = await setupWsProxy(manager);

    // Wait for the browser to receive a message from the upstream
    const messageReceivedByBrowser = new Promise<string>((resolve) => {
      const browserWs = new WebSocket(`ws://127.0.0.1:${proxyPort}/__devproxy/p/`);
      browserWs.once("message", (data) => {
        resolve(data.toString());
        browserWs.terminate();
        forceClose();
      });
      browserWs.once("error", () => resolve(""));
    });

    // Once the proxy forwards the browser connection to the upstream,
    // the upstream sends a message immediately.
    wss.once("connection", (ws) => {
      setImmediate(() => ws.send("hello from upstream"));
    });

    const received = await messageReceivedByBrowser;
    expect(received).toBe("hello from upstream");
  });

  it("forwards Sec-WebSocket-Protocol header to upstream", async () => {
    const { wsPort, wss } = await setupFakeWsUpstream();
    const manager = makeManager({ p: { status: "running", url: `http://127.0.0.1:${wsPort}` } });
    const { proxyPort, forceClose } = await setupWsProxy(manager);

    const protocolReceived = new Promise<string | null>((resolve) => {
      wss.once("connection", (_ws, req) => {
        resolve(req.headers["sec-websocket-protocol"] ?? null);
      });
    });

    const browserWs = new WebSocket(`ws://127.0.0.1:${proxyPort}/__devproxy/p/`, ["vite-hmr"]);
    await new Promise<void>((resolve, reject) => {
      browserWs.once("open", resolve);
      browserWs.once("error", reject);
    });

    const upstreamProtocol = await protocolReceived;
    browserWs.terminate();
    forceClose();

    expect(upstreamProtocol).toContain("vite-hmr");
  });

  it("closes browser WS when upstream closes", async () => {
    const { wsPort, wss } = await setupFakeWsUpstream();
    const manager = makeManager({ p: { status: "running", url: `http://127.0.0.1:${wsPort}` } });
    const { proxyPort } = await setupWsProxy(manager);

    // Once upstream is connected, close it with a clean close frame
    wss.once("connection", (ws) => setImmediate(() => ws.close(1000, "server done")));

    const browserWs = new WebSocket(`ws://127.0.0.1:${proxyPort}/__devproxy/p/`);
    await new Promise<void>((resolve, reject) => {
      browserWs.once("open", resolve);
      browserWs.once("error", reject);
    });

    await new Promise<void>((resolve) => browserWs.once("close", resolve));
    expect(browserWs.readyState).toBe(WebSocket.CLOSED);
  });
});
