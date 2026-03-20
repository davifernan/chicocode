import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  SyncCursorRow,
  SyncCursorRepository,
  type SyncCursorRepositoryShape,
} from "../Services/SyncCursor.ts";

const GetByThreadIdRequest = Schema.Struct({
  remoteFingerprint: Schema.String,
  threadId: Schema.String,
});

const ListByRemoteRequest = Schema.Struct({
  remoteFingerprint: Schema.String,
});

const makeSyncCursorRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: SyncCursorRow,
    execute: (row) =>
      sql`
        INSERT INTO sync_cursors (
          remote_fingerprint,
          thread_id,
          last_synced_sequence,
          last_synced_at
        )
        VALUES (
          ${row.remoteFingerprint},
          ${row.threadId},
          ${row.lastSyncedSequence},
          ${row.lastSyncedAt}
        )
        ON CONFLICT (remote_fingerprint, thread_id)
        DO UPDATE SET
          last_synced_sequence = excluded.last_synced_sequence,
          last_synced_at = excluded.last_synced_at
      `,
  });

  const getByThreadIdRow = SqlSchema.findOneOption({
    Request: GetByThreadIdRequest,
    Result: SyncCursorRow,
    execute: ({ remoteFingerprint, threadId }) =>
      sql`
        SELECT
          remote_fingerprint AS "remoteFingerprint",
          thread_id AS "threadId",
          last_synced_sequence AS "lastSyncedSequence",
          last_synced_at AS "lastSyncedAt"
        FROM sync_cursors
        WHERE remote_fingerprint = ${remoteFingerprint}
          AND thread_id = ${threadId}
      `,
  });

  const listByRemoteRows = SqlSchema.findAll({
    Request: ListByRemoteRequest,
    Result: SyncCursorRow,
    execute: ({ remoteFingerprint }) =>
      sql`
        SELECT
          remote_fingerprint AS "remoteFingerprint",
          thread_id AS "threadId",
          last_synced_sequence AS "lastSyncedSequence",
          last_synced_at AS "lastSyncedAt"
        FROM sync_cursors
        WHERE remote_fingerprint = ${remoteFingerprint}
      `,
  });

  const upsert: SyncCursorRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(Effect.mapError(toPersistenceSqlError("SyncCursorRepository.upsert")));

  const getByThreadId: SyncCursorRepositoryShape["getByThreadId"] = (remoteFingerprint, threadId) =>
    getByThreadIdRow({ remoteFingerprint, threadId }).pipe(
      Effect.mapError(toPersistenceSqlError("SyncCursorRepository.getByThreadId")),
      Effect.map((opt) => (opt._tag === "Some" ? opt.value : null)),
    );

  const listByRemote: SyncCursorRepositoryShape["listByRemote"] = (remoteFingerprint) =>
    listByRemoteRows({ remoteFingerprint }).pipe(
      Effect.mapError(toPersistenceSqlError("SyncCursorRepository.listByRemote")),
    );

  return { upsert, getByThreadId, listByRemote } satisfies SyncCursorRepositoryShape;
});

export const SyncCursorRepositoryLive = Layer.effect(
  SyncCursorRepository,
  makeSyncCursorRepository,
);
