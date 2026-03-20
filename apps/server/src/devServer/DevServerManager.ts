import { EventEmitter } from "node:events";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { type Dirent, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  DevServerErrorCode,
  DevServerInfo,
  DevServerStatus,
  ProjectId,
} from "@t3tools/contracts";
import { createLogger } from "../logger.ts";

const logger = createLogger("dev-server");

// ── Constants ────────────────────────────────────────────────────────

const MAX_LOG_LINES = 500;
const FORCE_KILL_DELAY_MS = 3_000;
const RESTART_SETTLE_DELAY_MS = 300;
const PREFLIGHT_SETTLE_DELAY_MS = 250;
const MAX_NEXT_LOCK_SEARCH_DEPTH = 4;
const SKIPPED_SCAN_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "node_modules",
]);

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
  process: ChildProcess | null;
  status: DevServerStatus;
  packageManager: string;
  cwd: string;
  url?: string;
  pid?: number;
  logs: string[];
  error?: string;
  errorCode?: DevServerErrorCode;
  recoveryHint?: string;
  conflictingPid?: number;
  conflictingPort?: number;
  conflictingPath?: string;
}

interface DevServerFailureContext {
  error: string;
  errorCode?: DevServerErrorCode;
  recoveryHint?: string;
  conflictingPid?: number;
  conflictingPort?: number;
  conflictingPath?: string;
}

interface LockConflict {
  lockPath: string;
  pids: number[];
}

/**
 * A batch of log lines emitted from a single stdio `data` event.
 * Grouping lines per chunk reduces the number of Effect.runPromise / Queue.offer
 * calls on the server side, and lets the client apply a whole chunk in one
 * Zustand update (one React render) instead of one render per line.
 */
export interface DevServerLogLinesBatch {
  readonly projectId: ProjectId;
  readonly lines: ReadonlyArray<{
    readonly line: string;
    readonly stream: "stdout" | "stderr";
  }>;
}

interface DevServerManagerEvents {
  statusChanged: [DevServerInfo];
  logLines: [DevServerLogLinesBatch];
}

// ── DevServerManager ─────────────────────────────────────────────────

interface PidRow {
  project_id: string;
  pid: number;
  pgid: number | null;
}

interface DbStmts {
  insert: StatementSync;
  deletePid: StatementSync;
  deleteAll: StatementSync;
  getAll: StatementSync;
}

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

  /** Prepared statements for PID persistence — undefined until initialize() is called. */
  private dbStmts: DbStmts | undefined;

  constructor() {
    super();
    // Kill all child process trees synchronously when Node.js is about to exit.
    // This covers: Ctrl+C (SIGINT handled by the Effect runtime → process.exit()),
    // SIGTERM from Electron when closing the app, and normal process exits.
    // NOTE: SIGKILL cannot be caught — child processes are cleaned up by the OS anyway.
    // We intentionally do NOT clear dev_server_pids here so that orphan cleanup
    // can run on the next startup.
    process.on("exit", () => {
      this._killAllSync();
    });
  }

  /**
   * Two-phase init: connect to the SQLite database for PID persistence and kill
   * any orphaned dev server processes left over from a previous crashed session.
   *
   * Must be called after database migrations have run so the dev_server_pids
   * table is guaranteed to exist.
   */
  initialize(dbPath: string): void {
    try {
      const db = new DatabaseSync(dbPath);
      this.dbStmts = {
        insert: db.prepare(
          `INSERT OR REPLACE INTO dev_server_pids (project_id, pid, pgid, cwd, started_at)
           VALUES (?, ?, ?, ?, ?)`,
        ),
        deletePid: db.prepare(`DELETE FROM dev_server_pids WHERE project_id = ?`),
        deleteAll: db.prepare(`DELETE FROM dev_server_pids`),
        getAll: db.prepare(`SELECT project_id, pid, pgid FROM dev_server_pids`),
      };
      this._killOrphans();
    } catch (err) {
      logger.error("Failed to initialize dev server PID persistence", { error: String(err) });
    }
  }

  /**
   * Kill any dev server processes recorded in the DB from a previous session,
   * then clear the table. Safe to call even if all processes are already dead.
   */
  private _killOrphans(): void {
    if (!this.dbStmts) return;
    const rows = this.dbStmts.getAll.all() as unknown as PidRow[];
    let killedCount = 0;
    for (const { project_id, pid, pgid } of rows) {
      try {
        process.kill(pid, 0); // throws ESRCH if the process is dead
        // Process is still alive — kill the whole group if possible
        const target = pgid != null && process.platform !== "win32" ? -pgid : pid;
        try {
          process.kill(target, "SIGKILL");
          killedCount++;
        } catch {
          // Group kill failed, try the PID directly
          try {
            process.kill(pid, "SIGKILL");
            killedCount++;
          } catch {
            /* already dead */
          }
        }
        logger.info("Killed orphaned dev server from previous session", { project_id, pid });
      } catch {
        // Process is not alive — nothing to do
      }
    }
    this.dbStmts.deleteAll.run();
    if (killedCount > 0) {
      logger.info(`Cleaned up ${killedCount} orphaned dev server(s) from previous session`);
    }
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

      await this.runStartPreflight(projectId, cwd);

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

  async restart(projectId: ProjectId, cwd: string): Promise<DevServerInfo> {
    logger.info("DevServer hard restart requested", { projectId, cwd });

    const existing = this.sessions.get(projectId);
    const previousProcess = existing?.process;

    if (existing) {
      this.stop(projectId);
      await waitForProcessExit(previousProcess, FORCE_KILL_DELAY_MS + 500);
    }

    await sleep(RESTART_SETTLE_DELAY_MS);
    return this.start(projectId, cwd);
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
    // Eagerly clear all DB entries on user-initiated stop-all so orphan cleanup
    // on next startup doesn't try to kill already-stopped processes.
    this.dbStmts?.deleteAll.run();
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

  private async runStartPreflight(projectId: ProjectId, cwd: string): Promise<void> {
    const killedPids = new Set<number>();

    const lockConflicts = await listNextLockConflicts(cwd);
    for (const conflict of lockConflicts) {
      if (conflict.pids.length === 0) {
        continue;
      }

      const justKilled = killPids(conflict.pids);
      for (const pid of justKilled) {
        killedPids.add(pid);
      }

      if (justKilled.length > 0) {
        logger.warn("Killed stale Next lock owners before dev server start", {
          projectId,
          cwd,
          lockPath: conflict.lockPath,
          pids: justKilled,
        });
      }
    }

    if (killedPids.size > 0) {
      await sleep(PREFLIGHT_SETTLE_DELAY_MS);
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
      env: buildDevServerEnv(),
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

    // Persist PID so orphan cleanup runs if the server crashes before stop() is called.
    // pgid equals child.pid for detached Unix processes (they become their own process group).
    if (child.pid !== undefined && this.dbStmts) {
      const pgid = process.platform !== "win32" ? child.pid : null;
      this.dbStmts.insert.run(projectId, child.pid, pgid, cwd, new Date().toISOString());
    }

    const info = this.toInfo(projectId, session);
    this.emit("statusChanged", info);

    // Fallback: transition from starting → running after 5s even without URL detection
    const startingFallbackTimer = setTimeout(() => {
      if (session.status === "starting") {
        this.updateStatus(projectId, session, "running");
      }
    }, 5_000);

    const markProcessError = (context: DevServerFailureContext) => {
      clearTimeout(startingFallbackTimer);
      applyFailureContext(session, context);
      if (session.status !== "error") {
        this.updateStatus(projectId, session, "error");
      }
    };

    const handleOutput = (data: Buffer, stream: "stdout" | "stderr") => {
      const text = data.toString();
      const rawLines = text.split("\n").filter((l) => l.length > 0);

      // Collect every line that will be broadcast so we can emit them as a
      // single batch — one Effect.runPromise / Queue.offer on the server and
      // one Zustand set() / React render on the client instead of N each.
      const batchLines: Array<{ line: string; stream: "stdout" | "stderr" }> = [];

      for (const line of rawLines) {
        // Append to rolling log buffer
        session.logs.push(line);
        if (session.logs.length > MAX_LOG_LINES) {
          session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
        }

        batchLines.push({ line, stream });

        const failureContext = buildFailureContextFromLine(line);
        if (failureContext) {
          markProcessError(failureContext);
          continue;
        }

        // Try to detect server URL from stdout
        if (stream === "stdout" && session.status === "starting" && !session.url) {
          const url = parseUrlFromLine(line);
          if (url) {
            session.url = url;
            this.updateStatus(projectId, session, "running");
          }
        }
      }

      // Emit the whole chunk as a single batch event.
      if (batchLines.length > 0) {
        this.emit("logLines", { projectId, lines: batchLines });
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => handleOutput(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => handleOutput(chunk, "stderr"));

    child.once("error", (err) => {
      logger.error("Dev server process error", { projectId, error: err.message });
      markProcessError({ error: err.message, errorCode: "spawn-failed" });
    });

    child.once("close", async (code, signal) => {
      clearTimeout(startingFallbackTimer);
      // Process is definitively dead — remove from PID persistence
      this.dbStmts?.deletePid.run(projectId);
      logger.info("Dev server process closed", { projectId, code, signal, status: session.status });
      if (session.status !== "stopped" && session.status !== "error") {
        // Unexpected exit
        const reason = code !== null ? `exited with code ${code}` : `killed by signal ${signal}`;
        const derivedFailure = await buildFailureContextFromCwd(session.cwd);
        markProcessError(
          derivedFailure ?? {
            error: `Dev server ${reason}`,
            errorCode: "process-exited",
          },
        );
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
      errorCode: "missing-dev-script",
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
      ...(session.errorCode !== undefined && { errorCode: session.errorCode }),
      ...(session.recoveryHint !== undefined && { recoveryHint: session.recoveryHint }),
      ...(session.conflictingPid !== undefined && { conflictingPid: session.conflictingPid }),
      ...(session.conflictingPort !== undefined && { conflictingPort: session.conflictingPort }),
      ...(session.conflictingPath !== undefined && { conflictingPath: session.conflictingPath }),
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

function waitForProcessExit(
  child: ChildProcess | null | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!child || child.killed || child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDevServerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete env.PORT;
  delete env.APP_VERSION;
  delete env.VITE_WS_URL;

  for (const key of Object.keys(env)) {
    if (key.startsWith("T3CODE_")) {
      delete env[key];
    }
  }

  return env;
}

function applyFailureContext(session: DevServerSession, context: DevServerFailureContext): void {
  session.error = context.error;
  if (context.errorCode !== undefined) {
    session.errorCode = context.errorCode;
  } else {
    delete session.errorCode;
  }
  if (context.recoveryHint !== undefined) {
    session.recoveryHint = context.recoveryHint;
  } else {
    delete session.recoveryHint;
  }
  if (context.conflictingPid !== undefined) {
    session.conflictingPid = context.conflictingPid;
  } else {
    delete session.conflictingPid;
  }
  if (context.conflictingPort !== undefined) {
    session.conflictingPort = context.conflictingPort;
  } else {
    delete session.conflictingPort;
  }
  if (context.conflictingPath !== undefined) {
    session.conflictingPath = context.conflictingPath;
  } else {
    delete session.conflictingPath;
  }
}

function buildFailureContextFromLine(line: string): DevServerFailureContext | null {
  const portConflict = parsePortConflictFromLine(line);
  if (portConflict !== null) {
    return {
      error: `Port ${portConflict} is already in use.`,
      errorCode: "port-in-use",
      recoveryHint: "Stop the other process or configure this project to use a different port.",
      conflictingPort: portConflict,
    };
  }

  const lockPrefix = "Unable to acquire lock at ";
  const lockIndex = line.toLowerCase().indexOf(lockPrefix.toLowerCase());
  if (lockIndex === -1) {
    return null;
  }

  const lockPath = line
    .slice(lockIndex + lockPrefix.length)
    .trim()
    .replace(/\.$/, "");
  if (!lockPath) {
    return {
      error: "Unable to acquire the Next dev lock.",
      errorCode: "lock-held",
      recoveryHint: "Use Retry dev to clean the stale lock owner and start again.",
    };
  }

  const ownerPid = listPathOwners(lockPath)[0];
  return {
    error:
      ownerPid !== undefined
        ? `Next dev lock is held by PID ${ownerPid}.`
        : "Unable to acquire the Next dev lock.",
    errorCode: "lock-held",
    recoveryHint: "Use Retry dev to clean the stale lock owner and start again.",
    ...(ownerPid !== undefined ? { conflictingPid: ownerPid } : {}),
    conflictingPath: lockPath,
  };
}

function parsePortConflictFromLine(line: string): number | null {
  const match =
    line.match(/EADDRINUSE:.*?(?::|\s)(\d{2,5})\s*$/i) ?? line.match(/\bport:\s*(\d{2,5})\b/i);
  if (!match) {
    return null;
  }

  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function buildFailureContextFromCwd(cwd: string): Promise<DevServerFailureContext | null> {
  const lockConflicts = await listNextLockConflicts(cwd);
  const firstConflict = lockConflicts.find((conflict) => conflict.pids.length > 0);
  if (!firstConflict) {
    return null;
  }

  const ownerPid = firstConflict.pids[0];
  return {
    error:
      ownerPid !== undefined
        ? `Next dev lock is held by PID ${ownerPid}.`
        : "Unable to acquire the Next dev lock.",
    errorCode: "lock-held",
    recoveryHint: "Use Retry dev to clean the stale lock owner and start again.",
    ...(ownerPid !== undefined ? { conflictingPid: ownerPid } : {}),
    conflictingPath: firstConflict.lockPath,
  };
}

async function listNextLockConflicts(cwd: string): Promise<LockConflict[]> {
  const lockPaths = await findNextLockPaths(cwd);
  return lockPaths.map((lockPath) => ({
    lockPath,
    pids: listPathOwners(lockPath),
  }));
}

async function findNextLockPaths(root: string): Promise<string[]> {
  const results = new Set<string>();

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_NEXT_LOCK_SEARCH_DEPTH) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (SKIPPED_SCAN_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const entryPath = join(dir, entry.name);
      if (entry.name === ".next") {
        const lockPath = join(entryPath, "dev", "lock");
        if (existsSync(lockPath)) {
          results.add(lockPath);
        }
        continue;
      }

      await visit(entryPath, depth + 1);
    }
  };

  await visit(root, 0);
  return [...results];
}

function listPathOwners(filePath: string): number[] {
  try {
    if (process.platform === "win32") {
      return [];
    }

    const result = spawnSync("lsof", ["-t", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output = typeof result.stdout === "string" ? result.stdout : "";
    return output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function killPids(pids: Iterable<number>): number[] {
  const killed: number[] = [];
  for (const pid of new Set(pids)) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }

    if (killPidTree(pid, "SIGKILL")) {
      killed.push(pid);
    }
  }
  return killed;
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
function killProcessTree(child: ChildProcess | null | undefined, signal: NodeJS.Signals): void {
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

function killPidTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return true;
    }

    const descendants = listChildPids(pid);
    for (const childPid of descendants) {
      process.kill(childPid, signal);
    }

    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function listChildPids(pid: number): number[] {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const result = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output = typeof result.stdout === "string" ? result.stdout : "";
    const directChildren = output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((childPid) => Number.isInteger(childPid) && childPid > 0);
    const descendants: number[] = [];
    for (const childPid of directChildren) {
      descendants.push(...listChildPids(childPid), childPid);
    }
    return descendants;
  } catch {
    return [];
  }
}

function killProcess(child: ChildProcess | null | undefined): void {
  if (!child) {
    return;
  }

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
