import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import { ThreadProviderMetadata } from "@t3tools/contracts";

// DB row schema: provider_metadata_json is stored as a JSON string (or NULL)
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    providerMetadata: Schema.NullOr(Schema.fromJsonString(ThreadProviderMetadata)),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRowSchema.Type;

function rowToProjectionThread(row: ProjectionThreadDbRow): ProjectionThread {
  return {
    ...row,
    providerMetadata: row.providerMetadata ?? null,
  };
}

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) => {
      const metadataJson =
        row.providerMetadata !== null ? JSON.stringify(row.providerMetadata) : null;
      return sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          runtime_mode,
          interaction_mode,
          provider_kind,
          source,
          external_session_id,
          external_thread_id,
          branch,
          worktree_path,
          provider_metadata_json,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${row.model},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.providerKind},
          ${row.source},
          ${row.externalSessionId},
          ${row.externalThreadId},
          ${row.branch},
          ${row.worktreePath},
          ${metadataJson},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model = excluded.model,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          provider_kind = excluded.provider_kind,
          source = excluded.source,
          external_session_id = excluded.external_session_id,
          external_thread_id = excluded.external_thread_id,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          provider_metadata_json = excluded.provider_metadata_json,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `;
    },
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          provider_kind AS "providerKind",
          source,
          external_session_id AS "externalSessionId",
          external_thread_id AS "externalThreadId",
          branch,
          worktree_path AS "worktreePath",
          provider_metadata_json AS "providerMetadata",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          provider_kind AS "providerKind",
          source,
          external_session_id AS "externalSessionId",
          external_thread_id AS "externalThreadId",
          branch,
          worktree_path AS "worktreePath",
          provider_metadata_json AS "providerMetadata",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.map((option) => Option.map(option, rowToProjectionThread)),
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.map((rows) => rows.map(rowToProjectionThread)),
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
