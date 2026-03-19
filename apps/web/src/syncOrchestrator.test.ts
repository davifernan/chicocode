import { EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SyncProgress } from "./syncOrchestrator";

// ── Mock WsTransport ──────────────────────────────────────────────────
//
// The syncOrchestrator creates its own remote WsTransport internally via
// `new WsTransport(tunnelWsUrl)`. We mock the constructor so each new
// instance is dequeued from `nextTransportQueue`. Tests push their
// pre-configured mock transports into the queue before calling runSync.
//
// The localTransport is passed directly to runSync and never constructed
// via `new WsTransport()`, so it doesn't go through this queue.

interface MockTransport {
  request: (...args: unknown[]) => unknown;
  dispose: () => void;
}

const nextTransportQueue: MockTransport[] = [];

vi.mock("./wsTransport", () => ({
  WsTransport: class MockWsTransport {
    private state: MockTransport;
    constructor() {
      // Dequeue the next pre-configured transport, or fall back to an empty mock
      const next = nextTransportQueue.shift();
      const reqFn = vi.fn();
      const dispFn = vi.fn();
      this.state = next ?? { request: reqFn as MockTransport["request"], dispose: dispFn };
    }
    request(...args: unknown[]) {
      return (this.state.request as CallableFunction)(...args);
    }
    dispose() {
      (this.state.dispose as CallableFunction)();
    }
    subscribe() {
      return () => {};
    }
    getLatestPush() {
      return null;
    }
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────

type ManifestEntry = { threadId: string; maxStreamVersion: number; eventCount: number };

// Typed transport used in factory functions — keeps vi.fn() types accessible
interface TypedMockTransport extends MockTransport {
  requestMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
}

function makeLocalTransport(
  localManifest: ManifestEntry[],
  eventsByThread: Record<string, unknown[]> = {},
): TypedMockTransport {
  const requestMock = vi.fn();
  const disposeMock = vi.fn();
  requestMock.mockImplementation((method: string, params?: { threadId?: string }) => {
    if (method === "sync.getThreadManifest") {
      return Promise.resolve({ threads: localManifest });
    }
    if (method === "sync.exportThreadEvents" && params?.threadId) {
      return Promise.resolve({ events: eventsByThread[params.threadId] ?? [] });
    }
    return Promise.reject(new Error(`Unexpected local call: ${method}`));
  });
  return {
    request: requestMock as MockTransport["request"],
    dispose: disposeMock as MockTransport["dispose"],
    requestMock,
    disposeMock,
  };
}

function makeRemoteTransport(
  remoteManifest: ManifestEntry[],
  receiveResult: { accepted: number; skipped: number } = { accepted: 5, skipped: 0 },
): TypedMockTransport {
  const requestMock = vi.fn();
  const disposeMock = vi.fn();
  requestMock.mockImplementation((method: string) => {
    if (method === "sync.getThreadManifest") {
      return Promise.resolve({ threads: remoteManifest });
    }
    if (method === "sync.receiveEvents") {
      return Promise.resolve(receiveResult);
    }
    return Promise.reject(new Error(`Unexpected remote call: ${method}`));
  });
  return {
    request: requestMock as MockTransport["request"],
    dispose: disposeMock as MockTransport["dispose"],
    requestMock,
    disposeMock,
  };
}

function makeFakeEvent(threadId: string, idx = 0) {
  return {
    sequence: idx,
    eventId: EventId.makeUnsafe(`evt-${threadId}-${idx}`),
    aggregateKind: "thread" as const,
    aggregateId: ThreadId.makeUnsafe(threadId),
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.created" as const,
    payload: {
      projectId: ProjectId.makeUnsafe("project-1"),
      threadId: ThreadId.makeUnsafe(threadId),
      title: "Thread",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      defaultModel: null,
      interactionMode: "auto-edit" as const,
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  nextTransportQueue.length = 0;
  vi.useFakeTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("syncOrchestrator — manifest comparison", () => {
  it("pushes threads that exist locally but not remotely", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const local = makeLocalTransport(
      [
        { threadId: "t1", maxStreamVersion: 3, eventCount: 4 },
        { threadId: "t2", maxStreamVersion: 1, eventCount: 2 },
      ],
      { t1: [makeFakeEvent("t1")], t2: [makeFakeEvent("t2")] },
    );

    const remote = makeRemoteTransport([], { accepted: 1, skipped: 0 });
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await syncPromise;

    expect(summary.pushed).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.diverged).toHaveLength(0);
    expect(summary.errors).toHaveLength(0);
  });

  it("skips threads that exist on both with the same version", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const local = makeLocalTransport([{ threadId: "t1", maxStreamVersion: 5, eventCount: 6 }]);
    const remote = makeRemoteTransport([{ threadId: "t1", maxStreamVersion: 5, eventCount: 6 }]);
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await syncPromise;

    expect(summary.pushed).toBe(0);
    expect(summary.diverged).toHaveLength(0);
    expect(local.request).not.toHaveBeenCalledWith("sync.exportThreadEvents", expect.any(Object));
  });

  it("marks threads with different versions as diverged (warn + skip)", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const local = makeLocalTransport([{ threadId: "t-div", maxStreamVersion: 10, eventCount: 11 }]);
    const remote = makeRemoteTransport([{ threadId: "t-div", maxStreamVersion: 7, eventCount: 8 }]);
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await syncPromise;

    expect(summary.diverged).toContain("t-div");
    expect(summary.pushed).toBe(0);
    expect(local.request).not.toHaveBeenCalledWith("sync.exportThreadEvents", expect.any(Object));
  });

  it("handles a mix of new, same, and diverged threads correctly", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const local = makeLocalTransport(
      [
        { threadId: "new-thread", maxStreamVersion: 2, eventCount: 3 },
        { threadId: "same-thread", maxStreamVersion: 5, eventCount: 6 },
        { threadId: "div-thread", maxStreamVersion: 8, eventCount: 9 },
      ],
      { "new-thread": [makeFakeEvent("new-thread")] },
    );
    const remote = makeRemoteTransport(
      [
        { threadId: "same-thread", maxStreamVersion: 5, eventCount: 6 },
        { threadId: "div-thread", maxStreamVersion: 3, eventCount: 4 },
      ],
      { accepted: 3, skipped: 0 },
    );
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await syncPromise;

    expect(summary.pushed).toBe(1);
    expect(summary.diverged).toEqual(["div-thread"]);
    expect(summary.errors).toHaveLength(0);
  });

  it("returns zero totals when local manifest is empty", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const local = makeLocalTransport([]);
    const remote = makeRemoteTransport([]);
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await syncPromise;

    expect(summary.pushed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.diverged).toHaveLength(0);
    expect(summary.errors).toHaveLength(0);
  });
});

describe("syncOrchestrator — progress callbacks", () => {
  it("calls onProgress with total before pushing threads", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const local = makeLocalTransport([{ threadId: "t1", maxStreamVersion: 1, eventCount: 1 }], {
      t1: [makeFakeEvent("t1")],
    });
    const remote = makeRemoteTransport([], { accepted: 1, skipped: 0 });
    nextTransportQueue.push(remote);

    const progress: SyncProgress[] = [];
    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      (p) => progress.push({ ...p }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await syncPromise;

    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0]!.total).toBe(1);
  });

  it("reports currentThreadId for each thread being pushed", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const local = makeLocalTransport(
      [
        { threadId: "thread-a", maxStreamVersion: 1, eventCount: 1 },
        { threadId: "thread-b", maxStreamVersion: 1, eventCount: 1 },
      ],
      {
        "thread-a": [makeFakeEvent("thread-a")],
        "thread-b": [makeFakeEvent("thread-b")],
      },
    );
    const remote = makeRemoteTransport([], { accepted: 1, skipped: 0 });
    nextTransportQueue.push(remote);

    const seenThreadIds = new Set<string | null>();
    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      (p) => seenThreadIds.add(p.currentThreadId),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await syncPromise;

    expect(seenThreadIds).toContain("thread-a");
    expect(seenThreadIds).toContain("thread-b");
  });
});

describe("syncOrchestrator — error handling", () => {
  it("records per-thread errors and continues with remaining threads", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const local = makeLocalTransport(
      [
        { threadId: "good", maxStreamVersion: 1, eventCount: 1 },
        { threadId: "bad", maxStreamVersion: 1, eventCount: 1 },
      ],
      { good: [makeFakeEvent("good")] },
    );
    // Make bad-thread export fail by overriding the mock implementation
    local.requestMock.mockImplementation((method: string, params?: { threadId?: string }) => {
      if (method === "sync.exportThreadEvents" && params?.threadId === "bad") {
        return Promise.reject(new Error("export failed"));
      }
      if (method === "sync.getThreadManifest") {
        return Promise.resolve({
          threads: [
            { threadId: "good", maxStreamVersion: 1, eventCount: 1 },
            { threadId: "bad", maxStreamVersion: 1, eventCount: 1 },
          ],
        });
      }
      if (method === "sync.exportThreadEvents" && params?.threadId === "good") {
        return Promise.resolve({ events: [makeFakeEvent("good")] });
      }
      return Promise.reject(new Error(`Unexpected call: ${method}`));
    });

    const remote = makeRemoteTransport([], { accepted: 1, skipped: 0 });
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await syncPromise;

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("bad");
    expect(summary.pushed).toBe(1); // good still pushed
  });

  it("disposes the remote transport after a successful sync", async () => {
    const { runSync } = await import("./syncOrchestrator");

    // Verify dispose is always called via the finally block — normal path
    const local = makeLocalTransport([{ threadId: "t1", maxStreamVersion: 1, eventCount: 1 }], {
      t1: [makeFakeEvent("t1")],
    });
    const remote = makeRemoteTransport([], { accepted: 1, skipped: 0 });
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await syncPromise;

    // dispose must be called after sync completes (finally block)
    expect(remote.disposeMock).toHaveBeenCalledTimes(1);
  });
});

describe("syncOrchestrator — abort signal", () => {
  it("stops after aborting — pushes fewer threads than total", async () => {
    const { runSync } = await import("./syncOrchestrator");
    const controller = new AbortController();

    const local = makeLocalTransport(
      [
        { threadId: "t1", maxStreamVersion: 1, eventCount: 1 },
        { threadId: "t2", maxStreamVersion: 1, eventCount: 1 },
        { threadId: "t3", maxStreamVersion: 1, eventCount: 1 },
      ],
      {
        t1: [makeFakeEvent("t1")],
        t2: [makeFakeEvent("t2")],
        t3: [makeFakeEvent("t3")],
      },
    );

    let receiveCalls = 0;
    const remote: MockTransport = {
      request: vi.fn().mockImplementation((method: string) => {
        if (method === "sync.getThreadManifest") return Promise.resolve({ threads: [] });
        if (method === "sync.receiveEvents") {
          receiveCalls++;
          if (receiveCalls >= 1) controller.abort();
          return Promise.resolve({ accepted: 1, skipped: 0 });
        }
        return Promise.resolve({});
      }),
      dispose: vi.fn(),
    };
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await syncPromise;

    expect(summary.pushed).toBeLessThan(3);
  });
});

describe("syncOrchestrator — batching", () => {
  it("sends 250 events in 3 batches of 100/100/50", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const events = Array.from({ length: 250 }, (_, i) => makeFakeEvent("big-thread", i));
    const local = makeLocalTransport(
      [{ threadId: "big-thread", maxStreamVersion: 250, eventCount: 250 }],
      { "big-thread": events },
    );
    const remote = makeRemoteTransport([], { accepted: 100, skipped: 0 });
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await syncPromise;

    const receiveCalls = remote.requestMock.mock.calls.filter(([m]) => m === "sync.receiveEvents");
    expect(receiveCalls).toHaveLength(3);
    expect(receiveCalls[0]![1].events).toHaveLength(100);
    expect(receiveCalls[1]![1].events).toHaveLength(100);
    expect(receiveCalls[2]![1].events).toHaveLength(50);
  });

  it("sends a single batch when events <= 100", async () => {
    const { runSync } = await import("./syncOrchestrator");

    const events = Array.from({ length: 42 }, (_, i) => makeFakeEvent("small-thread", i));
    const local = makeLocalTransport(
      [{ threadId: "small-thread", maxStreamVersion: 42, eventCount: 42 }],
      { "small-thread": events },
    );
    const remote = makeRemoteTransport([], { accepted: 42, skipped: 0 });
    nextTransportQueue.push(remote);

    const syncPromise = runSync(
      local as unknown as import("./wsTransport").WsTransport,
      "ws://tunnel:9999",
      () => {},
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await syncPromise;

    const receiveCalls = remote.requestMock.mock.calls.filter(([m]) => m === "sync.receiveEvents");
    expect(receiveCalls).toHaveLength(1);
    expect(receiveCalls[0]![1].events).toHaveLength(42);
  });
});
