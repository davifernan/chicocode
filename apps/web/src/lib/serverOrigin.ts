/**
 * Derives the T3 server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s): → http(s):.
 *
 * In Electron the backend binds to a dynamic port. The correct address is
 * exposed through desktopBridge.getWsUrl(). In the browser/dev-server case
 * we fall back to VITE_WS_URL, then to the current window origin.
 *
 * Use this for all absolute `/api/*` fetch calls so they reach the backend
 * regardless of whether Vite's dev proxy is in play.
 */
export function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;

  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

/**
 * Build an absolute URL to a T3 server API path.
 * Example: serverApiUrl("/api/opencode/server/start") →
 *   "http://127.0.0.1:49201/api/opencode/server/start"
 */
export function serverApiUrl(path: string): string {
  return `${getServerHttpOrigin()}${path}`;
}
