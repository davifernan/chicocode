import { describe, it, expect } from "vitest";
import { Schema } from "effect";

import {
  ChicoWorkerSnapshot,
  ChicoRunSnapshot,
  ChicoServerInfo,
  ChicoRunRegisteredPayload,
  ChicoRunDisconnectedPayload,
  ChicoRunEventPayload,
  ChicoRunStateUpdatePayload,
  ChicoSerializedEvent,
} from "./chico";

const decodeWorker = Schema.decodeUnknownSync(ChicoWorkerSnapshot);
const decodeRun = Schema.decodeUnknownSync(ChicoRunSnapshot);
const decodeServerInfo = Schema.decodeUnknownSync(ChicoServerInfo);

function makeWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    label: "implement-auth",
    lifecycle: "running",
    activity: "writing tests",
    cost: 0.12,
    steps: 5,
    model: "claude-opus-4",
    elapsedMs: 30000,
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    seq: 1,
    timestamp: new Date().toISOString(),
    event_type: "WorkerActive",
    source: "worker-1",
    phase: "spawning_workers",
    level: "info",
    payload: "{}",
    run_id: "run-abc",
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-abc",
    containerId: "ctr-1",
    projectName: "myproject",
    status: "active",
    phase: "spawning_workers",
    workers: [makeWorker()],
    totalCostUsd: 0.12,
    recentEvents: [makeEvent()],
    connectedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastKnownSeq: 10,
    ...overrides,
  };
}

describe("ChicoWorkerSnapshot", () => {
  it("decodes a valid worker", () => {
    const result = decodeWorker(makeWorker());
    expect(result.id).toBe(1);
    expect(result.lifecycle).toBe("running");
  });

  it("accepts all lifecycle values", () => {
    const lifecycles = [
      "declared",
      "starting",
      "running",
      "idle",
      "completed",
      "failed",
      "aborted",
      "stopped",
    ];
    for (const lifecycle of lifecycles) {
      expect(() => decodeWorker(makeWorker({ lifecycle }))).not.toThrow();
    }
  });

  it("rejects invalid lifecycle", () => {
    expect(() => decodeWorker(makeWorker({ lifecycle: "flying" }))).toThrow();
  });

  it("accepts null startedAt", () => {
    const result = decodeWorker(makeWorker({ startedAt: null }));
    expect(result.startedAt).toBeNull();
  });
});

describe("ChicoRunSnapshot", () => {
  it("decodes a valid run with workers and events", () => {
    const result = decodeRun(makeRun());
    expect(result.runId).toBe("run-abc");
    expect(result.workers).toHaveLength(1);
    expect(result.recentEvents).toHaveLength(1);
  });

  it("accepts disconnected status", () => {
    const result = decodeRun(makeRun({ status: "disconnected" }));
    expect(result.status).toBe("disconnected");
  });

  it("rejects invalid status", () => {
    expect(() => decodeRun(makeRun({ status: "pending" }))).toThrow();
  });

  it("accepts null lastEventAt", () => {
    const result = decodeRun(makeRun({ lastEventAt: null }));
    expect(result.lastEventAt).toBeNull();
  });

  it("accepts empty workers array", () => {
    const result = decodeRun(makeRun({ workers: [] }));
    expect(result.workers).toHaveLength(0);
  });
});

describe("ChicoServerInfo", () => {
  it("decodes valid server info", () => {
    const result = decodeServerInfo({
      grpcPort: 50099,
      grpcHost: "localhost",
      endpoint: "http://localhost:50099",
    });
    expect(result.grpcPort).toBe(50099);
    expect(result.endpoint).toBe("http://localhost:50099");
  });
});

describe("ChicoSerializedEvent", () => {
  const decode = Schema.decodeUnknownSync(ChicoSerializedEvent);

  it("decodes event without worker_id", () => {
    const result = decode(makeEvent());
    expect(result.event_type).toBe("WorkerActive");
  });

  it("decodes event with worker_id", () => {
    const result = decode(makeEvent({ worker_id: 3 }));
    expect(result.worker_id).toBe(3);
  });
});

describe("Push payload schemas", () => {
  it("ChicoRunRegisteredPayload is the same shape as ChicoRunSnapshot", () => {
    const decode = Schema.decodeUnknownSync(ChicoRunRegisteredPayload);
    expect(() => decode(makeRun())).not.toThrow();
  });

  it("ChicoRunDisconnectedPayload decodes correctly", () => {
    const decode = Schema.decodeUnknownSync(ChicoRunDisconnectedPayload);
    expect(decode({ runId: "run-abc" }).runId).toBe("run-abc");
  });

  it("ChicoRunEventPayload decodes correctly", () => {
    const decode = Schema.decodeUnknownSync(ChicoRunEventPayload);
    const result = decode({ runId: "run-abc", event: makeEvent() });
    expect(result.runId).toBe("run-abc");
  });

  it("ChicoRunStateUpdatePayload decodes correctly", () => {
    const decode = Schema.decodeUnknownSync(ChicoRunStateUpdatePayload);
    const result = decode({ runId: "run-abc", snapshot: makeRun() });
    expect(result.runId).toBe("run-abc");
  });
});
