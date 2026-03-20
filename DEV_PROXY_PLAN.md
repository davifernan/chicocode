# Remote Dev Server Preview Proxy — Implementation Plan

Branch: `feat/remote-dev-proxy`  
Worktree: `../t3code-dev-proxy`

---

## Problem

In remote mode, `devServer.*` RPCs are hardwired to `managementTransport` (local server).
This means:

- `devServer.start` spawns the process **locally**, not on the remote server where the code lives
- Dev logs flow from the local server — there are no logs from the remote dev process
- The preview URL is `http://localhost:3000` — which points to the **local** machine from the browser

Additionally, there is no port-forwarding for dev server ports. Only the T3 server port is
tunneled via SSH.

---

## Solution Architecture

```
Browser (code.nilo.live)
  ├─ T3 App UI ──────────────► wss://code.nilo.live        (appTransport / SSH tunnel)
  └─ Preview <iframe> ────────► https://code.nilo.live/__devproxy/<projectId>/
                                    ├─ HTTP assets ──────────► T3 http.request → localhost:<port>/
                                    └─ HMR WebSocket ────────► T3 WS proxy → ws://localhost:<port>/
                                       (WebSocket constructor patched in iframe — all same-host
                                        WS connections are auto-prefixed with /__devproxy/<projectId>)
```

Single exposed port: T3 server (443 via Nginx/Cloudflare). No dynamic port-forwarding needed.

---

## Phase 1: Transport Switch

**Goal:** Route `devServer.*` through `appTransport` (remote-aware) instead of `managementTransport`.

### Files

- `apps/web/src/wsNativeApi.ts:323-335` — change `mgmt()` to `app()` for all devServer methods
- `apps/web/src/routes/__root.tsx:240-316` — ensure devServer subscriptions are re-established
  after `replaceAppTransport()` is called

### How `replaceAppTransport` works today

`replaceAppTransport()` swaps the `appTransport` reference. Subscriptions opened via
`appTransport.subscribe()` are tied to a specific WsTransport instance. When the transport
is replaced, existing subscriptions on the old transport die. New subscriptions must be opened
on the new transport.

The `EventRouter` in `__root.tsx` subscribes `devServer.onStatusChanged` and `devServer.onLogLine`
at mount. Currently these go to `mgmt()` (stable, never replaced), so they survive transport
switches. After this change, they go to `app()` — which gets replaced on remote connect/disconnect.

### Fix

Add `devServer.getStatuses()` + `devServer.getLogs()` reseeding to the `appTransport` welcome
event (or the existing `serverWelcome` handler if it fires on both transports). The subscriptions
themselves need to be torn down and re-opened on each transport replace.

Check `apps/web/src/wsNativeApi.ts` for where `replaceAppTransport` fires a welcome event
and hook into it.

### Pitfalls

- In local mode, `appTransport === managementTransport` (same instance). The transport switch
  effectively does nothing in local mode. Must verify no double-subscription occurs.
- `serverWelcome` fires per-transport. If both transports fire it, and devServer subs are on
  `app()`, local mode will still work correctly (app() = mgmt() locally).

---

## Phase 2: HTTP Reverse Proxy

**Goal:** `GET /__devproxy/<projectId>/<path>` proxies to the running dev server.

### New file: `apps/server/src/devServer/devServerProxy.ts`

Responsibilities:

1. Parse and validate `projectId` from URL
2. Look up running session via `DevServerManager`
3. Auth check (see Phase 5)
4. Forward request to `http://127.0.0.1:<port>/<strippedPath>`
5. Stream response back
6. If `Content-Type: text/html`: inject `<base>` tag + WebSocket patch script

### Route registration: `apps/server/src/wsServer.ts`

Insert before the `devUrl` redirect block (line ~835):

```ts
if (url.pathname.startsWith(DEV_PROXY_PATH_PREFIX)) {
  await handleDevProxyRequest(url, req, res, devServerManager);
  return;
}
```

`DEV_PROXY_PATH_PREFIX = "/__devproxy/"` — constant defined in `devServerProxy.ts`.

### HTTP proxy implementation

```
req.url: /__devproxy/abc123/foo/bar?query=1
  ↓ strip prefix + projectId
target path: /foo/bar?query=1
  ↓ lookup DevServerManager.sessions.get("abc123").url → "http://127.0.0.1:3000"
target url: http://127.0.0.1:3000/foo/bar?query=1
  ↓ http.request(targetUrl, { method, headers })
  ↓ pipe req body → target
  ↓ pipe target response → res (streaming, no buffering except for HTML)
```

Forward headers: `content-type`, `accept`, `accept-language`, `cache-control`.
Strip: `host` (set to `127.0.0.1:<port>`), `cookie` (internal), auth headers.

### HTML injection

Only applied when response `Content-Type` starts with `text/html`.

Strategy: buffer until `<head>` (or `<head ...>`) is found in the stream, inject two tags
immediately after, then resume streaming. Use a simple state machine — no full HTML parser needed.

Injected snippet (minified, injected right after `<head>`):

```html
<base href="/__devproxy/PROJECT_ID/" />
<script>
  (function () {
    var p = "/__devproxy/PROJECT_ID";
    var O = window.WebSocket;
    function PatchedWS(u, r) {
      try {
        var x = new URL(u, location.origin);
        if (x.host === location.host && !x.pathname.startsWith(p))
          ((x.pathname = p + x.pathname), (u = x.toString()));
      } catch (e) {}
      return new O(u, r);
    }
    PatchedWS.prototype = O.prototype;
    PatchedWS.CONNECTING = O.CONNECTING;
    PatchedWS.OPEN = O.OPEN;
    PatchedWS.CLOSING = O.CLOSING;
    PatchedWS.CLOSED = O.CLOSED;
    window.WebSocket = PatchedWS;
  })();
</script>
```

### Pitfalls

- **gzip/brotli encoding**: Dev servers in dev mode usually respond uncompressed. To be safe,
  strip `Accept-Encoding` from the proxy request so the dev server never compresses.
- **Chunked HTML across chunk boundaries**: The `<head>` tag search must handle the case where
  `<he` is at the end of one chunk and `ad>` is at the start of the next. Buffer until `<head`
  - the next `>` are both seen.
- **No buffering for non-HTML**: JS/CSS/images must stream without buffering — they can be large.
- **`Host` header**: Must be set to `127.0.0.1:<port>` not the original host, otherwise some
  dev servers reject the request with CORS or vhost errors.
- **Redirect handling**: If the dev server returns a 301/302, the `Location` header will point
  to `http://localhost:3000/...`. Must rewrite `Location` to `/__devproxy/<projectId>/...`.

---

## Phase 3: WebSocket Proxy (HMR)

**Goal:** WS upgrades on `/__devproxy/<projectId>/*` are forwarded to the dev server.

### Upgrade handler: `apps/server/src/wsServer.ts:2115`

Add path check **before** the T3 WS auth + `wss.handleUpgrade` block:

```ts
httpServer.on("upgrade", (request, socket, head) => {
  socket.on("error", () => {});

  const url = new URL(request.url ?? "/", `http://localhost:${port}`);

  // Dev proxy WS (HMR)
  if (url.pathname.startsWith(DEV_PROXY_PATH_PREFIX)) {
    handleDevProxyWsUpgrade(url, request, socket, head, devServerManager);
    return;
  }

  // ... existing T3 auth + wss.handleUpgrade ...
});
```

### `handleDevProxyWsUpgrade` in `devServerProxy.ts`

```
1. Auth check (cookie, see Phase 5)
2. Parse projectId from url.pathname
3. DevServerManager.getSession(projectId) → session.url → extract port
4. Strip /__devproxy/<projectId> prefix from pathname
5. Build target WS URL: ws://127.0.0.1:<port>/<strippedPath>
6. Open WebSocket to target
7. On target open: use a temporary WebSocketServer({ noServer: true }).handleUpgrade
   to complete the browser handshake
8. Bidirectional message pipe (binary flag preserved)
9. Forward close/error in both directions
```

### Pitfalls

- **Auth before WS patch**: The browser-side WS (HMR) connects without the `?token=` param
  that T3 requires. This is fine because we intercept BEFORE the T3 auth check. But the proxy
  itself must still verify the request is authorized (cookie-based, Phase 5).
- **Target connection failure**: If the dev server isn't running yet when HMR WS connects,
  destroy the socket cleanly. The Vite/Webpack client will retry — that is fine.
- **Path stripping**: `/__devproxy/abc123/ws` → target path must be `/ws`, not `/__devproxy/abc123/ws`.
- **Multiple projects**: Each projectId has its own dev server port. The proxy must correctly
  route each WS connection to the correct port.

---

## Phase 4: Client Preview URL

**Goal:** `dev-server-preview.tsx` uses the proxy URL, not the raw `localhost` URL.

### `apps/web/src/routes/dev-server-preview.tsx`

Change `?target=http://localhost:3000` to `?projectId=abc123`.
The route builds the iframe src as `/__devproxy/${projectId}/`.

In remote mode the proxy endpoint is on the same host as the T3 app.
In local mode `/__devproxy/<projectId>/` also works — same T3 server, just local.

### `apps/web/src/components/chat/DevLogsPanel.tsx:144`

Preview button currently constructs a URL with the raw `serverUrl`.
Change to pass `projectId` instead and open `/dev-server-preview?projectId=...`.

### `packages/contracts/src/devServer.ts`

`DevServerInfo` stays unchanged. The `url` field remains the internal dev server URL
(used server-side by the proxy). The client never uses `url` directly for preview anymore.

---

## Phase 5: Auth for Proxy Endpoint

**Goal:** `/__devproxy/*` HTTP requests are authenticated without per-request token params.

### Problem

The iframe loads many sub-requests (JS, CSS, images, WS). We can't put `?token=` on every
one. Query params on sub-resources loaded by the browser are not controllable.

### Solution: Session Cookie

On the first successful T3 WS connection (after token validation in the upgrade handler),
the server sets a `Set-Cookie` response header:

```
Set-Cookie: t3_session=<signed-token>; HttpOnly; SameSite=Strict; Path=/; Secure
```

All subsequent HTTP requests (including proxy sub-requests from the iframe) automatically
include this cookie. The proxy handler validates it.

### Implementation

- `apps/server/src/wsServer.ts` — in the upgrade handler, after token validation succeeds,
  set a session cookie via the HTTP upgrade response headers. The `ws` library allows passing
  custom headers in `handleUpgrade` via the `response` argument.
- `apps/server/src/devServer/devServerProxy.ts` — `handleDevProxyRequest` reads the cookie
  and validates it against the configured auth token.
- If no auth token is configured on the server, the proxy is open (same as T3 itself).

### Pitfalls

- `SameSite=Strict` means the cookie is only sent for same-site requests — correct here since
  the iframe is on the same domain.
- Must use `Secure` flag since we're on HTTPS in production. In dev (HTTP), `Secure` is omitted.
- The cookie value can simply be `HMAC-SHA256(authToken, "t3_session")` — no need for
  per-session state.

---

## Phase 6: Hardening

| Issue                          | Fix                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Open proxy                     | Only proxy to sessions tracked by `DevServerManager`. Unknown `projectId` → 404.                                                     |
| Dev server stopped mid-session | HTTP: 502 with JSON error. WS: close with 1011 (Internal Error).                                                                     |
| Redirect loops                 | Rewrite `Location` header on 3xx responses from dev server.                                                                          |
| Absolute asset URLs            | Document as known limitation. Modern bundlers use relative URLs in dev mode.                                                         |
| Proxy timeouts                 | HTTP: 30s. WS: no timeout (long-lived).                                                                                              |
| WS cleanup                     | When `DevServerManager` emits `statusChanged` with status `stopped`/`error`, close all open proxy WS connections for that projectId. |
| CORS headers                   | Strip `Access-Control-Allow-Origin` from dev server responses — not needed since iframe is same-origin.                              |
| `x-forwarded-*` headers        | Set `X-Forwarded-Host`, `X-Forwarded-Proto` on proxy requests.                                                                       |

---

## File Manifest

| File                                            | Change                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/server/src/devServer/devServerProxy.ts`   | **NEW** — HTTP proxy, WS proxy, HTML injection                                      |
| `apps/server/src/wsServer.ts`                   | Add proxy route (~line 835), WS upgrade routing (~line 2115), cookie set after auth |
| `apps/web/src/wsNativeApi.ts`                   | `devServer.*` from `mgmt()` → `app()`                                               |
| `apps/web/src/routes/__root.tsx`                | Re-subscribe devServer events after transport switch                                |
| `apps/web/src/routes/dev-server-preview.tsx`    | `?projectId=` param, iframe src = `/__devproxy/${projectId}/`                       |
| `apps/web/src/components/chat/DevLogsPanel.tsx` | Preview button uses `projectId`                                                     |

---

## Implementation Order

1. `DEV_PROXY_PLAN.md` — this file (done)
2. Phase 1 — transport switch (wsNativeApi.ts + \_\_root.tsx)
3. Phase 2 — HTTP proxy (devServerProxy.ts + wsServer.ts route)
4. Phase 2b — HTML injection in proxy
5. Phase 3 — WS proxy (wsServer.ts upgrade handler + devServerProxy.ts WS)
6. Phase 4 — client preview URL (dev-server-preview.tsx + DevLogsPanel.tsx)
7. Phase 5 — auth cookie
8. Phase 6 — hardening pass
9. `bun typecheck && bun lint && bun fmt`
