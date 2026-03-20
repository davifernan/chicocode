import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE provider_thread_catalog ADD COLUMN mirrored_external_updated_at TEXT
  `;

  yield* sql`
    ALTER TABLE provider_thread_catalog ADD COLUMN mirror_synced_at TEXT
  `;
});
