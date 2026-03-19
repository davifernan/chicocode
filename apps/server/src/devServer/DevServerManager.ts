import { EventEmitter } from "node:events";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DevServerInfo,
  DevServerLogLinePayload,
  DevServerStatus,
  ProjectId,
} from "@t3tools/contracts";
import { createLogger } from "../logger.ts";

const logger = createLogger("dev-server");

// ── Constants ────────────────────────────────────────────────────────

const MAX_LOG_LINES = 500;
const FORCE_KILL_DELAY_MS = 3_000;

// Common URL patterns emitted by dev servers
const URL_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/,
  /Local:\s+(https?:\/\/[^\s]+)/,
  /➜\s+Local:\s+(https?:\/\/[^\s]+)/,
  /ready\s+on\s+(https?:\/\/[^\s]+)/i,
  /listening\s+on\s+(https?:\/\/[^\s]+)/i,
  /started\s+on\s+(https?:\/\/[^\s]+)/i,
  /running\s+at\s+(https?:\/\/[^\s]+)/i,
];

// ── Types ────────────────────────────────────────────────────────────

interface DevServerSession {
  process: ChildProcess;
  status: DevServerStatus;
  packageManager: string;
  cwd: string;
  url?: string;
  pid?: number;
  logs: string[];
  error?: string;
}

interface DevServerManagerEvents {
  statusChanged: [DevServerInfo];
  logLine: [DevServerLogLinePayload];
}

// ── DevServerManager ─────────────────────────────────────────────────

export class DevServerManager extends EventEmitter<DevServerManagerEvents> {
  private readonly sessions = new Map<string, DevServerSession>();

  /**
   * Tracks projects that have an in-flight `start()` call.
   * Populated synchronously before the first `await` so that concurrent calls
   * for the same project see it immediately and bail out — preventing the race
   * condition where multiple callers all pass the "already running?" check before
   * any of them completes the async detection + spawn sequence.
   */
  private readonly pendingStarts = new Set<string>();

  constructor() {
    super();
    // Kill all child process trees synchronously when Node.js is about to exit.
    // This covers: Ctrl+C (SIGINT handled by the Effect runtime → process.exit()),
    // SIGTERM from Electron when closing the app, and normal process exits.
    // NOTE: SIGKILL cannot be caught — child processes are cleaned up by the OS anyway.
    process.on("exit", () => {
      this._killAllSync();
    });
  }

  // ── Public API ─────────────────────────────────────────────────────

  async start(projectId: ProjectId, cwd: string): Promise<DevServerInfo> {
    logger.info("DevServer start requested", { projectId, cwd });

    // Guard 1: already have an active session
    const existing = this.sessions.get(projectId);
    if (existing && (existing.status === "starting" || existing.status === "running")) {
      logger.info("DevServer already running", { projectId, status: existing.status });
      return this.toInfo(projectId, existing);
    }

    // Guard 2: another concurrent start() call is already in-flight for this project.
    // This set is mutated synchronously below — before the first await — so all
    // concurrent calls see it immediately.
    if (this.pendingStarts.has(projectId)) {
      logger.info("DevServer start already in progress, ignoring duplicate", { projectId });
      return this.getStatus(projectId);
    }
    this.pendingStarts.add(projectId);

    try {
      // Detect package manager and validate dev script exists
      const packageManager = await detectPackageManager(cwd);
      logger.info("Detected package manager", { projectId, cwd, packageManager });

      const hasDevScript = await checkDevScriptExists(cwd);
      if (!hasDevScript) {
        logger.warn("No dev script found", { projectId, cwd });
        return this.setError(
          projectId,
          cwd,
          packageManager,
          'No "dev" script found in package.json',
        );
      }

      // Guard 3: re-check after async gap in case another call completed while we awaited
      const existingAfterWait = this.sessions.get(projectId);
      if (
        existingAfterWait &&
        (existingAfterWait.status === "starting" || existingAfterWait.status === "running")
      ) {
        logger.info("DevServer started by concurrent call during detection", { projectId });
        return this.toInfo(projectId, existingAfterWait);
      }

      logger.info("Spawning dev server", { projectId, cwd, packageManager });
      return this.spawnDevServer(projectId, cwd, packageManager);
    } finally {
      this.pendingStarts.delete(projectId);
    }
  }

  stop(projectId: ProjectId): void {
    const session = this.sessions.get(projectId);
    if (!session) return;
    if (session.status === "stopped" || session.status === "idle") return;

    this.updateStatus(projectId, session, "stopped");
    killProcess(session.process);
  }

  getStatus(projectId: ProjectId): DevServerInfo {
    const session = this.sessions.get(projectId);
    if (!session) {
      return { projectId, status: "idle" };
    }
    return this.toInfo(projectId, session);
  }

  getAllStatuses(): DevServerInfo[] {
    const results: DevServerInfo[] = [];
    for (const [projectId, session] of this.sessions) {
      results.push(this.toInfo(projectId as ProjectId, session));
    }
    return results;
  }

  getLogs(projectId: ProjectId, limit?: number): string[] {
    const session = this.sessions.get(projectId);
    if (!session) return [];
    const logs = session.logs;
    if (limit !== undefined && limit > 0) {
      return logs.slice(-limit);
    }
    return [...logs];
  }

  /**
   * Gracefully stop all running dev servers.
   * Emits status events so connected clients see the updated state.
   * Use this for intentional shutdown (e.g. server restart).
   */
  stopAll(): void {
    for (const [projectId, session] of this.sessions) {
      if (session.status === "starting" || session.status === "running") {
        logger.info("Stopping dev server (stopAll)", { projectId });
        this.stop(projectId as ProjectId);
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Synchronously kill all child process trees without emitting events.
   * Called from the process 'exit' handler where async work is not allowed.
   */
  private _killAllSync(): void {
    for (const session of this.sessions.values()) {
      const child = session.process;
      if (!child) continue;
      try {
        if (!child.killed && child.exitCode === null) {
          killProcessTree(child, "SIGTERM");
        }
      } catch {
        // Ignore errors during process exit — the OS will clean up anyway
      }
    }
  }

  private spawnDevServer(projectId: ProjectId, cwd: string, packageManager: string): DevServerInfo {
    const { command, args } = buildDevCommand(packageManager);

    const child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      shell: process.platform === "win32",
      // On Unix: start the child in its own process group (pgid = child.pid).
      // This lets us send SIGTERM to the *entire* tree (turbo + next dev + tsc watchers)
      // via process.kill(-child.pid, signal), rather than only the direct child.
      // On Windows: taskkill /T already handles the whole tree — detached not needed.
      detached: process.platform !== "win32",
      env: { ...process.env },
    });

    const session: DevServerSession = {
      process: child,
      status: "starting",
      packageManager,
      cwd,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      logs: [],
    };
    this.sessions.set(projectId, session);

    const info = this.toInfo(projectId, session);
    this.emit("statusChanged", info);

    const handleOutput = (data: Buffer, stream: "stdout" | "stderr") => {
      const text = data.toString();
      const lines = text.split("\n").filter((l) => l.length > 0);

      for (const line of lines) {
        // Append to rolling log buffer
        session.logs.push(line);
        if (session.logs.length > MAX_LOG_LINES) {
          session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
        }

        // Emit log line push event
        this.emit("logLine", { projectId, line, stream });

        // Try to detect server URL from stdout
        if (stream === "stdout" && session.status === "starting" && !session.url) {
          const url = parseUrlFromLine(line);
          if (url) {
            session.url = url;
            this.updateStatus(projectId, session, "running");
          }
        }
      }

      // If we haven't detected a URL but a few seconds have passed, assume running
      // (handled by the "starting → running" fallback timeout below)
    };

    child.stdout?.on("data", (chunk: Buffer) => handleOutput(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => handleOutput(chunk, "stderr"));

    // Fallback: transition from starting → running after 5s even without URL detection
    const startingFallbackTimer = setTimeout(() => {
      if (session.status === "starting") {
        this.updateStatus(projectId, session, "running");
      }
    }, 5_000);

    child.once("error", (err) => {
      clearTimeout(startingFallbackTimer);
      logger.error("Dev server process error", { projectId, error: err.message });
      session.error = err.message;
      this.updateStatus(projectId, session, "error");
    });

    child.once("close", (code, signal) => {
      clearTimeout(startingFallbackTimer);
      logger.info("Dev server process closed", { projectId, code, signal, status: session.status });
      if (session.status !== "stopped") {
        // Unexpected exit
        const reason = code !== null ? `exited with code ${code}` : `killed by signal ${signal}`;
        session.error = `Dev server ${reason}`;
        this.updateStatus(projectId, session, "error");
      }
    });

    return info;
  }

  private updateStatus(
    projectId: ProjectId,
    session: DevServerSession,
    status: DevServerStatus,
  ): void {
    logger.info("Dev server status changed", { projectId, status, url: session.url });
    session.status = status;
    const info = this.toInfo(projectId, session);
    this.emit("statusChanged", info);
  }

  private setError(
    projectId: ProjectId,
    cwd: string,
    packageManager: string,
    error: string,
  ): DevServerInfo {
    const session: DevServerSession = {
      process: null as unknown as ChildProcess, // no process for error state
      status: "error",
      packageManager,
      cwd,
      logs: [],
      error,
    };
    this.sessions.set(projectId, session);
    const info = this.toInfo(projectId, session);
    this.emit("statusChanged", info);
    return info;
  }

  private toInfo(projectId: string, session: DevServerSession): DevServerInfo {
    // Avoid undefined values in optional fields — exactOptionalPropertyTypes requires
    // optional properties to be absent entirely, not present with undefined value.
    return {
      projectId: projectId as ProjectId,
      status: session.status,
      ...(session.packageManager !== undefined && { packageManager: session.packageManager }),
      ...(session.url !== undefined && { url: session.url }),
      ...(session.pid !== undefined && { pid: session.pid }),
      ...(session.error !== undefined && { error: session.error }),
    };
  }
}

// ── Package Manager Detection ────────────────────────────────────────

async function detectPackageManager(cwd: string): Promise<string> {
  // Check lockfiles in priority order
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(cwd, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(cwd, "package-lock.json"))) {
    return "npm";
  }

  // Fallback: read package.json#packageManager field
  try {
    const pkgPath = join(cwd, "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { packageManager?: string };
    if (typeof pkg.packageManager === "string") {
      const pm = pkg.packageManager.split("@")[0]?.trim().toLowerCase();
      if (pm === "bun" || pm === "yarn" || pm === "pnpm" || pm === "npm") {
        return pm;
      }
    }
  } catch {
    // ignore
  }

  return "npm";
}

async function checkDevScriptExists(cwd: string): Promise<boolean> {
  try {
    const pkgPath = join(cwd, "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.dev === "string";
  } catch {
    return false;
  }
}

function buildDevCommand(packageManager: string): { command: string; args: string[] } {
  switch (packageManager) {
    case "bun":
      return { command: "bun", args: ["run", "dev"] };
    case "yarn":
      return { command: "yarn", args: ["dev"] };
    case "pnpm":
      return { command: "pnpm", args: ["run", "dev"] };
    default:
      return { command: "npm", args: ["run", "dev"] };
  }
}

// ── URL Detection ─────────────────────────────────────────────────────

function parseUrlFromLine(line: string): string | null {
  for (const pattern of URL_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      // If the pattern has a capture group, use it; otherwise use the full match
      const url = match[1] ?? match[0];
      // Normalize: strip trailing slashes and whitespace
      return url.trim().replace(/\/$/, "");
    }
  }
  return null;
}

// ── Process Kill Utilities ────────────────────────────────────────────

/**
 * Send `signal` to the child's **entire process tree**.
 *
 * On Unix the child is spawned with `detached: true` which puts it in its own
 * process group (pgid = child.pid). `process.kill(-child.pid, signal)` delivers
 * the signal to every process in that group — turbo, next dev, tsc watchers, etc.
 *
 * On Windows we use `taskkill /T` which recursively terminates the whole tree.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child || child.killed || child.exitCode !== null) return;

  if (process.platform === "win32") {
    if (child.pid !== undefined) {
      try {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        return;
      } catch {
        // fallback to direct kill below
      }
    }
    child.kill(signal);
    return;
  }

  // Unix: kill the process group
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Process group may already be gone; fall back to direct kill
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
  } else {
    child.kill(signal);
  }
}

function killProcess(child: ChildProcess): void {
  killProcessTree(child, "SIGTERM");

  // Force-kill the whole tree after timeout if still running
  const forceKillTimer = setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      killProcessTree(child, "SIGKILL");
    }
  }, FORCE_KILL_DELAY_MS);

  child.once("close", () => {
    clearTimeout(forceKillTimer);
  });
}

// ── Singleton ─────────────────────────────────────────────────────────

export const devServerManager = new DevServerManager();
