import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Add provider binding columns to projection_threads
  yield* sql`
    ALTER TABLE projection_threads ADD COLUMN provider_kind TEXT DEFAULT 'codex'
  `;

  yield* sql`
    ALTER TABLE projection_threads ADD COLUMN source TEXT DEFAULT 'native'
  `;

  yield* sql`
    ALTER TABLE projection_threads ADD COLUMN external_session_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads ADD COLUMN external_thread_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads ADD COLUMN provider_metadata_json TEXT
  `;

  // Add canonical workspace root to projection_projects
  yield* sql`
    ALTER TABLE projection_projects ADD COLUMN workspace_root_canonical TEXT
  `;

  // Create provider thread catalog for discovery deduplication
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_thread_catalog (
      provider_kind TEXT NOT NULL,
      workspace_root_canonical TEXT NOT NULL,
      external_session_id TEXT NOT NULL,
      thread_id TEXT,
      title TEXT,
      external_updated_at TEXT,
      synced_at TEXT NOT NULL,
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
