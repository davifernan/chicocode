import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sync_cursors (
      remote_fingerprint   TEXT    NOT NULL,
      thread_id            TEXT    NOT NULL,
      last_synced_sequence INTEGER NOT NULL,
      last_synced_at       TEXT    NOT NULL,
      PRIMARY KEY (remote_fingerprint, thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sync_cursors_remote
    ON sync_cursors(remote_fingerprint)
  `;
});
