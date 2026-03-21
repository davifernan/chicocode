/**
 * Chico contracts — types, WS methods and push channels for the
 * Chico Observability Zentrale.
 *
 * T3code acts as the Chico Cloud Controller: Chico containers connect
 * via gRPC (`ChicoEventStream` service) and T3code bridges events to the
 * browser through these WebSocket channels.
 */

import { Schema } from "effect";

// ── Worker snapshot ──────────────────────────────────────────────────

export const ChicoWorkerLifecycle = Schema.Literals([
  "declared",
  "starting",
  "running",
  "idle",
  "completed",
  "failed",
  "aborted",
  "stopped",
]);
export type ChicoWorkerLifecycle = typeof ChicoWorkerLifecycle.Type;

export const ChicoWorkerSnapshot = Schema.Struct({
  id: Schema.Int,
  label: Schema.String,
  lifecycle: ChicoWorkerLifecycle,
  activity: Schema.String,
  cost: Schema.Number,
  steps: Schema.Int,
  model: Schema.String,
  elapsedMs: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
});
export type ChicoWorkerSnapshot = typeof ChicoWorkerSnapshot.Type;

// ── Serialized event (ring buffer entry) ─────────────────────────────

export const ChicoSerializedEvent = Schema.Struct({
  seq: Schema.Number,
  timestamp: Schema.String,
  event_type: Schema.String,
  source: Schema.String,
  worker_id: Schema.optional(Schema.Int),
  phase: Schema.String,
  level: Schema.String,
  payload: Schema.String,
  run_id: Schema.String,
});
export type ChicoSerializedEvent = typeof ChicoSerializedEvent.Type;

// ── Run status ───────────────────────────────────────────────────────

export const ChicoRunStatus = Schema.Literals(["active", "disconnected"]);
export type ChicoRunStatus = typeof ChicoRunStatus.Type;

// ── Run snapshot ─────────────────────────────────────────────────────

export const ChicoRunSnapshot = Schema.Struct({
  runId: Schema.String,
  containerId: Schema.String,
  projectName: Schema.String,
  status: ChicoRunStatus,
  phase: Schema.String,
  workers: Schema.Array(ChicoWorkerSnapshot),
  totalCostUsd: Schema.Number,
  recentEvents: Schema.Array(ChicoSerializedEvent),
  connectedAt: Schema.String,
  lastEventAt: Schema.NullOr(Schema.String),
  lastKnownSeq: Schema.Number,
});
export type ChicoRunSnapshot = typeof ChicoRunSnapshot.Type;

// ── Server info ──────────────────────────────────────────────────────

export const ChicoServerInfo = Schema.Struct({
  grpcPort: Schema.Int,
  grpcHost: Schema.String,
  /** Full endpoint string the user should pass to Chico containers */
  endpoint: Schema.String,
});
export type ChicoServerInfo = typeof ChicoServerInfo.Type;

// ── Push payloads ────────────────────────────────────────────────────

/** Emitted when a new Chico run connects via gRPC */
export const ChicoRunRegisteredPayload = ChicoRunSnapshot;
export type ChicoRunRegisteredPayload = typeof ChicoRunRegisteredPayload.Type;

/** Emitted when a Chico run's gRPC stream closes */
export const ChicoRunDisconnectedPayload = Schema.Struct({
  runId: Schema.String,
});
export type ChicoRunDisconnectedPayload = typeof ChicoRunDisconnectedPayload.Type;

/** Emitted on every incoming AgentEvent for live event-stream display */
export const ChicoRunEventPayload = Schema.Struct({
  runId: Schema.String,
  event: ChicoSerializedEvent,
});
export type ChicoRunEventPayload = typeof ChicoRunEventPayload.Type;

/** Debounced state snapshot after event processing */
export const ChicoRunStateUpdatePayload = Schema.Struct({
  runId: Schema.String,
  snapshot: ChicoRunSnapshot,
});
export type ChicoRunStateUpdatePayload = typeof ChicoRunStateUpdatePayload.Type;

// ── RPC input schemas ────────────────────────────────────────────────

/** No-input — returns ChicoServerInfo */
export const ChicoGetServerInfoInput = Schema.Struct({});
export type ChicoGetServerInfoInput = typeof ChicoGetServerInfoInput.Type;

/** No-input — returns ChicoRunSnapshot[] */
export const ChicoGetRunsInput = Schema.Struct({});
export type ChicoGetRunsInput = typeof ChicoGetRunsInput.Type;

/** Returns ChicoRunSnapshot for a specific run */
export const ChicoGetRunStateInput = Schema.Struct({
  runId: Schema.String,
});
export type ChicoGetRunStateInput = typeof ChicoGetRunStateInput.Type;

// ── WS channel names ─────────────────────────────────────────────────

export const CHICO_WS_CHANNELS = {
  /** A new Chico run connected */
  runRegistered: "chico.runRegistered",
  /** A Chico run disconnected */
  runDisconnected: "chico.runDisconnected",
  /** Live AgentEvent from a run */
  runEvent: "chico.runEvent",
  /** Debounced state snapshot after events are applied */
  runStateUpdate: "chico.runStateUpdate",
} as const;

export const CHICO_WS_METHODS = {
  /** Returns ChicoServerInfo (port, host, endpoint hint) */
  getServerInfo: "chico.getServerInfo",
  /** Returns ChicoRunSnapshot[] for all known runs */
  getRuns: "chico.getRuns",
  /** Returns ChicoRunSnapshot for one run */
  getRunState: "chico.getRunState",
} as const;
