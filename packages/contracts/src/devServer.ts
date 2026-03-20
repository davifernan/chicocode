import { Schema } from "effect";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas";

// ── Dev Server Status ────────────────────────────────────────────────

export const DevServerStatus = Schema.Literals(["idle", "starting", "running", "stopped", "error"]);
export type DevServerStatus = typeof DevServerStatus.Type;

export const DevServerErrorCode = Schema.Literals([
  "lock-held",
  "port-in-use",
  "missing-dev-script",
  "process-exited",
  "spawn-failed",
]);
export type DevServerErrorCode = typeof DevServerErrorCode.Type;

// ── Dev Server Info ──────────────────────────────────────────────────

export const DevServerInfo = Schema.Struct({
  projectId: ProjectId,
  status: DevServerStatus,
  packageManager: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Int),
  error: Schema.optional(Schema.String),
  errorCode: Schema.optional(DevServerErrorCode),
  recoveryHint: Schema.optional(Schema.String),
  conflictingPid: Schema.optional(Schema.Int),
  conflictingPort: Schema.optional(Schema.Int),
  conflictingPath: Schema.optional(Schema.String),
});
export type DevServerInfo = typeof DevServerInfo.Type;

// ── Push Payloads ────────────────────────────────────────────────────

export const DevServerStatusChangedPayload = DevServerInfo;
export type DevServerStatusChangedPayload = typeof DevServerStatusChangedPayload.Type;

export const DevServerLogLinePayload = Schema.Struct({
  projectId: ProjectId,
  line: Schema.String,
  stream: Schema.Literals(["stdout", "stderr"]),
});
export type DevServerLogLinePayload = typeof DevServerLogLinePayload.Type;

// ── RPC Input Schemas ────────────────────────────────────────────────

export const DevServerStartInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
});
export type DevServerStartInput = typeof DevServerStartInput.Type;

export const DevServerRestartInput = DevServerStartInput;
export type DevServerRestartInput = typeof DevServerRestartInput.Type;

export const DevServerStopInput = Schema.Struct({
  projectId: ProjectId,
});
export type DevServerStopInput = typeof DevServerStopInput.Type;

export const DevServerGetStatusInput = Schema.Struct({
  projectId: ProjectId,
});
export type DevServerGetStatusInput = typeof DevServerGetStatusInput.Type;

export const DevServerGetLogsInput = Schema.Struct({
  projectId: ProjectId,
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type DevServerGetLogsInput = typeof DevServerGetLogsInput.Type;

// getStatuses takes no input — uses Schema.Struct({})

// ── WS Channel Names ─────────────────────────────────────────────────

export const DEV_SERVER_WS_CHANNELS = {
  statusChanged: "devServer.statusChanged",
  logLine: "devServer.logLine",
} as const;

export const DEV_SERVER_WS_METHODS = {
  start: "devServer.start",
  restart: "devServer.restart",
  stop: "devServer.stop",
  stopAll: "devServer.stopAll",
  getStatus: "devServer.getStatus",
  getStatuses: "devServer.getStatuses",
  getLogs: "devServer.getLogs",
} as const;
