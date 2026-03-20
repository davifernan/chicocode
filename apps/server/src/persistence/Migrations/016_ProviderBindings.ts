import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds provider binding columns to projection_threads and projection_thread_sessions.
 * Uses PRAGMA-based existence checks to be idempotent — safe to run on DBs that already
 * have these columns from a previous migration numbering (e.g. when this was migration 014).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const addColumnIfMissing = (table: string, column: string, definition: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ name: string }>`
        SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}
      `;
      if (rows.length === 0) {
        yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    });

  // projection_threads
  yield* addColumnIfMissing("projection_threads", "provider_kind", "TEXT DEFAULT 'codex'");
  yield* addColumnIfMissing("projection_threads", "source", "TEXT DEFAULT 'native'");
  yield* addColumnIfMissing("projection_threads", "external_session_id", "TEXT");
  yield* addColumnIfMissing("projection_threads", "external_thread_id", "TEXT");
  yield* addColumnIfMissing("projection_threads", "provider_metadata_json", "TEXT");

  // projection_projects
  yield* addColumnIfMissing("projection_projects", "workspace_root_canonical", "TEXT");

  // projection_thread_sessions
  yield* addColumnIfMissing("projection_thread_sessions", "provider_session_id", "TEXT");
  yield* addColumnIfMissing("projection_thread_sessions", "provider_thread_id", "TEXT");

  // provider_thread_catalog (new table — IF NOT EXISTS is already idempotent)
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_thread_catalog (
      provider_kind                TEXT NOT NULL,
      workspace_root_canonical     TEXT NOT NULL,
      external_session_id          TEXT NOT NULL,
      thread_id                    TEXT,
      title                        TEXT,
      external_updated_at          TEXT,
      synced_at                    TEXT NOT NULL,
      PRIMARY KEY (provider_kind, workspace_root_canonical, external_session_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_thread_catalog_thread
    ON provider_thread_catalog(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_thread_catalog_workspace
    ON provider_thread_catalog(provider_kind, workspace_root_canonical)
  `;

  // Backfill existing threads as codex/native
  yield* sql`
    UPDATE projection_threads SET provider_kind = 'codex', source = 'native' WHERE provider_kind IS NULL
  `;
});
