import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds mirror-state tracking columns to provider_thread_catalog.
 * Uses PRAGMA-based existence checks to be idempotent — safe to run on DBs that already
 * have these columns from a previous migration numbering (e.g. when this was migration 016).
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

  yield* addColumnIfMissing("provider_thread_catalog", "mirrored_external_updated_at", "TEXT");
  yield* addColumnIfMissing("provider_thread_catalog", "mirror_synced_at", "TEXT");
});
