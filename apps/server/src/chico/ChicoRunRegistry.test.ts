import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChicoRunRegistry } from "./ChicoRunRegistry.ts";
import type { EventStreamInit, AgentEvent } from "./ChicoProtoLoader.ts";

function makeInit(overrides: Partial<EventStreamInit> = {}): EventStreamInit {
  return {
    run_id: "run-abc",
    container_id: "ctr-1",
    project_name: "myproject",
    last_known_seq: "0",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    seq: "1",
    timestamp: new Date().toISOString(),
    event_type: "WorkerActive",
    source: "worker-1",
    phase: "spawning_workers",
    level: "info",
    payload: "{}",
    run_id: "run-abc",
    container_id: "ctr-1",
    worker_id: 1,
    ...overrides,
  };
}

describe("ChicoRunRegistry", () => {
  let registry: ChicoRunRegistry;

  beforeEach(() => {
    registry = new ChicoRunRegistry();
  });

  // ── registerRun ──────────────────────────────────────────────────────

  it("registers a new run and emits run.registered", () => {
    const listener = vi.fn();
    registry.addListener(listener);
    registry.registerRun(makeInit());

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0].kind).toBe("run.registered");
    expect(registry.sessionCount).toBe(1);
  });

  it("returns existing session without emitting on duplicate registerRun", () => {
    const listener = vi.fn();
    registry.registerRun(makeInit());
    registry.addListener(listener);
    // Second call for same run_id — should not fire listener
    registry.registerRun(makeInit());

    expect(listener).not.toHaveBeenCalled();
    expect(registry.sessionCount).toBe(1);
  });

  it("re-activates a disconnected run without creating a new session", () => {
    registry.registerRun(makeInit());
    registry.disconnectRun("run-abc");
    const snap1 = registry.getSnapshot("run-abc")!;
    expect(snap1.status).toBe("disconnected");

    // Re-register (reconnect)
    registry.registerRun(makeInit());
    const snap2 = registry.getSnapshot("run-abc")!;
    expect(snap2.status).toBe("active");
    expect(registry.sessionCount).toBe(1);
  });

  // ── disconnectRun ────────────────────────────────────────────────────

  it("marks run as disconnected and emits run.disconnected", () => {
    const listener = vi.fn();
    registry.registerRun(makeInit());
    registry.addListener(listener);
    registry.disconnectRun("run-abc");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0].kind).toBe("run.disconnected");
    expect(listener.mock.calls[0]![0].runId).toBe("run-abc");
    expect(registry.getSnapshot("run-abc")!.status).toBe("disconnected");
  });

  it("is a no-op for unknown runId in disconnectRun", () => {
    const listener = vi.fn();
    registry.addListener(listener);
    registry.disconnectRun("nonexistent");
    expect(listener).not.toHaveBeenCalled();
  });

  // ── applyEvent ───────────────────────────────────────────────────────

  it("applies event to session and emits run.event", () => {
    const listener = vi.fn();
    registry.registerRun(makeInit());
    registry.addListener(listener);
    registry.applyEvent(makeEvent({ event_type: "WorkerActive", worker_id: 1 }));

    expect(listener).toHaveBeenCalledOnce();
    const call = listener.mock.calls[0]![0];
    expect(call.kind).toBe("run.event");
    expect(call.runId).toBe("run-abc");
    expect(call.snapshot.workers[0]?.lifecycle).toBe("running");
  });

  it("creates a session on-the-fly if event arrives before StreamEvents", () => {
    registry.applyEvent(makeEvent({ run_id: "new-run", container_id: "ctr-2" }));
    expect(registry.sessionCount).toBe(1);
    expect(registry.getSnapshot("new-run")).not.toBeUndefined();
  });

  // ── Multi-run isolation ───────────────────────────────────────────────

  it("keeps runs isolated — events for run A do not affect run B", () => {
    registry.registerRun(makeInit({ run_id: "run-A", container_id: "ctr-A" }));
    registry.registerRun(makeInit({ run_id: "run-B", container_id: "ctr-B" }));

    registry.applyEvent(
      makeEvent({
        run_id: "run-A",
        container_id: "ctr-A",
        event_type: "PhaseTransition",
        payload: JSON.stringify({ to: "complete" }),
      }),
    );

    expect(registry.getSnapshot("run-A")!.phase).toBe("complete");
    expect(registry.getSnapshot("run-B")!.phase).toBe("starting");
  });

  it("getAllSnapshots returns all registered runs", () => {
    registry.registerRun(makeInit({ run_id: "run-A", container_id: "ctr-A" }));
    registry.registerRun(makeInit({ run_id: "run-B", container_id: "ctr-B" }));

    const snaps = registry.getAllSnapshots();
    expect(snaps).toHaveLength(2);
    const ids = snaps.map((s) => s.runId).toSorted();
    expect(ids).toEqual(["run-A", "run-B"]);
  });

  // ── Listener cleanup ──────────────────────────────────────────────────

  it("unsubscribes listener correctly", () => {
    const listener = vi.fn();
    const unsub = registry.addListener(listener);
    registry.registerRun(makeInit());
    expect(listener).toHaveBeenCalledOnce();

    unsub();
    registry.registerRun(makeInit({ run_id: "run-2", container_id: "ctr-2" }));
    // Should not be called again after unsubscribe
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not crash if a listener throws", () => {
    const badListener = vi.fn().mockImplementation(() => {
      throw new Error("bad listener");
    });
    const goodListener = vi.fn();
    registry.addListener(badListener);
    registry.addListener(goodListener);

    expect(() => registry.registerRun(makeInit())).not.toThrow();
    expect(goodListener).toHaveBeenCalledOnce();
  });
});
