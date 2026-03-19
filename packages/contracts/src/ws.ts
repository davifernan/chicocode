import { Schema, Struct } from "effect";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import {
  RemoteConnectionStatus,
  RemoteHostConfig,
  RemoteServerMetrics,
  RemoteSyncStatus,
} from "./remoteHost";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  ORCHESTRATION_WS_CHANNELS,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetThreadMessagesInput,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsInput,
} from "./orchestration";
import {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitCreateWorktreeInput,
  GitInitInput,
  GitListBranchesInput,
  GitPullInput,
  GitPullRequestRefInput,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitStatusInput,
} from "./git";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "./terminal";
import { KeybindingRule } from "./keybindings";
import { ProjectSearchEntriesInput, ProjectWriteFileInput } from "./project";
import { OpenInEditorInput } from "./editor";
import {
  ServerConfigUpdatedPayload,
  ServerGetUiStateInput,
  ServerUpsertUiStateInput,
} from "./server";
import {
  DEV_SERVER_WS_CHANNELS,
  DEV_SERVER_WS_METHODS,
  DevServerGetLogsInput,
  DevServerGetStatusInput,
  DevServerLogLinePayload,
  DevServerStartInput,
  DevServerStatusChangedPayload,
  DevServerStopInput,
} from "./devServer";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitStatus: "git.status",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverGetUiState: "server.getUiState",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverUpsertUiState: "server.upsertUiState",

  // Remote host
  serverSetRemoteHostConfig: "server.setRemoteHostConfig",
  serverTestRemoteConnection: "server.testRemoteConnection",

  // Sync — client-orchestrated protocol:
  //   1. call syncGetThreadManifest on LOCAL to get local thread list
  //   2. call syncGetThreadManifest on REMOTE to get remote thread list
  //   3. for each thread only on local: call syncExportThreadEvents on LOCAL
  //   4. call syncReceiveEvents on REMOTE with the exported events
  syncGetThreadManifest: "sync.getThreadManifest",
  syncExportThreadEvents: "sync.exportThreadEvents",
  syncReceiveEvents: "sync.receiveEvents",

  // Dev server
  devServerStart: DEV_SERVER_WS_METHODS.start,
  devServerStop: DEV_SERVER_WS_METHODS.stop,
  devServerGetStatus: DEV_SERVER_WS_METHODS.getStatus,
  devServerGetStatuses: DEV_SERVER_WS_METHODS.getStatuses,
  devServerGetLogs: DEV_SERVER_WS_METHODS.getLogs,
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  terminalEvent: "terminal.event",
  serverWelcome: "server.welcome",
  serverConfigUpdated: "server.configUpdated",
  serverRemoteConnectionStatus: "server.remoteConnectionStatus",
  serverRemoteSyncStatus: "server.remoteSyncStatus",
  serverMetrics: "server.metrics",
  devServerStatusChanged: DEV_SERVER_WS_CHANNELS.statusChanged,
  devServerLogLine: DEV_SERVER_WS_CHANNELS.logLine,
} as const;

// -- Tagged Union of all request body schemas ─────────────────────────

const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(
    Struct.assign({ _tag: Schema.tag(tag) }),
    // PreserveChecks is safe here. No existing schema should have checks depending on the tag
    { unsafePreserveChecks: true },
  );

const WebSocketRequestBody = Schema.Union([
  // Orchestration methods
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    Schema.Struct({ command: ClientOrchestrationCommand }),
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getSnapshot, OrchestrationGetSnapshotInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getThreadMessages, OrchestrationGetThreadMessagesInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getTurnDiff, OrchestrationGetTurnDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getFullThreadDiff, OrchestrationGetFullThreadDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.replayEvents, OrchestrationReplayEventsInput),

  // Project Search
  tagRequestBody(WS_METHODS.projectsSearchEntries, ProjectSearchEntriesInput),
  tagRequestBody(WS_METHODS.projectsWriteFile, ProjectWriteFileInput),

  // Shell methods
  tagRequestBody(WS_METHODS.shellOpenInEditor, OpenInEditorInput),

  // Git methods
  tagRequestBody(WS_METHODS.gitPull, GitPullInput),
  tagRequestBody(WS_METHODS.gitStatus, GitStatusInput),
  tagRequestBody(WS_METHODS.gitRunStackedAction, GitRunStackedActionInput),
  tagRequestBody(WS_METHODS.gitListBranches, GitListBranchesInput),
  tagRequestBody(WS_METHODS.gitCreateWorktree, GitCreateWorktreeInput),
  tagRequestBody(WS_METHODS.gitRemoveWorktree, GitRemoveWorktreeInput),
  tagRequestBody(WS_METHODS.gitCreateBranch, GitCreateBranchInput),
  tagRequestBody(WS_METHODS.gitCheckout, GitCheckoutInput),
  tagRequestBody(WS_METHODS.gitInit, GitInitInput),
  tagRequestBody(WS_METHODS.gitResolvePullRequest, GitPullRequestRefInput),
  tagRequestBody(WS_METHODS.gitPreparePullRequestThread, GitPreparePullRequestThreadInput),

  // Terminal methods
  tagRequestBody(WS_METHODS.terminalOpen, TerminalOpenInput),
  tagRequestBody(WS_METHODS.terminalWrite, TerminalWriteInput),
  tagRequestBody(WS_METHODS.terminalResize, TerminalResizeInput),
  tagRequestBody(WS_METHODS.terminalClear, TerminalClearInput),
  tagRequestBody(WS_METHODS.terminalRestart, TerminalRestartInput),
  tagRequestBody(WS_METHODS.terminalClose, TerminalCloseInput),

  // Server meta
  tagRequestBody(WS_METHODS.serverGetConfig, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverGetUiState, ServerGetUiStateInput),
  tagRequestBody(WS_METHODS.serverUpsertKeybinding, KeybindingRule),
  tagRequestBody(WS_METHODS.serverUpsertUiState, ServerUpsertUiStateInput),

  // Remote host
  tagRequestBody(
    WS_METHODS.serverSetRemoteHostConfig,
    Schema.Struct({ config: Schema.NullOr(RemoteHostConfig) }),
  ),
  tagRequestBody(
    WS_METHODS.serverTestRemoteConnection,
    Schema.Struct({ config: RemoteHostConfig }),
  ),

  // Sync
  tagRequestBody(WS_METHODS.syncGetThreadManifest, Schema.Struct({})),
  tagRequestBody(
    WS_METHODS.syncExportThreadEvents,
    Schema.Struct({ threadId: TrimmedNonEmptyString }),
  ),
  tagRequestBody(
    WS_METHODS.syncReceiveEvents,
    Schema.Struct({ events: Schema.Array(OrchestrationEvent) }),
  ),

  // Dev server
  tagRequestBody(WS_METHODS.devServerStart, DevServerStartInput),
  tagRequestBody(WS_METHODS.devServerStop, DevServerStopInput),
  tagRequestBody(WS_METHODS.devServerGetStatus, DevServerGetStatusInput),
  tagRequestBody(WS_METHODS.devServerGetStatuses, Schema.Struct({})),
  tagRequestBody(WS_METHODS.devServerGetLogs, DevServerGetLogsInput),
]);

export const WebSocketRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: WebSocketRequestBody,
});
export type WebSocketRequest = typeof WebSocketRequest.Type;

export const WebSocketResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type WebSocketResponse = typeof WebSocketResponse.Type;

export const WsPushSequence = NonNegativeInt;
export type WsPushSequence = typeof WsPushSequence.Type;

export const WsWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type WsWelcomePayload = typeof WsWelcomePayload.Type;

export interface WsPushPayloadByChannel {
  readonly [WS_CHANNELS.serverWelcome]: WsWelcomePayload;
  readonly [WS_CHANNELS.serverConfigUpdated]: typeof ServerConfigUpdatedPayload.Type;
  readonly [WS_CHANNELS.terminalEvent]: typeof TerminalEvent.Type;
  readonly [ORCHESTRATION_WS_CHANNELS.domainEvent]: OrchestrationEvent;
  readonly [WS_CHANNELS.serverRemoteConnectionStatus]: RemoteConnectionStatus;
  readonly [WS_CHANNELS.serverRemoteSyncStatus]: RemoteSyncStatus;
  readonly [WS_CHANNELS.serverMetrics]: RemoteServerMetrics;
  readonly [WS_CHANNELS.devServerStatusChanged]: DevServerStatusChangedPayload;
  readonly [WS_CHANNELS.devServerLogLine]: DevServerLogLinePayload;
}

export type WsPushChannel = keyof WsPushPayloadByChannel;
export type WsPushData<C extends WsPushChannel> = WsPushPayloadByChannel[C];

const makeWsPushSchema = <const Channel extends string, Payload extends Schema.Schema<any>>(
  channel: Channel,
  payload: Payload,
) =>
  Schema.Struct({
    type: Schema.Literal("push"),
    sequence: WsPushSequence,
    channel: Schema.Literal(channel),
    data: payload,
  });

export const WsPushServerWelcome = makeWsPushSchema(WS_CHANNELS.serverWelcome, WsWelcomePayload);
export const WsPushServerConfigUpdated = makeWsPushSchema(
  WS_CHANNELS.serverConfigUpdated,
  ServerConfigUpdatedPayload,
);
export const WsPushTerminalEvent = makeWsPushSchema(WS_CHANNELS.terminalEvent, TerminalEvent);
export const WsPushOrchestrationDomainEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  OrchestrationEvent,
);
export const WsPushRemoteConnectionStatus = makeWsPushSchema(
  WS_CHANNELS.serverRemoteConnectionStatus,
  RemoteConnectionStatus,
);
export const WsPushRemoteSyncStatus = makeWsPushSchema(
  WS_CHANNELS.serverRemoteSyncStatus,
  RemoteSyncStatus,
);
export const WsPushServerMetrics = makeWsPushSchema(WS_CHANNELS.serverMetrics, RemoteServerMetrics);
export const WsPushDevServerStatusChanged = makeWsPushSchema(
  WS_CHANNELS.devServerStatusChanged,
  DevServerStatusChangedPayload,
);
export const WsPushDevServerLogLine = makeWsPushSchema(
  WS_CHANNELS.devServerLogLine,
  DevServerLogLinePayload,
);

export const WsPushChannelSchema = Schema.Literals([
  WS_CHANNELS.serverWelcome,
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.terminalEvent,
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  WS_CHANNELS.serverRemoteConnectionStatus,
  WS_CHANNELS.serverRemoteSyncStatus,
  WS_CHANNELS.serverMetrics,
  WS_CHANNELS.devServerStatusChanged,
  WS_CHANNELS.devServerLogLine,
]);
export type WsPushChannelSchema = typeof WsPushChannelSchema.Type;

export const WsPush = Schema.Union([
  WsPushServerWelcome,
  WsPushServerConfigUpdated,
  WsPushTerminalEvent,
  WsPushOrchestrationDomainEvent,
  WsPushRemoteConnectionStatus,
  WsPushRemoteSyncStatus,
  WsPushServerMetrics,
  WsPushDevServerStatusChanged,
  WsPushDevServerLogLine,
]);
export type WsPush = typeof WsPush.Type;

export type WsPushMessage<C extends WsPushChannel> = Extract<WsPush, { channel: C }>;

export const WsPushEnvelopeBase = Schema.Struct({
  type: Schema.Literal("push"),
  sequence: WsPushSequence,
  channel: WsPushChannelSchema,
  data: Schema.Unknown,
});
export type WsPushEnvelopeBase = typeof WsPushEnvelopeBase.Type;

// ── Union of all server → client messages ─────────────────────────────

export const WsResponse = Schema.Union([WebSocketResponse, WsPush]);
export type WsResponse = typeof WsResponse.Type;
