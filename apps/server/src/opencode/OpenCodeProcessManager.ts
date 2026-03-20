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

import { type ChildProcess, execSync, spawn } from "node:child_process";
import crypto from "node:crypto";

import { OpenCodeClient, type OpenCodeHealthResponse } from "./OpenCodeClient.ts";

const DEFAULT_PORT = 4096;
const DEFAULT_HOSTNAME = "127.0.0.1";
const HEALTH_POLL_INTERVAL_MS = 2_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/**
 * Try to extract `OPENCODE_SERVER_PASSWORD` from a running `opencode` process
 * by inspecting its environment via `ps eww`.
 *
 * macOS-specific: relies on `ps eww` exposing the full environment block.
 * Returns `undefined` if the password cannot be extracted.
 */
function tryExtractPasswordFromProcess(port: number): string | undefined {
  try {
    // Find the PID of the opencode process listening on the given port.
    const lsofOut = execSync(`lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`, {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const pid = lsofOut.split("\n")[0]?.trim();
    if (!pid || !/^\d+$/.test(pid)) return undefined;

    // Read the process environment on macOS.
    const psOut = execSync(`ps eww -o command -p ${pid} 2>/dev/null`, {
      encoding: "utf8",
      timeout: 5_000,
    });
    const match = psOut.match(/OPENCODE_SERVER_PASSWORD=(\S+)/);
    return match?.[1] ?? undefined;
  } catch {
    return undefined;
  }
}

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
  async start(opts?: { port?: number; binaryPath?: string }): Promise<void> {
    if (this.process) {
      throw new Error("OpenCode process is already running");
    }

    this._port = opts?.port ?? DEFAULT_PORT;
    this._password =
      process.env.OPENCODE_SERVER_PASSWORD ?? crypto.randomBytes(24).toString("base64url");
    this._username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";

    // Write the generated credentials back to the parent process environment
    // so HTTP proxy routes (which read process.env directly) can authenticate
    // against the child OpenCode server.
    process.env.OPENCODE_SERVER_PASSWORD = this._password;
    process.env.OPENCODE_SERVER_USERNAME = this._username;

    const binary = opts?.binaryPath || "opencode";
    const args = ["serve", "--port", String(this._port), "--hostname", this._hostname];

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: this._password,
    };

    this.process = spawn(binary, args, {
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
    let username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    let password = process.env.OPENCODE_SERVER_PASSWORD ?? "";

    let client = new OpenCodeClient(url, username, password);
    let health: OpenCodeHealthResponse;
    try {
      health = await client.health();
    } catch {
      return false;
    }

    if (!health.healthy) {
      // The server might be running but our credentials are wrong (401).
      // Try to extract the password from the running process's environment.
      let parsedPort = DEFAULT_PORT;
      try {
        parsedPort = new URL(url).port ? Number(new URL(url).port) : DEFAULT_PORT;
      } catch {
        return false;
      }

      const extractedPassword = tryExtractPasswordFromProcess(parsedPort);
      if (!extractedPassword) return false;

      // Retry with extracted credentials.
      username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
      password = extractedPassword;
      client = new OpenCodeClient(url, username, password);
      try {
        health = await client.health();
      } catch {
        return false;
      }
      if (!health.healthy) return false;

      // Persist extracted credentials so other code paths can use them.
      process.env.OPENCODE_SERVER_PASSWORD = password;
      process.env.OPENCODE_SERVER_USERNAME = username;
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

  async isHealthy(): Promise<boolean> {
    try {
      const health = await this.createClient().health();
      return health.healthy;
    } catch {
      return false;
    }
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
  private _startPromise: Promise<void> | null = null;

  /** Current server status. */
  getStatus(): OpenCodeServerStatus {
    return this._status;
  }

  async refreshStatus(opts?: { serverUrl?: string }): Promise<OpenCodeServerStatus> {
    const desiredUrl = opts?.serverUrl?.replace(/\/+$/, "");

    if (desiredUrl && (!this._manager || this._manager.baseUrl !== desiredUrl)) {
      const manager = new OpenCodeProcessManager();
      const attached = await manager.attach(desiredUrl);
      if (attached) {
        this._manager = manager;
        this._managedByT3 = false;
        this._status = {
          state: "running",
          url: manager.baseUrl,
          managedByT3: false,
        };
        return this._status;
      }

      if (!this._managedByT3) {
        this._manager = null;
        this._managedByT3 = false;
        this._status = { state: "stopped" };
        return this._status;
      }
    }

    if (!this._manager) {
      const manager = new OpenCodeProcessManager();
      const url =
        opts?.serverUrl ??
        process.env.OPENCODE_SERVER_URL ??
        `http://${DEFAULT_HOSTNAME}:${DEFAULT_PORT}`;
      const attached = await manager.attach(url);
      if (!attached) {
        this._status = { state: "stopped" };
        return this._status;
      }

      this._manager = manager;
      this._managedByT3 = false;
      this._status = {
        state: "running",
        url: manager.baseUrl,
        managedByT3: false,
      };
      return this._status;
    }

    if (this._managedByT3 && !this._manager.isRunning()) {
      this._manager = null;
      this._managedByT3 = false;
      this._status = { state: "stopped" };
      return this._status;
    }

    const healthy = await this._manager.isHealthy();
    if (healthy) {
      this._status = {
        state: "running",
        url: this._manager.baseUrl,
        managedByT3: this._managedByT3,
      };
      return this._status;
    }

    if (this._managedByT3 && this._manager.isRunning()) {
      this._status = {
        state: "error",
        message: `OpenCode server at ${this._manager.baseUrl} is not responding to health checks.`,
      };
      return this._status;
    }

    this._manager = null;
    this._managedByT3 = false;
    this._status = { state: "stopped" };
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
  async start(opts?: { port?: number; serverUrl?: string; binaryPath?: string }): Promise<void> {
    while (this._startPromise) {
      await this._startPromise;
      const status = await this.refreshStatus(
        opts?.serverUrl ? { serverUrl: opts.serverUrl } : undefined,
      );
      if (status.state === "running") {
        return;
      }
      if (status.state === "error") {
        throw new Error(status.message);
      }
    }

    const startPromise = this.startInternal(opts);
    const trackedPromise = startPromise.finally(() => {
      if (this._startPromise === trackedPromise) {
        this._startPromise = null;
      }
    });
    this._startPromise = trackedPromise;
    await trackedPromise;
  }

  private async startInternal(opts?: {
    port?: number;
    serverUrl?: string;
    binaryPath?: string;
  }): Promise<void> {
    const currentStatus = await this.refreshStatus(
      opts?.serverUrl ? { serverUrl: opts.serverUrl } : undefined,
    );
    if (currentStatus.state === "running") {
      return;
    }

    if (currentStatus.state === "error") {
      throw new Error(currentStatus.message);
    }

    this._status = { state: "starting" };
    const manager = new OpenCodeProcessManager();

    const existingUrl =
      opts?.serverUrl ??
      process.env.OPENCODE_SERVER_URL ??
      `http://${DEFAULT_HOSTNAME}:${opts?.port ?? DEFAULT_PORT}`;
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

    try {
      await manager.start({
        ...(opts?.port !== undefined ? { port: opts.port } : {}),
        ...(opts?.binaryPath ? { binaryPath: opts.binaryPath } : {}),
      });
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
