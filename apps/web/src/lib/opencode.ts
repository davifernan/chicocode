import { serverApiUrl } from "./serverOrigin";

export interface OpenCodeServerStatusResponse {
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly url?: string;
  readonly managedByT3?: boolean;
  readonly message?: string;
}

function buildOpenCodePath(pathname: string, opts?: { serverUrl?: string }): string {
  const base = serverApiUrl(pathname);
  if (!opts?.serverUrl) return base;
  const url = new URL(base);
  url.searchParams.set("serverUrl", opts.serverUrl);
  return url.toString();
}

export async function fetchOpenCodeServerStatus(opts?: {
  serverUrl?: string;
}): Promise<OpenCodeServerStatusResponse> {
  const resp = await fetch(buildOpenCodePath("/api/opencode/server", opts), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) throw new Error(`Server status fetch failed (${resp.status})`);
  return (await resp.json()) as OpenCodeServerStatusResponse;
}

export function openCodeServerStatusQueryKey(serverUrl: string | null | undefined) {
  return ["opencode", "server-status", serverUrl ?? null] as const;
}
