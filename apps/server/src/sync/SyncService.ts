/**
 * SyncService - Thread-level event-log sync between local and remote T3 servers.
 *
 * Implements three operations used by the client-orchestrated sync protocol:
 *
 *  getThreadManifest()        - Summarises all local threads (for comparison)
 *  exportThreadEvents(id)     - Returns all events for a single thread
 *  receiveEvents(events)      - Idempotently appends incoming events to the local store
 *
 * All three methods work on whichever server instance they're called on. The
 * web client calls getThreadManifest + exportThreadEvents on the LOCAL server
 * and receiveEvents on the REMOTE server (via the tunnel transport).
 *
 * @module SyncService
 */
import type {
  OrchestrationEvent,
  SyncReceiveResult,
  SyncThreadManifestEntry,
} from "@t3tools/contracts";
import { Effect, Layer, ServiceMap, Stream } from "effect";

import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { SyncCursorRepository } from "../persistence/Services/SyncCursor.ts";

// ── Service interface ─────────────────────────────────────────────────

export interface SyncServiceShape {
  /**
   * Returns one entry per thread found in the local event store, including:
   * - maxStreamVersion: highest stream_version for the thread (divergence key)
   * - eventCount: total number of events (progress tracking)
   */
  readonly getThreadManifest: () => Effect.Effect<SyncThreadManifestEntry[]>;

  /**
   * Returns all events for a given thread, ordered by sequence ascending.
   * Used by the web client to collect events before pushing to remote.
   */
  readonly exportThreadEvents: (threadId: string) => Effect.Effect<OrchestrationEvent[]>;

  /**
   * Appends a batch of events to the local event store.
   *
   * Event-id uniqueness in the DB guarantees idempotency:
   *   - If an event with the same event_id already exists, the DB silently skips it.
   *   - accepted = events successfully written
   *   - skipped  = events whose event_id already existed (duplicates)
   */
  readonly receiveEvents: (events: OrchestrationEvent[]) => Effect.Effect<SyncReceiveResult>;
}

export class SyncService extends ServiceMap.Service<SyncService, SyncServiceShape>()(
  "t3/sync/SyncService",
) {}

// ── Implementation ────────────────────────────────────────────────────

export const makeSyncService = Effect.gen(function* () {
  const eventStore = yield* OrchestrationEventStore;
  // SyncCursorRepository is available for Phase 3 delta-sync — not used here yet
  yield* SyncCursorRepository;

  const getThreadManifest: SyncServiceShape["getThreadManifest"] = () =>
    Stream.runCollect(eventStore.readAll()).pipe(
      Effect.map((events) => {
        const byThread = new Map<string, { maxStreamVersion: number; eventCount: number }>();
        for (const event of events) {
          // Only track thread-level aggregates (not project-level)
          if (event.aggregateKind !== "thread") continue;
          const threadId = event.aggregateId;
          const existing = byThread.get(threadId);
          // Use sequence as a proxy for stream_version for divergence detection
          const ver = event.sequence;
          byThread.set(threadId, {
            maxStreamVersion: existing ? Math.max(existing.maxStreamVersion, ver) : ver,
            eventCount: (existing?.eventCount ?? 0) + 1,
          });
        }
        return Array.from(byThread.entries()).map(
          ([threadId, { maxStreamVersion, eventCount }]): SyncThreadManifestEntry => ({
            threadId,
            maxStreamVersion,
            eventCount,
          }),
        );
      }),
      Effect.orDie,
    );

  const exportThreadEvents: SyncServiceShape["exportThreadEvents"] = (threadId) =>
    Stream.runCollect(
      Stream.filter(eventStore.readAll(), (event) => event.aggregateId === threadId),
    ).pipe(
      Effect.map((chunk) => Array.from(chunk)),
      Effect.orDie,
    );

  const receiveEvents: SyncServiceShape["receiveEvents"] = (events) =>
    Effect.gen(function* () {
      let accepted = 0;
      let skipped = 0;

      for (const event of events) {
        const result = yield* eventStore
          .append({
            eventId: event.eventId,
            aggregateKind: event.aggregateKind,
            aggregateId: event.aggregateId,
            type: event.type,
            causationEventId: event.causationEventId,
            correlationId: event.correlationId,
            commandId: event.commandId,
            occurredAt: event.occurredAt,
            payload: event.payload,
            metadata: event.metadata,
          })
          .pipe(
            Effect.map(() => "accepted" as const),
            Effect.catch(() => Effect.succeed("skipped" as const)),
          );

        if (result === "accepted") {
          accepted += 1;
        } else {
          skipped += 1;
        }
      }

      return { accepted, skipped } satisfies SyncReceiveResult;
    });

  return { getThreadManifest, exportThreadEvents, receiveEvents } satisfies SyncServiceShape;
});

export const SyncServiceLive = Layer.effect(SyncService, makeSyncService);
