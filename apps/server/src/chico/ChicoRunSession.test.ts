import { describe, it, expect, beforeEach } from "vitest";
import { ChicoRunSession } from "./ChicoRunSession.ts";
import type { AgentEvent } from "./ChicoProtoLoader.ts";

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    seq: "1",
    timestamp: new Date().toISOString(),
    event_type: "Unknown",
    source: "test",
    phase: "starting",
    level: "info",
    payload: "{}",
    run_id: "test-run-abc123",
    container_id: "container-1",
    ...overrides,
  };
}

describe("ChicoRunSession", () => {
  let session: ChicoRunSession;

  beforeEach(() => {
    session = new ChicoRunSession("test-run-abc123", "container-1", "myproject");
  });

  // ── Metadata ────────────────────────────────────────────────────────

  it("parses project name from constructor argument", () => {
    expect(session.projectName).toBe("myproject");
  });

  it("parses project name from run_id when project is empty", () => {
    const s = new ChicoRunSession("chico-myapp-a1b2c3", "c1", "");
    expect(s.projectName).toBe("myapp");
  });

  it("uses run_id as project name when parsing fails", () => {
    const s = new ChicoRunSession("plain-run-id", "c1", "");
    expect(s.projectName).toBe("plain-run-id");
  });

  // ── Sequence tracking ────────────────────────────────────────────────

  it("tracks lastKnownSeq from events", () => {
    session.applyEvent(makeEvent({ seq: "42" }));
    expect(session.lastKnownSeq).toBe(42);
  });

  it("does not go backwards on lastKnownSeq", () => {
    session.applyEvent(makeEvent({ seq: "50" }));
    session.applyEvent(makeEvent({ seq: "30" }));
    expect(session.lastKnownSeq).toBe(50);
  });

  // ── Phase changes ────────────────────────────────────────────────────

  it("applies PhaseTransition event", () => {
    session.applyEvent(
      makeEvent({
        event_type: "PhaseTransition",
        payload: JSON.stringify({ to: "spawning_workers" }),
      }),
    );
    expect(session.phase).toBe("spawning_workers");
  });

  it("applies PhaseChangeRequested event using phase field in payload", () => {
    session.applyEvent(
      makeEvent({
        event_type: "PhaseChangeRequested",
        payload: JSON.stringify({ phase: "merging" }),
      }),
    );
    expect(session.phase).toBe("merging");
  });

  it("falls back to event.phase for PhaseTransition", () => {
    session.applyEvent(
      makeEvent({
        event_type: "PhaseTransition",
        phase: "complete",
        payload: "{}",
      }),
    );
    expect(session.phase).toBe("complete");
  });

  // ── Worker lifecycle ─────────────────────────────────────────────────

  it("registers a worker on WorkerSessionAssigned", () => {
    session.applyEvent(
      makeEvent({
        event_type: "WorkerSessionAssigned",
        worker_id: 1,
        payload: JSON.stringify({ label: "implement-auth", task: "Auth module" }),
      }),
    );
    expect(session.workers.has(1)).toBe(true);
    expect(session.workers.get(1)!.label).toBe("implement-auth");
  });

  it("transitions worker to running on WorkerActive", () => {
    session.applyEvent(
      makeEvent({ event_type: "WorkerSessionAssigned", worker_id: 2, payload: "{}" }),
    );
    session.applyEvent(makeEvent({ event_type: "WorkerActive", worker_id: 2, payload: "{}" }));
    expect(session.workers.get(2)!.lifecycle).toBe("running");
    expect(session.workers.get(2)!.startedAt).not.toBeNull();
  });

  it("transitions worker to completed on WorkerCompleted", () => {
    session.applyEvent(
      makeEvent({ event_type: "WorkerSessionAssigned", worker_id: 3, payload: "{}" }),
    );
    session.applyEvent(makeEvent({ event_type: "WorkerCompleted", worker_id: 3, payload: "{}" }));
    expect(session.workers.get(3)!.lifecycle).toBe("completed");
    expect(session.workers.get(3)!.activity).toBe("");
  });

  it("transitions worker to failed on WorkerFailed", () => {
    session.applyEvent(
      makeEvent({
        event_type: "WorkerFailed",
        worker_id: 4,
        payload: JSON.stringify({ reason: "build failed" }),
      }),
    );
    expect(session.workers.get(4)!.lifecycle).toBe("failed");
    expect(session.workers.get(4)!.activity).toBe("build failed");
  });

  it("updates worker activity on WorkerActivity", () => {
    session.applyEvent(
      makeEvent({ event_type: "WorkerSessionAssigned", worker_id: 5, payload: "{}" }),
    );
    session.applyEvent(
      makeEvent({
        event_type: "WorkerActivity",
        worker_id: 5,
        payload: JSON.stringify({ activity: "running tests" }),
      }),
    );
    expect(session.workers.get(5)!.activity).toBe("running tests");
  });

  // ── Cost tracking ────────────────────────────────────────────────────

  it("updates cost and recalculates total on WorkerCostUpdate", () => {
    session.applyEvent(
      makeEvent({ event_type: "WorkerSessionAssigned", worker_id: 1, payload: "{}" }),
    );
    session.applyEvent(
      makeEvent({ event_type: "WorkerSessionAssigned", worker_id: 2, payload: "{}" }),
    );
    session.applyEvent(
      makeEvent({
        event_type: "WorkerCostUpdate",
        worker_id: 1,
        payload: JSON.stringify({ cost_usd: 0.12, steps: 5 }),
      }),
    );
    session.applyEvent(
      makeEvent({
        event_type: "WorkerCostUpdate",
        worker_id: 2,
        payload: JSON.stringify({ cost_usd: 0.08, steps: 3 }),
      }),
    );
    expect(session.workers.get(1)!.cost).toBeCloseTo(0.12);
    expect(session.workers.get(1)!.steps).toBe(5);
    expect(session.totalCostUsd).toBeCloseTo(0.2);
  });

  // ── Manager worker ───────────────────────────────────────────────────

  it("registers Manager as worker 999 on ManagerActive", () => {
    session.applyEvent(makeEvent({ event_type: "ManagerActive", payload: "{}" }));
    expect(session.workers.has(999)).toBe(true);
    expect(session.workers.get(999)!.label).toBe("Manager");
    expect(session.workers.get(999)!.lifecycle).toBe("running");
  });

  // ── Event ring buffer ────────────────────────────────────────────────

  it("accumulates events in ring buffer", () => {
    for (let i = 0; i < 5; i++) {
      session.applyEvent(makeEvent({ seq: String(i + 1) }));
    }
    const snap = session.toSnapshot();
    expect(snap.recentEvents).toHaveLength(5);
  });

  it("drops oldest events when ring buffer exceeds limit", () => {
    for (let i = 0; i < 220; i++) {
      session.applyEvent(makeEvent({ seq: String(i + 1) }));
    }
    const snap = session.toSnapshot();
    expect(snap.recentEvents.length).toBe(200);
    // Most recent event should be the last one
    expect(snap.recentEvents[199]!.seq).toBe(220);
  });

  // ── Snapshot ─────────────────────────────────────────────────────────

  it("produces a complete snapshot", () => {
    session.applyEvent(
      makeEvent({ event_type: "WorkerSessionAssigned", worker_id: 1, payload: "{}" }),
    );
    const snap = session.toSnapshot();
    expect(snap.runId).toBe("test-run-abc123");
    expect(snap.containerId).toBe("container-1");
    expect(snap.status).toBe("active");
    expect(snap.workers).toHaveLength(1);
    expect(snap.connectedAt).toBeTruthy();
  });
});
