import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetUiStateInput,
  UiStateEntry,
  UiStateRepository,
  type UiStateRepositoryShape,
} from "../Services/UiState.ts";

const makeUiStateRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertUiStateRow = SqlSchema.void({
    Request: UiStateEntry,
    execute: (row) =>
      sql`
        INSERT INTO ui_state (
          state_key,
          value_json,
          updated_at
        )
        VALUES (
          ${row.key},
          ${row.valueJson},
          ${row.updatedAt}
        )
        ON CONFLICT (state_key)
        DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `,
  });

  const getUiStateRow = SqlSchema.findOneOption({
    Request: GetUiStateInput,
    Result: UiStateEntry,
    execute: ({ key }) =>
      sql`
        SELECT
          state_key AS "key",
          value_json AS "valueJson",
          updated_at AS "updatedAt"
        FROM ui_state
        WHERE state_key = ${key}
      `,
  });

  const upsert: UiStateRepositoryShape["upsert"] = (row) =>
    upsertUiStateRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("UiStateRepository.upsert:query")),
    );

  const getByKey: UiStateRepositoryShape["getByKey"] = (input) =>
    getUiStateRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("UiStateRepository.getByKey:query")),
    );

  return {
    upsert,
    getByKey,
  } satisfies UiStateRepositoryShape;
});

export const UiStateRepositoryLive = Layer.effect(UiStateRepository, makeUiStateRepository);
