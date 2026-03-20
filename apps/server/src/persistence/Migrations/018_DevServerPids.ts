import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS dev_server_pids (
      project_id TEXT    NOT NULL PRIMARY KEY,
      pid        INTEGER NOT NULL,
      pgid       INTEGER,
      cwd        TEXT    NOT NULL,
      started_at TEXT    NOT NULL
    )
  `;
});
