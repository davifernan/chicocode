/**
 * ChicoGrpcServer — T3code acts as the Chico Cloud Controller.
 *
 * Implements the `ChicoEventStream` gRPC service so that Chico containers
 * can connect by setting:
 *   CHICO_GRPC_ENDPOINT=http://<t3code-host>:<CHICO_GRPC_PORT>
 *
 * Each container identifies itself via `EventStreamInit.run_id` and
 * `container_id`.  Multiple containers can connect simultaneously — each
 * gets its own `ChicoRunSession` in the registry.
 *
 * Protocol recap (chico.proto):
 *   - `StreamEvents(EventStreamInit) → stream AgentEvent`
 *       Chico opens a long-lived stream; T3code keeps it open as a
 *       keepalive channel (no events are currently sent back).
 *   - `ReportEvent(AgentEvent) → EventAck`
 *       Every OrchestratorEvent is sent as a separate unary call.
 *
 * @module ChicoGrpcServer
 */

import * as grpc from "@grpc/grpc-js";
import type { ServerUnaryCall, ServerWritableStream, sendUnaryData } from "@grpc/grpc-js";

import {
  ChicoEventStreamService,
  type AgentEvent,
  type EventAck,
  type EventStreamInit,
} from "./ChicoProtoLoader.ts";
import { chicoRunRegistry } from "./ChicoRunRegistry.ts";

const DEFAULT_GRPC_PORT = 50099;

// ── Service implementation ────────────────────────────────────────────

/**
 * `StreamEvents` — Chico opens this to identify the run and keep the
 * connection alive.  We register the run and hold the stream open.
 * When the stream closes (client disconnects / process dies) we mark
 * the run as disconnected.
 */
function handleStreamEvents(call: ServerWritableStream<EventStreamInit, AgentEvent>): void {
  const init = call.request as EventStreamInit;

  if (!init.run_id) {
    call.destroy(new Error("Missing run_id in EventStreamInit"));
    return;
  }

  chicoRunRegistry.registerRun(init);
  console.log(
    `[ChicoGrpcServer] Run connected: run_id=${init.run_id} container_id=${init.container_id}`,
  );

  call.on("cancelled", () => {
    chicoRunRegistry.disconnectRun(init.run_id);
    console.log(`[ChicoGrpcServer] Run disconnected (cancelled): ${init.run_id}`);
  });

  call.on("error", () => {
    chicoRunRegistry.disconnectRun(init.run_id);
    console.log(`[ChicoGrpcServer] Run disconnected (error): ${init.run_id}`);
  });

  // Keep stream open — don't call call.end() here.
  // Chico uses this connection as a keepalive; T3code may later send
  // control messages back via this stream.
}

/**
 * `ReportEvent` — Chico sends one AgentEvent per OrchestratorEvent.
 * We apply it to the session and acknowledge immediately.
 */
function handleReportEvent(
  call: ServerUnaryCall<AgentEvent, EventAck>,
  cb: sendUnaryData<EventAck>,
): void {
  const event = call.request as AgentEvent;
  chicoRunRegistry.applyEvent(event);
  cb(null, { ok: true });
}

// ── Server class ──────────────────────────────────────────────────────

export class ChicoGrpcServer {
  private server: grpc.Server | null = null;
  private _port = DEFAULT_GRPC_PORT;

  get port(): number {
    return this._port;
  }

  /**
   * Start the gRPC server on the given port.
   * Reads `CHICO_GRPC_PORT` env first, then falls back to the argument,
   * then to the default (50099).
   */
  start(port?: number): Promise<void> {
    const resolvedPort =
      (Number(process.env["CHICO_GRPC_PORT"] ?? "") || port) ?? DEFAULT_GRPC_PORT;
    this._port = resolvedPort;

    this.server = new grpc.Server();

    this.server.addService(ChicoEventStreamService, {
      streamEvents: handleStreamEvents,
      reportEvent: handleReportEvent,
    });

    return new Promise((resolve, reject) => {
      this.server!.bindAsync(
        `0.0.0.0:${resolvedPort}`,
        grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => {
          if (err) {
            reject(err);
            return;
          }
          this._port = boundPort;
          console.log(`[ChicoGrpcServer] Listening on port ${boundPort}`);
          resolve();
        },
      );
    });
  }

  /**
   * Gracefully shut down the gRPC server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.tryShutdown((err) => {
        if (err) {
          this.server?.forceShutdown();
        }
        this.server = null;
        resolve();
      });
    });
  }
}

// ── Module-level singleton ────────────────────────────────────────────

export const chicoGrpcServer = new ChicoGrpcServer();
