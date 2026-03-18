/**
 * UiStateRepository - Persistence interface for UI state blobs.
 *
 * Stores web-renderer preferences that should survive dev restarts and origin
 * changes by living in the shared server SQLite database instead of browser
 * localStorage.
 *
 * @module UiStateRepository
 */
import { IsoDateTime, ServerUiStateKey } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const UiStateEntry = Schema.Struct({
  key: ServerUiStateKey,
  valueJson: Schema.String,
  updatedAt: IsoDateTime,
});
export type UiStateEntry = typeof UiStateEntry.Type;

export const GetUiStateInput = Schema.Struct({
  key: ServerUiStateKey,
});
export type GetUiStateInput = typeof GetUiStateInput.Type;

export interface UiStateRepositoryShape {
  readonly upsert: (row: UiStateEntry) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByKey: (
    input: GetUiStateInput,
  ) => Effect.Effect<Option.Option<UiStateEntry>, ProjectionRepositoryError>;
}

export class UiStateRepository extends ServiceMap.Service<
  UiStateRepository,
  UiStateRepositoryShape
>()("t3/persistence/Services/UiState/UiStateRepository") {}
