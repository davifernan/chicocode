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
 *       Chico opens a long-lived stream. T3code must write keepalive
 *       ServerPing events every ~20s — Chico's tonic client has a 30s
 *       per-RPC deadline that will kill the stream otherwise, causing
 *       the ~30s reconnect loop seen in logs.
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
 * Interval in ms between keepalive pings on the StreamEvents stream.
 *
 * Chico's tonic gRPC client sets a 30-second per-RPC deadline
 * (client.rs:65). If T3Code sends nothing on the stream for 30s the
 * client kills the call and immediately reconnects, producing the
 * "Run disconnected / Run connected" loop visible in the logs.
 *
 * Sending a synthetic ServerPing event every 20s (matching what
 * grpc_test_server.rs does) resets the deadline and keeps the
 * stream alive indefinitely.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * `StreamEvents` — Chico opens this to identify the run and keep the
 * connection alive.  We register the run, send keepalive pings every
 * 20s, and mark the run disconnected when the stream closes.
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

  // Send a ServerPing every 20s to prevent Chico's 30s RPC deadline
  // from killing the stream and causing a reconnect loop.
  const keepalive = setInterval(() => {
    try {
      call.write({
        seq: "0",
        timestamp: new Date().toISOString(),
        event_type: "ServerPing",
        source: "t3code",
        phase: "",
        level: "debug",
        payload: "{}",
        run_id: init.run_id,
        container_id: init.container_id ?? "",
      });
    } catch {
      // Stream may have closed between the tick and the write — ignore.
    }
  }, KEEPALIVE_INTERVAL_MS);

  const cleanup = () => clearInterval(keepalive);

  call.on("cancelled", () => {
    cleanup();
    chicoRunRegistry.disconnectRun(init.run_id);
    console.log(`[ChicoGrpcServer] Run disconnected (cancelled): ${init.run_id}`);
  });

  call.on("error", () => {
    cleanup();
    chicoRunRegistry.disconnectRun(init.run_id);
    console.log(`[ChicoGrpcServer] Run disconnected (error): ${init.run_id}`);
  });

  // Do NOT call call.end() — keep the stream open.
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
  console.log(
    `[ChicoGrpcServer] ReportEvent: run=${event.run_id} seq=${event.seq} type=${event.event_type}`,
  );
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
