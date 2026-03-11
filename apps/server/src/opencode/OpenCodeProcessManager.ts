/**
 * OpenCodeProcessManager - Manages the background `opencode serve` process.
 *
 * Spawns and monitors the OpenCode HTTP server as a child process, with support
 * for attaching to an existing server, health-check polling, and graceful
 * shutdown. Generates a random password for server auth when none is configured.
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
