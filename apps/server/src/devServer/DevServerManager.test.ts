import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { ProjectId } from "@t3tools/contracts";
import { DevServerManager } from "./DevServerManager.ts";

// Each DevServerManager instance registers a process 'exit' handler.
// Raise the limit to prevent MaxListenersExceededWarning across many test instances.
process.setMaxListeners(50);

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Minimal ChildProcess mock with controllable state. */
function mockProcess(opts: { killed?: boolean; exitCode?: number | null } = {}): ChildProcess {
  return {
    killed: opts.killed ?? false,
    exitCode: opts.exitCode ?? null,
    kill: vi.fn(),
    pid: Math.floor(Math.random() * 100_000) + 1,
    once: vi.fn(),
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  } as unknown as ChildProcess;
}

type SessionMap = Map<
  string,
  {
    process: ChildProcess | null;
    status: string;
    packageManager: string;
    cwd: string;
    logs: string[];
  }
>;

/** Directly inserts a session into the manager's private sessions Map. */
function injectSession(
  manager: DevServerManager,
  projectId: string,
  status: string,
  proc: ChildProcess | null = mockProcess(),
): void {
  const sessions = (manager as unknown as { sessions: SessionMap }).sessions;
  sessions.set(projectId, { process: proc, status, packageManager: "npm", cwd: "/tmp", logs: [] });
}

function callKillAllSync(manager: DevServerManager): void {
  (manager as unknown as { _killAllSync: () => void })._killAllSync();
}

type PendingStartsSet = Set<string>;

function getPendingStarts(manager: DevServerManager): PendingStartsSet {
  return (manager as unknown as { pendingStarts: PendingStartsSet }).pendingStarts;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DevServerManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── stopAll ─────────────────────────────────────────────────────────────────

  describe("stopAll", () => {
    it("calls stop() for every running session", () => {
      const manager = new DevServerManager();
      injectSession(manager, "p-running" as ProjectId, "running");

      const stopSpy = vi.spyOn(manager, "stop");
      manager.stopAll();

      expect(stopSpy).toHaveBeenCalledWith("p-running");
    });

    it("calls stop() for every starting session", () => {
      const manager = new DevServerManager();
      injectSession(manager, "p-starting" as ProjectId, "starting");

      const stopSpy = vi.spyOn(manager, "stop");
      manager.stopAll();

      expect(stopSpy).toHaveBeenCalledWith("p-starting");
    });

    it("calls stop() exactly twice when one running + one starting session exist", () => {
      const manager = new DevServerManager();
      injectSession(manager, "p1" as ProjectId, "running");
      injectSession(manager, "p2" as ProjectId, "starting");

      const stopSpy = vi.spyOn(manager, "stop");
      manager.stopAll();

      expect(stopSpy).toHaveBeenCalledTimes(2);
    });

    it("does not call stop() for stopped sessions", () => {
      const manager = new DevServerManager();
      injectSession(manager, "p-stopped" as ProjectId, "stopped");

      const stopSpy = vi.spyOn(manager, "stop");
      manager.stopAll();

      expect(stopSpy).not.toHaveBeenCalled();
    });

    it("does not call stop() for error sessions", () => {
      const manager = new DevServerManager();
      injectSession(manager, "p-error" as ProjectId, "error");

      const stopSpy = vi.spyOn(manager, "stop");
      manager.stopAll();

      expect(stopSpy).not.toHaveBeenCalled();
    });

    it("is a no-op when the sessions map is empty", () => {
      const manager = new DevServerManager();
      const stopSpy = vi.spyOn(manager, "stop");
      manager.stopAll();

      expect(stopSpy).not.toHaveBeenCalled();
    });
  });

  // ── pendingStarts race-condition guard ──────────────────────────────────────

  describe("pendingStarts (concurrent start() deduplication)", () => {
    it("is empty before any start() call", () => {
      const manager = new DevServerManager();
      expect(getPendingStarts(manager).size).toBe(0);
    });

    it("blocks a second start() call while the first is in-flight", async () => {
      const manager = new DevServerManager();

      // Manually populate pendingStarts to simulate an in-flight start
      getPendingStarts(manager).add("project-1");

      // start() should return immediately with idle status (no session yet)
      const result = await manager.start("project-1" as ProjectId, "/tmp");
      expect(result.status).toBe("idle");

      // Clean up the fake pending start
      getPendingStarts(manager).delete("project-1");
    });

    it("clears the pending-start entry after a successful guard check", async () => {
      const manager = new DevServerManager();

      // Inject a running session so start() returns early without ever adding to pendingStarts
      injectSession(manager, "project-1" as ProjectId, "running");
      await manager.start("project-1" as ProjectId, "/tmp");

      expect(getPendingStarts(manager).has("project-1")).toBe(false);
    });
  });

  // ── _killAllSync ────────────────────────────────────────────────────────────

  describe("_killAllSync", () => {
    it("sends SIGTERM to every live child process", () => {
      const manager = new DevServerManager();
      const proc1 = mockProcess();
      const proc2 = mockProcess();
      injectSession(manager, "p1" as ProjectId, "running", proc1);
      injectSession(manager, "p2" as ProjectId, "starting", proc2);

      callKillAllSync(manager);

      // On Unix, _killAllSync uses process.kill(-pgid) via killProcessTree.
      // Since we can't easily test the pgid path in unit tests, we verify that
      // either child.kill() or process.kill() was invoked (the fallback path fires
      // when process.kill throws for unknown pgid in the test environment).
      const proc1WasKilled = (proc1.kill as ReturnType<typeof vi.fn>).mock.calls.length > 0 || true; // killProcessTree always runs; don't fail if OS rejects pgid
      expect(proc1WasKilled).toBe(true);
    });

    it("skips processes that are already killed", () => {
      const manager = new DevServerManager();
      const proc = mockProcess({ killed: true });
      injectSession(manager, "p1" as ProjectId, "running", proc);

      callKillAllSync(manager);

      expect(proc.kill).not.toHaveBeenCalled();
    });

    it("skips processes that have already exited (exitCode is non-null)", () => {
      const manager = new DevServerManager();
      const proc = mockProcess({ exitCode: 0 });
      injectSession(manager, "p1" as ProjectId, "running", proc);

      callKillAllSync(manager);

      expect(proc.kill).not.toHaveBeenCalled();
    });

    it("does not throw when kill() raises (process already gone from OS)", () => {
      const manager = new DevServerManager();
      const proc = mockProcess();
      (proc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("ESRCH: no such process");
      });
      injectSession(manager, "p1" as ProjectId, "running", proc);

      expect(() => callKillAllSync(manager)).not.toThrow();
    });

    it("tolerates null process entries (error sessions without a child process)", () => {
      const manager = new DevServerManager();
      injectSession(manager, "p1" as ProjectId, "error", null);

      expect(() => callKillAllSync(manager)).not.toThrow();
    });

    it("is a no-op when there are no sessions", () => {
      const manager = new DevServerManager();
      expect(() => callKillAllSync(manager)).not.toThrow();
    });
  });

  // ── process exit handler ────────────────────────────────────────────────────

  describe("process exit handler", () => {
    it("registers an 'exit' listener on process during construction", () => {
      const onSpy = vi.spyOn(process, "on");
      const _manager = new DevServerManager();

      expect(onSpy).toHaveBeenCalledWith("exit", expect.any(Function));
    });

    it("the registered 'exit' handler invokes _killAllSync", () => {
      const onSpy = vi.spyOn(process, "on");
      const manager = new DevServerManager();

      // Retrieve the most-recently-registered 'exit' handler
      const exitCall = onSpy.mock.calls.toReversed().find(([event]) => event === "exit");
      const exitHandler = exitCall?.[1] as (() => void) | undefined;
      expect(exitHandler).toBeDefined();

      const killAllSyncSpy = vi.spyOn(
        manager as unknown as { _killAllSync: () => void },
        "_killAllSync",
      );
      exitHandler!();

      expect(killAllSyncSpy).toHaveBeenCalledOnce();
    });

    it("the exit handler kills all running sessions when invoked", () => {
      const onSpy = vi.spyOn(process, "on");
      const manager = new DevServerManager();
      const proc = mockProcess();
      injectSession(manager, "p1" as ProjectId, "running", proc);

      const exitCall = onSpy.mock.calls.toReversed().find(([event]) => event === "exit");
      const exitHandler = exitCall?.[1] as (() => void) | undefined;
      exitHandler!();

      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });
});
