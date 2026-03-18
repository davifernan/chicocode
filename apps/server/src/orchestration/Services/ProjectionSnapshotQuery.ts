/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  OrchestrationGetThreadMessagesInput,
  OrchestrationReadModel,
  OrchestrationSummaryReadModel,
  OrchestrationThreadMessagesResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest lightweight orchestration projection snapshot.
   *
   * Omits full message history so the UI can hydrate sidebar/project state
   * without transferring every historical chat message.
   */
  readonly getSummarySnapshot: () => Effect.Effect<
    OrchestrationSummaryReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the full message history for a single thread.
   */
  readonly getThreadMessages: (
    input: OrchestrationGetThreadMessagesInput,
  ) => Effect.Effect<OrchestrationThreadMessagesResult, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends ServiceMap.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
