import { describe, it, expect, beforeEach } from "vitest";
import { useChicoStore, selectAllRuns, selectActiveRuns, selectSelectedRun } from "./chicoStore";
import type { ChicoRunSnapshot } from "@t3tools/contracts";

function makeRun(overrides: Partial<ChicoRunSnapshot> = {}): ChicoRunSnapshot {
  return {
    runId: "run-abc",
    containerId: "ctr-1",
    projectName: "myproject",
    status: "active",
    phase: "spawning_workers",
    workers: [],
    totalCostUsd: 0,
    recentEvents: [],
    connectedAt: new Date().toISOString(),
    lastEventAt: null,
    lastKnownSeq: 0,
    ...overrides,
  };
}

// Reset Zustand store between tests
function resetStore() {
  useChicoStore.setState({
    runs: new Map(),
    selectedRunId: null,
    serverInfo: null,
    isBootstrapping: false,
    bootstrapError: null,
  });
}

describe("chicoStore", () => {
  beforeEach(() => {
    resetStore();
  });

  // ── upsertRun ────────────────────────────────────────────────────────

  it("inserts a new run", () => {
    useChicoStore.getState().upsertRun(makeRun());
    const state = useChicoStore.getState();
    expect(state.runs.size).toBe(1);
    expect(state.runs.get("run-abc")).not.toBeUndefined();
  });

  it("updates an existing run on upsert", () => {
    useChicoStore.getState().upsertRun(makeRun({ phase: "starting" }));
    useChicoStore.getState().upsertRun(makeRun({ phase: "complete" }));
    expect(useChicoStore.getState().runs.get("run-abc")!.phase).toBe("complete");
    expect(useChicoStore.getState().runs.size).toBe(1);
  });

  // ── markRunDisconnected ──────────────────────────────────────────────

  it("marks a run as disconnected", () => {
    useChicoStore.getState().upsertRun(makeRun());
    useChicoStore.getState().markRunDisconnected("run-abc");
    expect(useChicoStore.getState().runs.get("run-abc")!.status).toBe("disconnected");
  });

  it("is a no-op for unknown runId", () => {
    const before = useChicoStore.getState().runs.size;
    useChicoStore.getState().markRunDisconnected("nonexistent");
    expect(useChicoStore.getState().runs.size).toBe(before);
  });

  // ── selectRun ────────────────────────────────────────────────────────

  it("selects a known run", () => {
    useChicoStore.getState().upsertRun(makeRun());
    useChicoStore.getState().selectRun("run-abc");
    expect(useChicoStore.getState().selectedRunId).toBe("run-abc");
  });

  it("ignores selection of unknown run", () => {
    useChicoStore.getState().selectRun("nonexistent");
    expect(useChicoStore.getState().selectedRunId).toBeNull();
  });

  it("allows clearing selection with null", () => {
    useChicoStore.getState().upsertRun(makeRun());
    useChicoStore.getState().selectRun("run-abc");
    useChicoStore.getState().selectRun(null);
    expect(useChicoStore.getState().selectedRunId).toBeNull();
  });

  // ── applyRunStateUpdate ──────────────────────────────────────────────

  it("updates run state on applyRunStateUpdate", () => {
    useChicoStore.getState().upsertRun(makeRun({ phase: "starting" }));
    useChicoStore.getState().applyRunStateUpdate("run-abc", makeRun({ phase: "complete" }));
    expect(useChicoStore.getState().runs.get("run-abc")!.phase).toBe("complete");
  });

  // ── serverInfo ───────────────────────────────────────────────────────

  it("stores server info", () => {
    useChicoStore.getState().setServerInfo({
      grpcPort: 50099,
      grpcHost: "localhost",
      endpoint: "http://localhost:50099",
    });
    expect(useChicoStore.getState().serverInfo?.grpcPort).toBe(50099);
  });

  // ── Selectors ────────────────────────────────────────────────────────

  it("selectAllRuns returns all runs sorted by connectedAt desc", () => {
    const older = makeRun({ runId: "older", connectedAt: "2024-01-01T10:00:00Z" });
    const newer = makeRun({ runId: "newer", connectedAt: "2024-01-02T10:00:00Z" });
    useChicoStore.getState().upsertRun(older);
    useChicoStore.getState().upsertRun(newer);

    const state = useChicoStore.getState();
    const all = selectAllRuns(state);
    expect(all[0]!.runId).toBe("newer");
    expect(all[1]!.runId).toBe("older");
  });

  it("selectActiveRuns filters out disconnected runs", () => {
    useChicoStore.getState().upsertRun(makeRun({ runId: "active-run", status: "active" }));
    useChicoStore.getState().upsertRun(makeRun({ runId: "dead-run", status: "disconnected" }));

    const active = selectActiveRuns(useChicoStore.getState());
    expect(active).toHaveLength(1);
    expect(active[0]!.runId).toBe("active-run");
  });

  it("selectSelectedRun returns null when no run selected", () => {
    useChicoStore.getState().upsertRun(makeRun());
    expect(selectSelectedRun(useChicoStore.getState())).toBeNull();
  });

  it("selectSelectedRun returns the selected run snapshot", () => {
    useChicoStore.getState().upsertRun(makeRun());
    useChicoStore.getState().selectRun("run-abc");
    const result = selectSelectedRun(useChicoStore.getState());
    expect(result?.runId).toBe("run-abc");
  });

  // ── Bootstrap flags ──────────────────────────────────────────────────

  it("tracks bootstrapping state", () => {
    useChicoStore.getState().setBootstrapping(true);
    expect(useChicoStore.getState().isBootstrapping).toBe(true);
    useChicoStore.getState().setBootstrapping(false);
    expect(useChicoStore.getState().isBootstrapping).toBe(false);
  });

  it("tracks bootstrap errors", () => {
    useChicoStore.getState().setBootstrapError("Connection refused");
    expect(useChicoStore.getState().bootstrapError).toBe("Connection refused");
    useChicoStore.getState().setBootstrapError(null);
    expect(useChicoStore.getState().bootstrapError).toBeNull();
  });
});
