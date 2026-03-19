/**
 * RemoteHostService - Orchestrates SSH tunnel lifecycle and publishes
 * RemoteConnectionStatus to all connected WebSocket clients.
 *
 * Responsibilities:
 *  - Apply / clear a RemoteHostConfig
 *  - Coordinate SshTunnelManager to open/close the tunnel
 *  - Hold authoritative RemoteConnectionStatus in a Ref
 *  - Expose a PubSub stream so wsServer can forward status pushes
 *
 * @module RemoteHostService
 */
import type { RemoteConnectionStatus, RemoteHostConfig } from "@t3tools/contracts";
import { Effect, PubSub, Ref, ServiceMap, Stream } from "effect";

import { SshTunnelManager } from "./SshTunnelManager.ts";
import { testConnection } from "./ConnectionChecker.ts";

// ── Service interface ─────────────────────────────────────────────────

export interface RemoteHostServiceShape {
  readonly applyConfig: (config: RemoteHostConfig | null) => Effect.Effect<void>;
  readonly getConnectionStatus: () => Effect.Effect<RemoteConnectionStatus>;
  readonly subscribeToStatus: () => Stream.Stream<RemoteConnectionStatus>;
}

export class RemoteHostService extends ServiceMap.Service<
  RemoteHostService,
  RemoteHostServiceShape
>()("t3/remoteHost/Services/RemoteHostService") {}

// ── Disconnected sentinel ─────────────────────────────────────────────

const DISCONNECTED: RemoteConnectionStatus = {
  status: "disconnected",
  step: null,
  tunnelWsUrl: null,
  error: null,
  connectedAt: null,
};

// ── Implementation factory ────────────────────────────────────────────

export const makeRemoteHostService = Effect.gen(function* () {
  const tunnelManager = yield* SshTunnelManager;
  const statusRef = yield* Ref.make<RemoteConnectionStatus>(DISCONNECTED);
  const statusPubSub = yield* PubSub.unbounded<RemoteConnectionStatus>();

  const publish = (status: RemoteConnectionStatus) =>
    Effect.all([Ref.set(statusRef, status), PubSub.publish(statusPubSub, status)]).pipe(
      Effect.asVoid,
    );

  const applyConfig: RemoteHostServiceShape["applyConfig"] = (config) =>
    Effect.gen(function* () {
      // Stop any existing tunnel first
      yield* tunnelManager.stop();
      yield* publish(DISCONNECTED);

      if (config === null || !config.enabled) {
        return;
      }

      // Transition to connecting
      yield* publish({
        status: "connecting",
        step: "ssh-connect",
        tunnelWsUrl: null,
        error: null,
        connectedAt: null,
      });

      // Run pre-flight check (ssh-connect step only — no tunnel yet)
      const preCheck = yield* testConnection(config, null);
      const sshStep = preCheck.steps.find((s) => s.step === "ssh-connect");
      if (!preCheck.success || (sshStep && !sshStep.ok)) {
        yield* publish({
          status: "error",
          step: "ssh-connect",
          tunnelWsUrl: null,
          error: sshStep?.error ?? "SSH connection pre-check failed",
          connectedAt: null,
        });
        return;
      }

      // Open tunnel
      yield* publish({
        status: "connecting",
        step: "port-test",
        tunnelWsUrl: null,
        error: null,
        connectedAt: null,
      });

      const tunnelResult = yield* tunnelManager.start(config).pipe(Effect.mapError((err) => err));

      const tunnelWsUrl = `ws://127.0.0.1:${tunnelResult.localPort}`;

      // Verify full path through tunnel
      yield* publish({
        status: "connecting",
        step: "t3-handshake",
        tunnelWsUrl: null,
        error: null,
        connectedAt: null,
      });

      const fullCheck = yield* testConnection(config, tunnelResult.localPort);
      if (!fullCheck.success) {
        const failedStep = fullCheck.steps.find((s) => !s.ok);
        yield* tunnelManager.stop();
        yield* publish({
          status: "error",
          step: failedStep?.step ?? "t3-handshake",
          tunnelWsUrl: null,
          error: failedStep?.error ?? "Connection check failed",
          connectedAt: null,
        });
        return;
      }

      yield* publish({
        status: "connected",
        step: null,
        tunnelWsUrl,
        error: null,
        connectedAt: new Date().toISOString(),
      });
    }).pipe(
      Effect.catch((err: unknown) =>
        publish({
          status: "error",
          step: null,
          tunnelWsUrl: null,
          error: err instanceof Error ? err.message : String(err),
          connectedAt: null,
        }),
      ),
    );

  const getConnectionStatus: RemoteHostServiceShape["getConnectionStatus"] = () =>
    Ref.get(statusRef);

  const subscribeToStatus: RemoteHostServiceShape["subscribeToStatus"] = () =>
    Stream.fromPubSub(statusPubSub);

  return {
    applyConfig,
    getConnectionStatus,
    subscribeToStatus,
  } satisfies RemoteHostServiceShape;
});
