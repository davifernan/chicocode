import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type { ServerConfig, ServerGetUiStateInput, ServerGetUiStateResult } from "./server";
import type {
  RemoteConnectionStatus,
  RemoteHostConfig,
  RemoteServerMetrics,
  RemoteSyncStatus,
  SyncReceiveResult,
  SyncThreadManifestEntry,
  TestRemoteConnectionResult,
} from "./remoteHost";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type {
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  ServerUpsertUiStateInput,
} from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetThreadMessagesInput,
  OrchestrationGetThreadMessagesResult,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationSummaryReadModel,
} from "./orchestration";
import { EditorId } from "./editor";
import type {
  DevServerGetLogsInput,
  DevServerGetStatusInput,
  DevServerInfo,
  DevServerLogLinePayload,
  DevServerStartInput,
  DevServerStopInput,
} from "./devServer";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  /**
   * Open the dev-logs popout window (or bring it to the foreground if already open).
   * Creates the window directly from the main process — does NOT use window.open().
   */
  openOrFocusDevLogsPopout: () => Promise<void>;
  openOrFocusDevServerPreview: (targetUrl: string) => Promise<void>;
  updateDevServerPreviewUrl: (targetUrl: string | null) => Promise<void>;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    getUiState: (input: ServerGetUiStateInput) => Promise<ServerGetUiStateResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    upsertUiState: (input: ServerUpsertUiStateInput) => Promise<void>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationSummaryReadModel>;
    getThreadMessages: (
      input: OrchestrationGetThreadMessagesInput,
    ) => Promise<OrchestrationGetThreadMessagesResult>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
  devServer: {
    start: (input: DevServerStartInput) => Promise<DevServerInfo>;
    restart: (input: DevServerStartInput) => Promise<DevServerInfo>;
    stop: (input: DevServerStopInput) => Promise<void>;
    stopAll: () => Promise<void>;
    getStatus: (input: DevServerGetStatusInput) => Promise<DevServerInfo>;
    getStatuses: () => Promise<DevServerInfo[]>;
    getLogs: (input: DevServerGetLogsInput) => Promise<string[]>;
    onStatusChanged: (callback: (info: DevServerInfo) => void) => () => void;
    onLogLine: (callback: (payload: DevServerLogLinePayload) => void) => () => void;
  };
  remoteHost: {
    setConfig: (config: RemoteHostConfig | null) => Promise<void>;
    testConnection: (config: RemoteHostConfig) => Promise<TestRemoteConnectionResult>;
    onConnectionStatus: (callback: (status: RemoteConnectionStatus) => void) => () => void;
    onSyncStatus: (callback: (status: RemoteSyncStatus) => void) => () => void;
    onMetrics: (callback: (metrics: RemoteServerMetrics) => void) => () => void;
  };
  sync: {
    getThreadManifest: () => Promise<{ threads: SyncThreadManifestEntry[] }>;
    /** Export all events for a thread. The caller is responsible for sending them to the remote. */
    exportThreadEvents: (threadId: string) => Promise<{ events: OrchestrationEvent[] }>;
    /** Receive and idempotently append events from a sync peer. */
    receiveEvents: (events: OrchestrationEvent[]) => Promise<SyncReceiveResult>;
  };
  opencode: {
    forkSession: (input: {
      /** T3 thread id — the server resolves the live session from this. */
      threadId: string;
      /** Optional hint: explicit OpenCode session id if the caller already knows it. */
      sessionId?: string | undefined;
      messageId?: string | undefined;
      directory?: string | undefined;
    }) => Promise<{ forkedSessionId: string; title: string }>;
  };
}
