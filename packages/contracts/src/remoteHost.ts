import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

// ── Remote Host Config ───────────────────────────────────────────────

export const RemoteHostConfig = Schema.Struct({
  host: TrimmedNonEmptyString,
  sshPort: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sshUser: TrimmedNonEmptyString,
  sshKeyPath: Schema.String,
  sshPassword: Schema.NullOr(Schema.String),
  remoteServerPort: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  remoteAuthToken: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
});
export type RemoteHostConfig = typeof RemoteHostConfig.Type;

// ── Connection Step ──────────────────────────────────────────────────

export const RemoteConnectionStep = Schema.Literals([
  "ssh-connect",
  "port-test",
  "t3-handshake",
  "auth",
]);
export type RemoteConnectionStep = typeof RemoteConnectionStep.Type;

// ── Connection Status ────────────────────────────────────────────────

export const RemoteConnectionStatus = Schema.Struct({
  status: Schema.Literals(["disconnected", "connecting", "connected", "error"]),
  step: Schema.NullOr(RemoteConnectionStep),
  tunnelWsUrl: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  connectedAt: Schema.NullOr(IsoDateTime),
});
export type RemoteConnectionStatus = typeof RemoteConnectionStatus.Type;

// ── Test Connection Step Result ──────────────────────────────────────

export const RemoteConnectionStepResult = Schema.Struct({
  step: RemoteConnectionStep,
  ok: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  hint: Schema.NullOr(Schema.String),
});
export type RemoteConnectionStepResult = typeof RemoteConnectionStepResult.Type;

export const TestRemoteConnectionResult = Schema.Struct({
  steps: Schema.Array(RemoteConnectionStepResult),
  success: Schema.Boolean,
});
export type TestRemoteConnectionResult = typeof TestRemoteConnectionResult.Type;

// ── Sync Types ───────────────────────────────────────────────────────

export const SyncThreadManifestEntry = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  maxStreamVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  eventCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SyncThreadManifestEntry = typeof SyncThreadManifestEntry.Type;

export const SyncPushResult = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  accepted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  diverged: Schema.Boolean,
});
export type SyncPushResult = typeof SyncPushResult.Type;

export const SyncReceiveResult = Schema.Struct({
  accepted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SyncReceiveResult = typeof SyncReceiveResult.Type;

export const RemoteSyncStatus = Schema.Struct({
  status: Schema.Literals(["idle", "syncing", "done", "error"]),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pushed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  diverged: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type RemoteSyncStatus = typeof RemoteSyncStatus.Type;

// ── Server Metrics ────────────────────────────────────────────────────

/** Live OS metrics pushed by the server every ~5 s to all WS clients. */
export const RemoteServerMetrics = Schema.Struct({
  /** Approximate CPU utilisation 0–100. Derived from 1-min load average. */
  cpuPercent: Schema.Number,
  /** Memory utilisation 0–100. Derived from (1 - freemem/totalmem). */
  memPercent: Schema.Number,
  /** Raw 1-minute load average from os.loadavg(). */
  loadAvg1: Schema.Number,
});
export type RemoteServerMetrics = typeof RemoteServerMetrics.Type;
