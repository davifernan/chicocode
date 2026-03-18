import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointSummary,
  OrchestrationCheckpointFile,
  OrchestrationLatestTurn,
  OrchestrationProposedPlan,
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationSummaryReadModel,
  OrchestrationThreadActivity,
  OrchestrationThreadMessagesResult,
  ProjectScript,
  ThreadProviderMetadata,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeSummaryReadModel = Schema.decodeUnknownEffect(OrchestrationSummaryReadModel);
const decodeThreadMessagesResult = Schema.decodeUnknownEffect(OrchestrationThreadMessagesResult);

const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadMessageSummaryDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  messageCount: NonNegativeInt,
  latestMessageAt: Schema.NullOr(IsoDateTime),
});
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    providerMetadata: Schema.NullOr(Schema.fromJsonString(ThreadProviderMetadata)),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
});
const ProjectionStateDbRowSchema = ProjectionState;

type ProjectionProjectDbRow = typeof ProjectionProjectDbRowSchema.Type;
type ProjectionThreadDbRow = typeof ProjectionThreadDbRowSchema.Type;
type ProjectionThreadMessageDbRow = typeof ProjectionThreadMessageDbRowSchema.Type;
type ProjectionThreadProposedPlanDbRow = typeof ProjectionThreadProposedPlanDbRowSchema.Type;
type ProjectionThreadActivityDbRow = typeof ProjectionThreadActivityDbRowSchema.Type;
type ProjectionThreadSessionDbRow = typeof ProjectionThreadSessionDbRowSchema.Type;
type ProjectionCheckpointDbRow = typeof ProjectionCheckpointDbRowSchema.Type;
type ProjectionLatestTurnDbRow = typeof ProjectionLatestTurnDbRowSchema.Type;
type ProjectionStateDbRow = typeof ProjectionStateDbRowSchema.Type;

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string | null): string | null {
  if (right === null) {
    return left;
  }
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(stateRows: ReadonlyArray<ProjectionStateDbRow>): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function rowToMessage(row: ProjectionThreadMessageDbRow) {
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOptionalThreadFields(row: ProjectionThreadDbRow) {
  const optionalFields: {
    provider?: ProjectionThreadDbRow["providerKind"];
    source?: ProjectionThreadDbRow["source"];
    externalSessionId?: ProjectionThreadDbRow["externalSessionId"];
    externalThreadId?: ProjectionThreadDbRow["externalThreadId"];
    providerMetadata?: ProjectionThreadDbRow["providerMetadata"];
  } = {};
  if (row.providerKind !== null) optionalFields.provider = row.providerKind;
  if (row.source !== null) optionalFields.source = row.source;
  if (row.externalSessionId !== null) optionalFields.externalSessionId = row.externalSessionId;
  if (row.externalThreadId !== null) optionalFields.externalThreadId = row.externalThreadId;
  if (row.providerMetadata !== null) optionalFields.providerMetadata = row.providerMetadata;
  return optionalFields;
}

function toLatestTurnState(row: ProjectionLatestTurnDbRow) {
  if (row.state === "error") return "error" as const;
  if (row.state === "interrupted") return "interrupted" as const;
  if (row.state === "completed") return "completed" as const;
  return "running" as const;
}

function buildProjects(projectRows: ReadonlyArray<ProjectionProjectDbRow>) {
  return projectRows.map((row) => ({
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    defaultModel: row.defaultModel,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }));
}

function buildThreadSharedState(input: {
  readonly projectRows: ReadonlyArray<ProjectionProjectDbRow>;
  readonly threadRows: ReadonlyArray<ProjectionThreadDbRow>;
  readonly proposedPlanRows: ReadonlyArray<ProjectionThreadProposedPlanDbRow>;
  readonly activityRows: ReadonlyArray<ProjectionThreadActivityDbRow>;
  readonly sessionRows: ReadonlyArray<ProjectionThreadSessionDbRow>;
  readonly checkpointRows: ReadonlyArray<ProjectionCheckpointDbRow>;
  readonly latestTurnRows: ReadonlyArray<ProjectionLatestTurnDbRow>;
  readonly stateRows: ReadonlyArray<ProjectionStateDbRow>;
}) {
  const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
  const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
  const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
  const sessionsByThread = new Map<string, OrchestrationSession>();
  const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

  let updatedAt: string | null = null;

  for (const row of input.projectRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.threadRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.stateRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.proposedPlanRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
    const threadPlans = proposedPlansByThread.get(row.threadId) ?? [];
    threadPlans.push({
      id: row.planId,
      turnId: row.turnId,
      planMarkdown: row.planMarkdown,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    proposedPlansByThread.set(row.threadId, threadPlans);
  }
  for (const row of input.activityRows) {
    updatedAt = maxIso(updatedAt, row.createdAt);
    const threadActivities = activitiesByThread.get(row.threadId) ?? [];
    threadActivities.push({
      id: row.activityId,
      turnId: row.turnId,
      tone: row.tone,
      kind: row.kind,
      summary: row.summary,
      payload: row.payload,
      ...(row.sequence !== null ? { sequence: row.sequence } : {}),
      createdAt: row.createdAt,
    });
    activitiesByThread.set(row.threadId, threadActivities);
  }
  for (const row of input.checkpointRows) {
    updatedAt = maxIso(updatedAt, row.completedAt);
    const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
    threadCheckpoints.push({
      turnId: row.turnId,
      checkpointTurnCount: row.checkpointTurnCount,
      checkpointRef: row.checkpointRef,
      status: row.status,
      files: row.files,
      assistantMessageId: row.assistantMessageId,
      completedAt: row.completedAt,
    });
    checkpointsByThread.set(row.threadId, threadCheckpoints);
  }
  for (const row of input.latestTurnRows) {
    updatedAt = maxIso(updatedAt, row.requestedAt);
    updatedAt = maxIso(updatedAt, row.startedAt);
    updatedAt = maxIso(updatedAt, row.completedAt);
    if (latestTurnByThread.has(row.threadId)) {
      continue;
    }
    latestTurnByThread.set(row.threadId, {
      turnId: row.turnId,
      state: toLatestTurnState(row),
      requestedAt: row.requestedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      assistantMessageId: row.assistantMessageId,
    });
  }
  for (const row of input.sessionRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
    sessionsByThread.set(row.threadId, {
      threadId: row.threadId,
      status: row.status,
      providerName: row.providerName,
      providerSessionId: row.providerSessionId,
      providerThreadId: row.providerThreadId,
      runtimeMode: row.runtimeMode,
      activeTurnId: row.activeTurnId,
      lastError: row.lastError,
      updatedAt: row.updatedAt,
    });
  }

  return {
    proposedPlansByThread,
    activitiesByThread,
    checkpointsByThread,
    sessionsByThread,
    latestTurnByThread,
    updatedAt,
  };
}

function buildFullThreads(input: {
  readonly threadRows: ReadonlyArray<ProjectionThreadDbRow>;
  readonly messagesByThread: ReadonlyMap<string, Array<ReturnType<typeof rowToMessage>>>;
  readonly proposedPlansByThread: ReadonlyMap<string, unknown[]>;
  readonly activitiesByThread: ReadonlyMap<string, unknown[]>;
  readonly checkpointsByThread: ReadonlyMap<string, unknown[]>;
  readonly sessionsByThread: ReadonlyMap<string, unknown>;
  readonly latestTurnByThread: ReadonlyMap<string, unknown>;
}) {
  return input.threadRows.map((row) => {
    const threadBase = {
      id: row.threadId,
      projectId: row.projectId,
      title: row.title,
      model: row.model,
      runtimeMode: row.runtimeMode,
      interactionMode: row.interactionMode,
      branch: row.branch,
      worktreePath: row.worktreePath,
      latestTurn: input.latestTurnByThread.get(row.threadId) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      messages: input.messagesByThread.get(row.threadId) ?? [],
      proposedPlans: input.proposedPlansByThread.get(row.threadId) ?? [],
      activities: input.activitiesByThread.get(row.threadId) ?? [],
      checkpoints: input.checkpointsByThread.get(row.threadId) ?? [],
      session: input.sessionsByThread.get(row.threadId) ?? null,
    };

    return Object.assign({}, threadBase, toOptionalThreadFields(row));
  });
}

function buildSummaryThreads(input: {
  readonly threadRows: ReadonlyArray<ProjectionThreadDbRow>;
  readonly messageSummaryByThread: ReadonlyMap<
    string,
    { readonly messageCount: number; readonly latestMessageAt: string | null }
  >;
  readonly proposedPlansByThread: ReadonlyMap<string, unknown[]>;
  readonly activitiesByThread: ReadonlyMap<string, unknown[]>;
  readonly checkpointsByThread: ReadonlyMap<string, unknown[]>;
  readonly sessionsByThread: ReadonlyMap<string, unknown>;
  readonly latestTurnByThread: ReadonlyMap<string, unknown>;
}) {
  return input.threadRows.map((row) => {
    const messageSummary = input.messageSummaryByThread.get(row.threadId);
    const threadBase = {
      id: row.threadId,
      projectId: row.projectId,
      title: row.title,
      model: row.model,
      runtimeMode: row.runtimeMode,
      interactionMode: row.interactionMode,
      branch: row.branch,
      worktreePath: row.worktreePath,
      latestTurn: input.latestTurnByThread.get(row.threadId) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      messageCount: messageSummary?.messageCount ?? 0,
      latestMessageAt: messageSummary?.latestMessageAt ?? null,
      proposedPlans: input.proposedPlansByThread.get(row.threadId) ?? [],
      activities: input.activitiesByThread.get(row.threadId) ?? [],
      checkpoints: input.checkpointsByThread.get(row.threadId) ?? [],
      session: input.sessionsByThread.get(row.threadId) ?? null,
    };

    return Object.assign({}, threadBase, toOptionalThreadFields(row));
  });
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model AS "defaultModel",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
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
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadMessagesByThreadId = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ProjectionThread.fields.threadId }),
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadMessageSummaryRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageSummaryDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          COUNT(*) AS "messageCount",
          MAX(updated_at) AS "latestMessageAt"
        FROM projection_thread_messages
        GROUP BY thread_id
        ORDER BY thread_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
                ),
              ),
            ),
            listThreadMessageRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
                ),
              ),
            ),
            listThreadProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listCheckpointRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const sharedState = buildThreadSharedState({
            projectRows,
            threadRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          });
          const messagesByThread = new Map<string, Array<ReturnType<typeof rowToMessage>>>();
          let updatedAt = sharedState.updatedAt;

          for (const row of messageRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadMessages = messagesByThread.get(row.threadId) ?? [];
            threadMessages.push(rowToMessage(row));
            messagesByThread.set(row.threadId, threadMessages);
          }

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects: buildProjects(projectRows),
            threads: buildFullThreads({
              threadRows,
              messagesByThread,
              proposedPlansByThread: sharedState.proposedPlansByThread,
              activitiesByThread: sharedState.activitiesByThread,
              checkpointsByThread: sharedState.checkpointsByThread,
              sessionsByThread: sharedState.sessionsByThread,
              latestTurnByThread: sharedState.latestTurnByThread,
            }),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getSummarySnapshot: ProjectionSnapshotQueryShape["getSummarySnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            threadRows,
            messageSummaryRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listProjects:decodeRows",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreads:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreads:decodeRows",
                ),
              ),
            ),
            listThreadMessageSummaryRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreadMessageSummaries:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreadMessageSummaries:decodeRows",
                ),
              ),
            ),
            listThreadProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreadActivities:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreadActivities:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listCheckpointRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listCheckpoints:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSummarySnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSummarySnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const sharedState = buildThreadSharedState({
            projectRows,
            threadRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          });
          const messageSummaryByThread = new Map<
            string,
            { readonly messageCount: number; readonly latestMessageAt: string | null }
          >();
          let updatedAt = sharedState.updatedAt;

          for (const row of messageSummaryRows) {
            updatedAt = maxIso(updatedAt, row.latestMessageAt);
            messageSummaryByThread.set(row.threadId, {
              messageCount: row.messageCount,
              latestMessageAt: row.latestMessageAt,
            });
          }

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects: buildProjects(projectRows),
            threads: buildSummaryThreads({
              threadRows,
              messageSummaryByThread,
              proposedPlansByThread: sharedState.proposedPlansByThread,
              activitiesByThread: sharedState.activitiesByThread,
              checkpointsByThread: sharedState.checkpointsByThread,
              sessionsByThread: sharedState.sessionsByThread,
              latestTurnByThread: sharedState.latestTurnByThread,
            }),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeSummaryReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getSummarySnapshot:decodeReadModel",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSummarySnapshot:query")(error);
        }),
      );

  const getThreadMessages: ProjectionSnapshotQueryShape["getThreadMessages"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const messageRows = yield* listThreadMessagesByThreadId(input).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadMessages:listThreadMessages:query",
                "ProjectionSnapshotQuery.getThreadMessages:listThreadMessages:decodeRows",
              ),
            ),
          );

          let latestMessageAt: string | null = null;
          const messages = messageRows.map((row) => {
            latestMessageAt = maxIso(latestMessageAt, row.updatedAt);
            return rowToMessage(row);
          });

          return yield* decodeThreadMessagesResult({
            threadId: input.threadId,
            messageCount: messageRows.length,
            latestMessageAt,
            messages,
          }).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getThreadMessages:decodeThreadMessagesResult",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadMessages:query")(error);
        }),
      );

  return {
    getSnapshot,
    getSummarySnapshot,
    getThreadMessages,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
