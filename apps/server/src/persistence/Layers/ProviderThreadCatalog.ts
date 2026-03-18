import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProviderThreadCatalogByThreadIdInput,
  ListProviderThreadCatalogByProviderInput,
  MarkProviderThreadCatalogMirroredInput,
  ProviderThreadCatalogEntry,
  ProviderThreadCatalogRepository,
  type ProviderThreadCatalogRepositoryShape,
} from "../Services/ProviderThreadCatalog.ts";

const makeProviderThreadCatalogRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProviderThreadCatalogEntry = SqlSchema.void({
    Request: ProviderThreadCatalogEntry,
    execute: (entry) =>
      sql`
        INSERT INTO provider_thread_catalog (
          provider_kind,
          workspace_root_canonical,
          external_session_id,
          thread_id,
          title,
          external_updated_at,
          synced_at,
          mirrored_external_updated_at,
          mirror_synced_at
        )
        VALUES (
          ${entry.providerKind},
          ${entry.workspaceRootCanonical},
          ${entry.externalSessionId},
          ${entry.threadId},
          ${entry.title},
          ${entry.externalUpdatedAt},
          ${entry.syncedAt},
          ${entry.mirroredExternalUpdatedAt},
          ${entry.mirrorSyncedAt}
        )
        ON CONFLICT (provider_kind, workspace_root_canonical, external_session_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          title = excluded.title,
          external_updated_at = excluded.external_updated_at,
          synced_at = excluded.synced_at,
          mirrored_external_updated_at = COALESCE(
            excluded.mirrored_external_updated_at,
            provider_thread_catalog.mirrored_external_updated_at
          ),
          mirror_synced_at = COALESCE(
            excluded.mirror_synced_at,
            provider_thread_catalog.mirror_synced_at
          )
      `,
  });

  const listProviderThreadCatalogEntries = SqlSchema.findAll({
    Request: ListProviderThreadCatalogByProviderInput,
    Result: ProviderThreadCatalogEntry,
    execute: ({ providerKind }) =>
      sql`
        SELECT
          provider_kind AS "providerKind",
          workspace_root_canonical AS "workspaceRootCanonical",
          external_session_id AS "externalSessionId",
          thread_id AS "threadId",
          title,
          external_updated_at AS "externalUpdatedAt",
          synced_at AS "syncedAt",
          mirrored_external_updated_at AS "mirroredExternalUpdatedAt",
          mirror_synced_at AS "mirrorSyncedAt"
        FROM provider_thread_catalog
        WHERE provider_kind = ${providerKind}
        ORDER BY synced_at DESC, external_session_id ASC
      `,
  });

  const getProviderThreadCatalogEntryByThreadId = SqlSchema.findOneOption({
    Request: GetProviderThreadCatalogByThreadIdInput,
    Result: ProviderThreadCatalogEntry,
    execute: ({ threadId }) =>
      sql`
        SELECT
          provider_kind AS "providerKind",
          workspace_root_canonical AS "workspaceRootCanonical",
          external_session_id AS "externalSessionId",
          thread_id AS "threadId",
          title,
          external_updated_at AS "externalUpdatedAt",
          synced_at AS "syncedAt",
          mirrored_external_updated_at AS "mirroredExternalUpdatedAt",
          mirror_synced_at AS "mirrorSyncedAt"
        FROM provider_thread_catalog
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const markProviderThreadCatalogMirrored = SqlSchema.void({
    Request: MarkProviderThreadCatalogMirroredInput,
    execute: ({ threadId, mirroredExternalUpdatedAt, mirrorSyncedAt }) =>
      sql`
        UPDATE provider_thread_catalog
        SET
          mirrored_external_updated_at = ${mirroredExternalUpdatedAt},
          mirror_synced_at = ${mirrorSyncedAt}
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProviderThreadCatalogRepositoryShape["upsert"] = (entry) =>
    upsertProviderThreadCatalogEntry(entry).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderThreadCatalogRepository.upsert:query")),
    );

  const listByProviderKind: ProviderThreadCatalogRepositoryShape["listByProviderKind"] = (input) =>
    listProviderThreadCatalogEntries(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderThreadCatalogRepository.listByProviderKind:query"),
      ),
    );

  const getByThreadId: ProviderThreadCatalogRepositoryShape["getByThreadId"] = (input) =>
    getProviderThreadCatalogEntryByThreadId(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderThreadCatalogRepository.getByThreadId:query")),
    );

  const markMirrored: ProviderThreadCatalogRepositoryShape["markMirrored"] = (input) =>
    markProviderThreadCatalogMirrored(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderThreadCatalogRepository.markMirrored:query")),
    );

  return {
    upsert,
    listByProviderKind,
    getByThreadId,
    markMirrored,
  } satisfies ProviderThreadCatalogRepositoryShape;
});

export const ProviderThreadCatalogRepositoryLive = Layer.effect(
  ProviderThreadCatalogRepository,
  makeProviderThreadCatalogRepository,
);
