# OpenCode Server Control — Implementation Plan

> **Status**: Ready to apply. All diffs below are exact and complete.
> Apply them in order. Run `bun fmt && bun lint && bun typecheck` after each file.

---

## 1. `apps/server/src/opencode/OpenCodeProcessManager.ts`

**Changes:**

1. Fix password propagation bug (write generated credentials back to `process.env`).
2. Add `OpenCodeServerStatus` type, `OpenCodeServerCredentials` interface, and `openCodeServerControl` singleton at the bottom.

**Full replacement** (replace entire file):

```ts
/**
 * OpenCodeProcessManager - Manages the background `opencode serve` process.
 *
 * Spawns and monitors the OpenCode HTTP server as a child process, with support
 * for attaching to an existing server, health-check polling, and graceful
 * shutdown. Generates a random password for server auth when none is configured.
 *
 * Also exports `openCodeServerControl` — a module-level singleton that HTTP
 * route handlers can use to start/stop the server and read its credentials
 * without needing access to the Effect adapter lifecycle.
 *
 * @module OpenCodeProcessManager
 */

import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";

import { OpenCodeClient, type OpenCodeHealthResponse } from "./OpenCodeClient.ts";

const DEFAULT_PORT = 4096;
const DEFAULT_HOSTNAME = "127.0.0.1";
const HEALTH_POLL_INTERVAL_MS = 2_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;

export class OpenCodeProcessManager {
  private process: ChildProcess | null = null;
  private _port: number = DEFAULT_PORT;
  private _hostname: string = DEFAULT_HOSTNAME;
  private _password: string = "";
  private _username: string = "opencode";
  private _running: boolean = false;

  /** The port the managed server is listening on. */
  get port(): number {
    return this._port;
  }

  /** The hostname the managed server is bound to. */
  get hostname(): string {
    return this._hostname;
  }

  /** The password used for Basic Auth against the managed server. */
  get password(): string {
    return this._password;
  }

  /** The username used for Basic Auth against the managed server. */
  get username(): string {
    return this._username;
  }

  /** The full base URL of the managed server. */
  get baseUrl(): string {
    return `http://${this._hostname}:${this._port}`;
  }

  /**
   * Spawn `opencode serve --port <port> --hostname 127.0.0.1`.
   *
   * Sets `OPENCODE_SERVER_PASSWORD` in the child environment. Generates a
   * random password if none was configured via environment or prior call.
   * Also writes the generated credentials back to `process.env` so that HTTP
   * proxy routes running in the parent process can authenticate correctly.
   *
   * @param port - Port to listen on (default: 4096).
   */
  async start(port?: number): Promise<void> {
    if (this.process) {
      throw new Error("OpenCode process is already running");
    }

    this._port = port ?? DEFAULT_PORT;
    this._password =
      process.env.OPENCODE_SERVER_PASSWORD ?? crypto.randomBytes(24).toString("base64url");
    this._username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";

    // Write the generated credentials back to the parent process environment
    // so HTTP proxy routes (which read process.env directly) can authenticate
    // against the child OpenCode server.
    process.env.OPENCODE_SERVER_PASSWORD = this._password;
    process.env.OPENCODE_SERVER_USERNAME = this._username;

    const args = ["serve", "--port", String(this._port), "--hostname", this._hostname];

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: this._password,
    };

    this.process = spawn("opencode", args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._running = true;

    this.process.on("exit", (code, signal) => {
      this._running = false;
      this.process = null;
      if (code !== null && code !== 0) {
        console.error(`[OpenCodeProcessManager] opencode exited with code ${code}`);
      } else if (signal) {
        console.error(`[OpenCodeProcessManager] opencode killed by signal ${signal}`);
      }
    });

    this.process.on("error", (err) => {
      this._running = false;
      this.process = null;
      console.error(`[OpenCodeProcessManager] spawn error: ${err.message}`);
    });

    // Drain stdout/stderr so the pipe doesn't back up.
    this.process.stdout?.resume();
    this.process.stderr?.resume();

    await this.waitForReady();
  }

  /**
   * Attempt to attach to an already-running OpenCode server.
   *
   * Performs a health check against the provided URL. If the server responds
   * healthy, stores its connection info and returns `true`.
   *
   * @param url - Base URL of the server (e.g. `http://127.0.0.1:4096`).
   * @returns `true` if the server is reachable and healthy.
   */
  async attach(url: string): Promise<boolean> {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";

    const client = new OpenCodeClient(url, username, password);
    let health: OpenCodeHealthResponse;
    try {
      health = await client.health();
    } catch {
      return false;
    }

    if (!health.healthy) {
      return false;
    }

    // Parse connection info from URL.
    try {
      const parsed = new URL(url);
      this._hostname = parsed.hostname;
      this._port = parsed.port ? Number(parsed.port) : DEFAULT_PORT;
    } catch {
      return false;
    }

    this._username = username;
    this._password = password;
    this._running = true;
    return true;
  }

  /**
   * Poll `/global/health` until the server reports healthy.
   *
   * @param timeoutMs - Maximum wait time (default: 60 000 ms).
   * @throws If the server does not become healthy within the timeout.
   */
  async waitForReady(timeoutMs: number = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    const client = new OpenCodeClient(this.baseUrl, this._username, this._password);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const health = await client.health();
        if (health.healthy) return;
      } catch {
        // Server not ready yet — keep polling.
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new Error(
      `OpenCode server did not become healthy within ${timeoutMs}ms at ${this.baseUrl}`,
    );
  }

  /**
   * Gracefully stop the managed OpenCode process.
   *
   * Sends `SIGTERM` first, then `SIGKILL` after 5 seconds if the process
   * hasn't exited.
   */
  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;

    return new Promise<void>((resolve) => {
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      const onExit = () => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this._running = false;
        this.process = null;
        resolve();
      };

      child.once("exit", onExit);
      child.kill("SIGTERM");

      forceKillTimer = setTimeout(() => {
        if (this.process === child) {
          child.kill("SIGKILL");
        }
      }, 5_000);
    });
  }

  /** Whether the managed process is currently running. */
  isRunning(): boolean {
    return this._running;
  }

  /**
   * Create an `OpenCodeClient` connected to the managed server.
   *
   * Convenience method that builds a client with the manager's current
   * connection credentials.
   */
  createClient(): OpenCodeClient {
    return new OpenCodeClient(this.baseUrl, this._username, this._password);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Module-level singleton — OpenCode server control
// ---------------------------------------------------------------------------

/** Status of the OpenCode server as seen by T3 Code. */
export type OpenCodeServerStatus =
  | { readonly state: "stopped" }
  | { readonly state: "starting" }
  | { readonly state: "running"; readonly url: string; readonly managedByT3: boolean }
  | { readonly state: "error"; readonly message: string };

/** Credentials for the currently running OpenCode server. */
export interface OpenCodeServerCredentials {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

/**
 * Module-level singleton that HTTP route handlers can use to start/stop the
 * OpenCode server and read its credentials without needing access to the
 * Effect adapter lifecycle.
 *
 * The singleton tries to `attach()` to an existing server first. If that
 * fails, `start()` spawns a fresh process. Only processes spawned by this
 * singleton can be stopped via `stop()`.
 */
class OpenCodeServerControl {
  private _manager: OpenCodeProcessManager | null = null;
  private _status: OpenCodeServerStatus = { state: "stopped" };
  /** True only when this singleton spawned the process (not just attached). */
  private _managedByT3 = false;

  /** Current server status. */
  getStatus(): OpenCodeServerStatus {
    return this._status;
  }

  /**
   * Credentials for the currently running server.
   *
   * Falls back to environment variables when no manager is active (e.g. the
   * server was started externally and we haven't attached yet).
   */
  getCredentials(): OpenCodeServerCredentials {
    if (this._manager) {
      return {
        url: this._manager.baseUrl,
        username: this._manager.username,
        password: this._manager.password,
      };
    }
    return {
      url: process.env.OPENCODE_SERVER_URL ?? `http://${DEFAULT_HOSTNAME}:${DEFAULT_PORT}`,
      username: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
      password: process.env.OPENCODE_SERVER_PASSWORD ?? "",
    };
  }

  /**
   * Whether the running server was started by this singleton (and can
   * therefore be stopped via `stop()`).
   */
  get canStop(): boolean {
    return this._managedByT3 && this._manager !== null && this._manager.isRunning();
  }

  /**
   * Start the OpenCode server.
   *
   * First tries to attach to an existing server at the configured URL. If
   * that fails, spawns a fresh `opencode serve` process.
   *
   * @param port - Port to listen on when spawning (default: 4096).
   */
  async start(port?: number): Promise<void> {
    if (this._manager?.isRunning()) {
      return; // Already running — nothing to do.
    }

    this._status = { state: "starting" };
    const manager = new OpenCodeProcessManager();

    // Try attaching to an existing server first.
    const existingUrl =
      process.env.OPENCODE_SERVER_URL ?? `http://${DEFAULT_HOSTNAME}:${port ?? DEFAULT_PORT}`;
    const attached = await manager.attach(existingUrl);

    if (attached) {
      this._manager = manager;
      this._managedByT3 = false;
      this._status = {
        state: "running",
        url: manager.baseUrl,
        managedByT3: false,
      };
      return;
    }

    // Spawn a fresh process.
    try {
      await manager.start(port);
      this._manager = manager;
      this._managedByT3 = true;
      this._status = {
        state: "running",
        url: manager.baseUrl,
        managedByT3: true,
      };
    } catch (err) {
      this._manager = null;
      this._managedByT3 = false;
      this._status = {
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      throw err;
    }
  }

  /**
   * Stop the OpenCode server.
   *
   * Only stops processes that were spawned by this singleton. Throws if the
   * server was not started by T3 Code.
   */
  async stop(): Promise<void> {
    if (!this._managedByT3 || !this._manager) {
      throw new Error("Cannot stop an OpenCode server that was not started by T3 Code.");
    }
    await this._manager.stop();
    this._manager = null;
    this._managedByT3 = false;
    this._status = { state: "stopped" };
  }
}

/** Singleton instance for HTTP route handlers. */
export const openCodeServerControl = new OpenCodeServerControl();
```

---

## 2. `apps/server/src/opencode/index.ts`

Add exports for the new types and singleton. **Append** these lines after the `OpenCodeProcessManager` export:

```ts
export {
  openCodeServerControl,
  type OpenCodeServerCredentials,
  type OpenCodeServerStatus,
} from "./OpenCodeProcessManager.ts";
```

Full replacement:

```ts
/**
 * OpenCode provider module — barrel exports.
 *
 * Aggregates the OpenCode HTTP client, process manager, SSE client, and auth
 * manager for use by the rest of the T3Code server.
 *
 * @module opencode
 */

export {
  OpenCodeClient,
  OpenCodeClientError,
  type OpenCodeHealthResponse,
  type OpenCodeMessage,
  type OpenCodeMessageInfo,
  type OpenCodePart,
  type OpenCodePromptPart,
  type OpenCodeSession,
  type OpenCodeStepFinishPart,
  type OpenCodeTextPart,
  type OpenCodeTokenData,
  type OpenCodeToolPart,
  type OpenCodeUnknownPart,
} from "./OpenCodeClient.ts";

export { OpenCodeProcessManager } from "./OpenCodeProcessManager.ts";

export {
  openCodeServerControl,
  type OpenCodeServerCredentials,
  type OpenCodeServerStatus,
} from "./OpenCodeProcessManager.ts";

export {
  OpenCodeSseClient,
  type OpenCodeSseEvent,
  type OpenCodeSseEventHandler,
  type OpenCodeSseEventPayload,
} from "./OpenCodeSseClient.ts";

export {
  OpenCodeAuthManager,
  type OpenCodeAuthApi,
  type OpenCodeAuthEntry,
  type OpenCodeAuthOauth,
  type OpenCodeAuthStatus,
  type OpenCodeAuthWellKnown,
} from "./OpenCodeAuthManager.ts";

export {
  OpenCodeSessionDiscovery,
  type DiscoveredOpenCodeSession,
} from "./OpenCodeSessionDiscovery.ts";

export {
  OpenCodeSessionSync,
  type ExistingCatalogEntry,
  type SyncCatalogUpsert,
  type SyncOutput,
  type SyncResult,
  type SyncThreadCreateCommand,
} from "./OpenCodeSessionSync.ts";

export { canonicalizeWorkspacePath } from "./workspaceIdentity.ts";
```

---

## 3. `apps/server/src/wsServer.ts`

**Two changes:**

### 3a. Add import at top (after the existing `OpenCodeClient` import on line 81):

```ts
import { openCodeServerControl } from "./opencode/OpenCodeProcessManager.ts";
```

### 3b. Replace the `/api/opencode/providers` route block AND add 3 new routes after it.

**Find** (lines 492–535):

```ts
// ── OpenCode provider proxy ─────────────────────────────────
// Proxies GET /api/opencode/providers to the running OpenCode
// server's GET /provider endpoint. Returns the full provider
// catalog (providers, models, connected status) so the web UI
// can build a real model picker without needing auth credentials.
if (url.pathname === "/api/opencode/providers" && req.method === "GET") {
  const ocServerUrl = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";
  const ocUsername = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const ocPassword = process.env.OPENCODE_SERVER_PASSWORD ?? "";

  const result =
    yield *
    Effect.tryPromise({
      try: async () => {
        const client = new OpenCodeClient(ocServerUrl, ocUsername, ocPassword);
        return client.listProviders(cwd);
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(Effect.result);

  if (Result.isSuccess(result)) {
    respond(
      200,
      {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify(result.success),
    );
  } else {
    const detail = result.failure;
    respond(
      502,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify({
        error: "Failed to fetch providers from OpenCode server",
        detail,
      }),
    );
  }
  return;
}
```

**Replace with:**

```ts
// ── OpenCode provider proxy ─────────────────────────────────
// Proxies GET /api/opencode/providers to the running OpenCode
// server's GET /provider endpoint. Returns the full provider
// catalog (providers, models, connected status) so the web UI
// can build a real model picker without needing auth credentials.
if (url.pathname === "/api/opencode/providers" && req.method === "GET") {
  const {
    url: ocServerUrl,
    username: ocUsername,
    password: ocPassword,
  } = openCodeServerControl.getCredentials();

  const result =
    yield *
    Effect.tryPromise({
      try: async () => {
        const client = new OpenCodeClient(ocServerUrl, ocUsername, ocPassword);
        return client.listProviders(cwd);
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(Effect.result);

  if (Result.isSuccess(result)) {
    respond(
      200,
      {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify(result.success),
    );
  } else {
    const detail = result.failure;
    respond(
      502,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify({
        error: "Failed to fetch providers from OpenCode server",
        detail,
      }),
    );
  }
  return;
}

// ── OpenCode server status ───────────────────────────────────
if (url.pathname === "/api/opencode/server" && req.method === "GET") {
  respond(
    200,
    {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
    JSON.stringify(openCodeServerControl.getStatus()),
  );
  return;
}

// ── OpenCode server start ────────────────────────────────────
if (url.pathname === "/api/opencode/server/start" && req.method === "POST") {
  const startResult =
    yield *
    Effect.tryPromise({
      try: () => openCodeServerControl.start(),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(Effect.result);

  if (Result.isSuccess(startResult)) {
    respond(
      200,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify(openCodeServerControl.getStatus()),
    );
  } else {
    respond(
      502,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify({
        error: "Failed to start OpenCode server",
        detail: startResult.failure,
      }),
    );
  }
  return;
}

// ── OpenCode server stop ─────────────────────────────────────
if (url.pathname === "/api/opencode/server/stop" && req.method === "POST") {
  if (!openCodeServerControl.canStop) {
    respond(
      409,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify({
        error: "Cannot stop: server was not started by T3 Code.",
      }),
    );
    return;
  }

  const stopResult =
    yield *
    Effect.tryPromise({
      try: () => openCodeServerControl.stop(),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(Effect.result);

  if (Result.isSuccess(stopResult)) {
    respond(
      200,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify(openCodeServerControl.getStatus()),
    );
  } else {
    respond(
      502,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify({
        error: "Failed to stop OpenCode server",
        detail: stopResult.failure,
      }),
    );
  }
  return;
}
```

---

## 4. `apps/web/src/routes/_chat.settings.tsx`

### 4a. Remove dead `"opencode"` entry from `MODEL_PROVIDER_SETTINGS` (lines 52–58)

**Find:**

```ts
  {
    provider: "opencode",
    title: "OpenCode",
    description: "Save additional OpenCode model slugs for the picker and `/model` command.",
    placeholder: "your-opencode-model-slug",
    example: "claude-opus-4-20251201",
  },
```

**Replace with:** _(nothing — delete those 7 lines)_

### 4b. Remove dead `opencode` key from `customModelInputByProvider` initial state (lines 344–349)

**Find:**

```ts
const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
  Record<ProviderKind, string>
>({
  codex: "",
  opencode: "",
});
```

**Replace with:**

```ts
const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
  Partial<Record<ProviderKind, string>>
>({
  codex: "",
});
```

> Note: also update `addCustomModel` to handle the `Partial` — change `customModelInputByProvider[provider]` to `customModelInputByProvider[provider] ?? ""`.

### 4c. Add server status + Start/Stop button to the OpenCode Server section

**Find** (inside the OpenCode Server section, after the reset button block, before `</section>`):

```tsx
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
```

**Replace with:**

```tsx
              </div>

              {/* Server status + start/stop */}
              <OpenCodeServerStatusPanel />
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
```

And add the `OpenCodeServerStatusPanel` component **before** `OpenCodeModelPicker` in the file:

```tsx
// ── OpenCode Server Status Panel ────────────────────────────────────

interface OpenCodeServerStatusResponse {
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly url?: string;
  readonly managedByT3?: boolean;
  readonly message?: string;
}

async function fetchOpenCodeServerStatus(): Promise<OpenCodeServerStatusResponse> {
  const origin = resolveWsHttpOrigin();
  const resp = await fetch(`${origin}/api/opencode/server`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) throw new Error(`Server status fetch failed (${resp.status})`);
  return (await resp.json()) as OpenCodeServerStatusResponse;
}

async function startOpenCodeServer(origin: string): Promise<OpenCodeServerStatusResponse> {
  const resp = await fetch(`${origin}/api/opencode/server/start`, {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Start failed (${resp.status})`);
  }
  return (await resp.json()) as OpenCodeServerStatusResponse;
}

async function stopOpenCodeServer(origin: string): Promise<OpenCodeServerStatusResponse> {
  const resp = await fetch(`${origin}/api/opencode/server/stop`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Stop failed (${resp.status})`);
  }
  return (await resp.json()) as OpenCodeServerStatusResponse;
}

function OpenCodeServerStatusPanel() {
  const origin = resolveWsHttpOrigin();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["opencode", "server-status"],
    queryFn: fetchOpenCodeServerStatus,
    refetchInterval: 5_000,
    retry: 1,
  });

  const status = statusQuery.data;

  const handleStart = async () => {
    setActionError(null);
    setIsActing(true);
    try {
      await startOpenCodeServer(origin);
      await statusQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start server.");
    } finally {
      setIsActing(false);
    }
  };

  const handleStop = async () => {
    setActionError(null);
    setIsActing(true);
    try {
      await stopOpenCodeServer(origin);
      await statusQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to stop server.");
    } finally {
      setIsActing(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">Server status</p>
          {status?.state === "running" ? (
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
              {status.url ?? "running"}
            </p>
          ) : status?.state === "error" ? (
            <p className="mt-0.5 text-[11px] text-destructive">{status.message}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Status badge */}
          {statusQuery.isLoading ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Checking...
            </span>
          ) : status?.state === "running" ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              Running
            </span>
          ) : status?.state === "starting" ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              Starting...
            </span>
          ) : status?.state === "error" ? (
            <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
              Error
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Stopped
            </span>
          )}

          {/* Action buttons */}
          {status?.state !== "running" && status?.state !== "starting" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isActing}
              onClick={() => void handleStart()}
            >
              {isActing ? "Starting..." : "Start"}
            </Button>
          ) : null}
          {status?.state === "running" && status.managedByT3 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isActing}
              onClick={() => void handleStop()}
            >
              {isActing ? "Stopping..." : "Stop"}
            </Button>
          ) : null}
        </div>
      </div>

      {actionError ? <p className="mt-2 text-xs text-destructive">{actionError}</p> : null}
    </div>
  );
}
```

### 4d. Hide search input in `OpenCodeModelPicker` during loading/error states

**Find** (inside `OpenCodeModelPicker`, the search Input block):

```tsx
      <div className="space-y-4">
        {/* Search */}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search models..."
          spellCheck={false}
        />
```

**Replace with:**

```tsx
      <div className="space-y-4">
        {/* Search — only shown when data is available */}
        {hasData && !isLoading ? (
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            spellCheck={false}
          />
        ) : null}
```

---

## Summary of changes

| File                        | Change                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `OpenCodeProcessManager.ts` | Fix password propagation; add `openCodeServerControl` singleton + types                    |
| `opencode/index.ts`         | Export new singleton + types                                                               |
| `wsServer.ts`               | Use `openCodeServerControl.getCredentials()`; add 3 server control routes                  |
| `_chat.settings.tsx`        | Remove dead opencode entry; add `OpenCodeServerStatusPanel`; hide search during load/error |

After applying all changes, run:

```
bun fmt && bun lint && bun typecheck
```
