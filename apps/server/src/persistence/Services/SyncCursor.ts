/**
 * SyncCursorRepository - Persists the last-synced sequence per remote+thread.
 *
 * Used in Phase 3 (incremental delta-sync) to track which events have already
 * been pushed to a given remote fingerprint so only new events need to be sent.
 *
 * @module SyncCursorRepository
 */
import { IsoDateTime } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

// ── Row schema ────────────────────────────────────────────────────────

export const SyncCursorRow = Schema.Struct({
  /** "host:port" fingerprint of the remote server */
  remoteFingerprint: Schema.String,
  threadId: Schema.String,
  lastSyncedSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastSyncedAt: IsoDateTime,
});
export type SyncCursorRow = typeof SyncCursorRow.Type;

// ── Service interface ─────────────────────────────────────────────────

export interface SyncCursorRepositoryShape {
  readonly upsert: (row: SyncCursorRow) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByThreadId: (
    remoteFingerprint: string,
    threadId: string,
  ) => Effect.Effect<SyncCursorRow | null, ProjectionRepositoryError>;
  readonly listByRemote: (
    remoteFingerprint: string,
  ) => Effect.Effect<SyncCursorRow[], ProjectionRepositoryError>;
}

export class SyncCursorRepository extends ServiceMap.Service<
  SyncCursorRepository,
  SyncCursorRepositoryShape
>()("t3/persistence/Services/SyncCursor/SyncCursorRepository") {}
