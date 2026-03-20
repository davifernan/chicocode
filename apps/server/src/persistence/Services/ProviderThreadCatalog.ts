import { IsoDateTime, ProviderKind, ThreadId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProviderThreadCatalogEntry = Schema.Struct({
  providerKind: ProviderKind,
  workspaceRootCanonical: Schema.String,
  externalSessionId: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  title: Schema.NullOr(Schema.String),
  externalUpdatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
  mirroredExternalUpdatedAt: Schema.NullOr(IsoDateTime),
  mirrorSyncedAt: Schema.NullOr(IsoDateTime),
});
export type ProviderThreadCatalogEntry = typeof ProviderThreadCatalogEntry.Type;

export const ListProviderThreadCatalogByProviderInput = Schema.Struct({
  providerKind: ProviderKind,
});
export type ListProviderThreadCatalogByProviderInput =
  typeof ListProviderThreadCatalogByProviderInput.Type;

export const GetProviderThreadCatalogByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProviderThreadCatalogByThreadIdInput =
  typeof GetProviderThreadCatalogByThreadIdInput.Type;

export const MarkProviderThreadCatalogMirroredInput = Schema.Struct({
  threadId: ThreadId,
  mirroredExternalUpdatedAt: Schema.NullOr(IsoDateTime),
  mirrorSyncedAt: IsoDateTime,
});
export type MarkProviderThreadCatalogMirroredInput =
  typeof MarkProviderThreadCatalogMirroredInput.Type;

export interface ProviderThreadCatalogRepositoryShape {
  readonly upsert: (
    entry: ProviderThreadCatalogEntry,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly listByProviderKind: (
    input: ListProviderThreadCatalogByProviderInput,
  ) => Effect.Effect<ReadonlyArray<ProviderThreadCatalogEntry>, ProjectionRepositoryError>;

  readonly getByThreadId: (
    input: GetProviderThreadCatalogByThreadIdInput,
  ) => Effect.Effect<Option.Option<ProviderThreadCatalogEntry>, ProjectionRepositoryError>;

  readonly markMirrored: (
    input: MarkProviderThreadCatalogMirroredInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProviderThreadCatalogRepository extends ServiceMap.Service<
  ProviderThreadCatalogRepository,
  ProviderThreadCatalogRepositoryShape
>()("t3/persistence/Services/ProviderThreadCatalog/ProviderThreadCatalogRepository") {}
