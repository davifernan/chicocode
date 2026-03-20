import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SyncCursorRepositoryLive } from "../persistence/Layers/SyncCursor.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { SyncService } from "./SyncService.ts";
import { SyncServiceLive } from "./SyncService.ts";

// ── Test layer ────────────────────────────────────────────────────────
//
// Both SyncService AND OrchestrationEventStore are exposed to tests so
// fixtures can be set up via the event store directly.

const sharedInfra = Layer.mergeAll(OrchestrationEventStoreLive, SyncCursorRepositoryLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const layer = it.layer(SyncServiceLive.pipe(Layer.provideMerge(sharedInfra)));

// ── Helpers ───────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z";

function makeProjectEvent(projectId: string, suffix = "") {
  return {
    type: "project.created" as const,
    eventId: EventId.makeUnsafe(`evt-proj-${projectId}${suffix}`),
    aggregateKind: "project" as const,
    aggregateId: ProjectId.makeUnsafe(projectId),
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe(`cmd-proj-${projectId}${suffix}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId: ProjectId.makeUnsafe(projectId),
      title: "Test Project",
      workspaceRoot: "/tmp/test",
      defaultModel: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  } as const;
}

function makeThreadEvent(threadId: string, projectId: string, suffix = "") {
  return {
    type: "thread.created" as const,
    eventId: EventId.makeUnsafe(`evt-thread-${threadId}${suffix}`),
    aggregateKind: "thread" as const,
    aggregateId: ThreadId.makeUnsafe(threadId),
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe(`cmd-thread-${threadId}${suffix}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: ThreadId.makeUnsafe(threadId),
      projectId: ProjectId.makeUnsafe(projectId),
      title: "Test Thread",
      model: "o4-mini",
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      provider: "codex" as const,
      source: "native" as const,
      externalSessionId: null,
      externalThreadId: null,
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

layer("SyncService.getThreadManifest", (it) => {
  it.effect("returns empty array when no events exist", () =>
    Effect.gen(function* () {
      const syncService = yield* SyncService;
      const manifest = yield* syncService.getThreadManifest();
      assert.deepEqual(manifest, []);
    }),
  );

  it.effect("returns one entry per unique thread", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      yield* eventStore.append(makeThreadEvent("thread-1", "project-1"));
      yield* eventStore.append(makeThreadEvent("thread-2", "project-1"));

      const manifest = yield* syncService.getThreadManifest();
      assert.equal(manifest.length, 2);
      const ids = manifest.map((e) => e.threadId).toSorted();
      assert.deepEqual(ids, ["thread-1", "thread-2"]);
    }),
  );

  it.effect("counts eventCount correctly for multiple events per thread", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      yield* eventStore.append(makeThreadEvent("multi-thread", "project-1", "-a"));
      yield* eventStore.append(makeThreadEvent("multi-thread", "project-1", "-b"));
      yield* eventStore.append(makeThreadEvent("multi-thread", "project-1", "-c"));

      const manifest = yield* syncService.getThreadManifest();
      const entry = manifest.find((e) => e.threadId === "multi-thread");
      assert.ok(entry !== undefined);
      assert.equal(entry.eventCount, 3);
    }),
  );

  it.effect("ignores project-level events (only thread aggregates counted)", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      // Use a unique project ID that won't match any thread ID
      const uniqueProjectId = "project-only-no-thread-counterpart-xyz";
      yield* eventStore.append(makeProjectEvent(uniqueProjectId));

      const manifest = yield* syncService.getThreadManifest();
      // The project event should NOT appear in the thread manifest
      const hasProjectId = manifest.some((e) => e.threadId === uniqueProjectId);
      assert.ok(!hasProjectId, "Project events must not appear in thread manifest");
    }),
  );

  it.effect("maxStreamVersion reflects sequence assignment order", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      yield* eventStore.append(makeThreadEvent("versioned-thread", "project-1", "-1"));
      yield* eventStore.append(makeThreadEvent("versioned-thread", "project-1", "-2"));

      const manifest = yield* syncService.getThreadManifest();
      const entry = manifest.find((e) => e.threadId === "versioned-thread");
      assert.ok(entry !== undefined);
      assert.ok(entry.maxStreamVersion > 0);
      assert.equal(entry.eventCount, 2);
    }),
  );
});

layer("SyncService.exportThreadEvents", (it) => {
  it.effect("returns empty array for unknown threadId", () =>
    Effect.gen(function* () {
      const syncService = yield* SyncService;
      const events = yield* syncService.exportThreadEvents("non-existent-thread");
      assert.deepEqual(events, []);
    }),
  );

  it.effect("returns all events for the given thread", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      yield* eventStore.append(makeThreadEvent("export-thread", "project-1", "-1"));
      yield* eventStore.append(makeThreadEvent("export-thread", "project-1", "-2"));
      // Different thread — must not appear in export
      yield* eventStore.append(makeThreadEvent("other-thread", "project-1", "-x"));

      const events = yield* syncService.exportThreadEvents("export-thread");
      assert.equal(events.length, 2);
      for (const event of events) {
        assert.equal(event.aggregateId, "export-thread");
      }
    }),
  );

  it.effect("does not include events from other threads", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      yield* eventStore.append(makeThreadEvent("target-thread", "project-1", "-t"));
      yield* eventStore.append(makeThreadEvent("noise-thread", "project-1", "-n"));

      const events = yield* syncService.exportThreadEvents("target-thread");
      const allFromTarget = events.every((e) => e.aggregateId === "target-thread");
      assert.ok(allFromTarget);
    }),
  );
});

layer("SyncService.receiveEvents", (it) => {
  it.effect("accepts new events and returns accepted count", () =>
    Effect.gen(function* () {
      const syncService = yield* SyncService;

      // Create a fresh event that has NOT been appended yet
      const freshEvent = makeThreadEvent("rx-new-thread", "project-1", "-fresh");
      // receiveEvents expects OrchestrationEvent (with sequence) — we pass sequence 0
      // and the DB will re-assign on insert
      const result = yield* syncService.receiveEvents([
        { ...freshEvent, sequence: 0 } as OrchestrationEvent,
      ]);

      assert.equal(result.accepted, 1);
      assert.equal(result.skipped, 0);
    }),
  );

  it.effect("is idempotent — skips events with duplicate event_id", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      // Append once via event store
      const stored = yield* eventStore.append(makeThreadEvent("idem-thread", "project-1", "-idem"));

      // Receive the same event again — must be skipped (event_id UNIQUE constraint)
      const result = yield* syncService.receiveEvents([stored]);
      assert.equal(result.accepted, 0);
      assert.equal(result.skipped, 1);
    }),
  );

  it.effect("counts mixed accepted and skipped in a batch", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      // Pre-store one event
      const duplicate = yield* eventStore.append(
        makeThreadEvent("batch-thread", "project-1", "-dup"),
      );

      // Batch: 1 duplicate + 2 new events
      const new1 = {
        ...makeThreadEvent("batch-thread", "project-1", "-new1"),
        sequence: 0,
      } as OrchestrationEvent;
      const new2 = {
        ...makeThreadEvent("batch-thread", "project-1", "-new2"),
        sequence: 0,
      } as OrchestrationEvent;

      const result = yield* syncService.receiveEvents([duplicate, new1, new2]);
      assert.equal(result.accepted, 2);
      assert.equal(result.skipped, 1);
    }),
  );

  it.effect("returns zeros for empty input", () =>
    Effect.gen(function* () {
      const syncService = yield* SyncService;
      const result = yield* syncService.receiveEvents([]);
      assert.equal(result.accepted, 0);
      assert.equal(result.skipped, 0);
    }),
  );

  it.effect("received events appear in getThreadManifest", () =>
    Effect.gen(function* () {
      const syncService = yield* SyncService;

      const event = {
        ...makeThreadEvent("manifest-check-thread", "project-1", "-mc"),
        sequence: 0,
      } as OrchestrationEvent;
      yield* syncService.receiveEvents([event]);

      const manifest = yield* syncService.getThreadManifest();
      const entry = manifest.find((e) => e.threadId === "manifest-check-thread");
      assert.ok(entry !== undefined);
      assert.equal(entry.eventCount, 1);
    }),
  );
});

layer("SyncService — export/receive roundtrip", (it) => {
  it.effect("exported events are treated as duplicates when re-received (idempotency)", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const syncService = yield* SyncService;

      // Store two events for a thread
      yield* eventStore.append(makeThreadEvent("roundtrip-thread", "project-1", "-a"));
      yield* eventStore.append(makeThreadEvent("roundtrip-thread", "project-1", "-b"));

      // Export them
      const exported = yield* syncService.exportThreadEvents("roundtrip-thread");
      assert.equal(exported.length, 2);

      // Re-receive the same events — all must be skipped (idempotent)
      const result = yield* syncService.receiveEvents(exported);
      assert.equal(result.skipped, 2);
      assert.equal(result.accepted, 0);
    }),
  );
});
