/**
 * ChicoProtoLoader — loads chico.proto once at startup.
 *
 * Uses @grpc/proto-loader to load the proto file at runtime (no codegen).
 * Re-exports typed gRPC service constructors for ChicoEventStream and
 * ChicoActionsClient.
 *
 * @module ChicoProtoLoader
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, "proto", "chico.proto");

const PROTO_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

// ── Loaded once, shared across the process ───────────────────────────

const packageDefinition = protoLoader.loadSync(PROTO_PATH, PROTO_OPTIONS);
const proto = grpc.loadPackageDefinition(packageDefinition) as any;

// ── Typed message shapes (mirrors chico.proto) ───────────────────────

export interface EventStreamInit {
  container_id: string;
  run_id: string;
  project_name: string;
  last_known_seq: string; // proto longs → string via proto-loader
}

export interface AgentEvent {
  seq: string; // proto uint64 → string
  timestamp: string;
  event_type: string;
  source: string;
  worker_id?: number;
  phase: string;
  level: string;
  payload: string;
  run_id: string;
  container_id: string;
  model?: string;
}

export interface EventAck {
  ok: boolean;
}

export interface SubscribeRequest {
  last_known_seq: string;
}

export interface StateQuery {
  query_type: string;
  params: string;
}

export interface StateResponse {
  success: boolean;
  data: string;
}

export interface Action {
  action_type: string;
  target: string;
  payload: string;
  request_id: string;
}

export interface ActionResult {
  success: boolean;
  request_id: string;
  error?: string;
  data?: string;
}

// ── Service constructors ─────────────────────────────────────────────

/**
 * Service definition for implementing the ChicoEventStream gRPC server.
 * T3code implements this service — Chico containers connect to it.
 */
export const ChicoEventStreamService: grpc.ServiceDefinition =
  proto.chico.cloud.ChicoEventStream.service as grpc.ServiceDefinition;

/**
 * Constructor for a ChicoActions gRPC client stub.
 * T3code uses this to query/subscribe to a specific Chico container.
 */
export const ChicoActionsClientCtor: new (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: grpc.ClientOptions,
) => grpc.Client =
  proto.chico.cloud.ChicoActions as new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ClientOptions,
  ) => grpc.Client;
