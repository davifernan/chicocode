/**
 * SshTunnelManager - Manages an SSH tunnel process for remote host connectivity.
 *
 * Spawns `ssh -N -L <localPort>:localhost:<remotePort> <user>@<host>` and
 * monitors the process lifecycle. On unexpected exit, performs exponential
 * backoff reconnect. The local port is reserved dynamically at construction
 * time to avoid conflicts.
 *
 * @module SshTunnelManager
 */
import net from "node:net";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { RemoteHostConfig } from "@t3tools/contracts";
import { Data, Effect, ServiceMap } from "effect";

// ── Errors ───────────────────────────────────────────────────────────

export class SshTunnelError extends Data.TaggedError("SshTunnelError")<{
  readonly cause: string;
}> {}

// ── Status ───────────────────────────────────────────────────────────

export type TunnelStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "running"; readonly localPort: number }
  | { readonly kind: "error"; readonly cause: string };

// ── Service interface ─────────────────────────────────────────────────

export interface SshTunnelManagerShape {
  readonly start: (
    config: RemoteHostConfig,
  ) => Effect.Effect<{ localPort: number }, SshTunnelError>;
  readonly stop: () => Effect.Effect<void>;
  readonly getStatus: () => TunnelStatus;
}

export class SshTunnelManager extends ServiceMap.Service<SshTunnelManager, SshTunnelManagerShape>()(
  "t3/remoteHost/Services/SshTunnelManager",
) {}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Reserve a free local port by binding a temporary server and letting the OS
 * assign an ephemeral port. We close the server immediately and return the
 * port number so the caller can use it before anything else binds it.
 */
const reserveFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Could not get port from server address")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 8;

// ── Implementation factory ────────────────────────────────────────────

export const makeSshTunnelManager = (): SshTunnelManagerShape => {
  let status: TunnelStatus = { kind: "idle" };
  let currentProcess: ChildProcess | null = null;
  let stopRequested = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (currentProcess !== null) {
      currentProcess.removeAllListeners();
      currentProcess.kill("SIGTERM");
      currentProcess = null;
    }
  };

  const spawnTunnel = (config: RemoteHostConfig, localPort: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const args: string[] = [
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-L",
        `${localPort}:localhost:${config.remoteServerPort}`,
        "-p",
        String(config.sshPort),
      ];

      if (config.sshKeyPath.trim().length > 0) {
        args.push("-i", config.sshKeyPath);
      }

      args.push(`${config.sshUser}@${config.host}`);

      const proc = spawn("ssh", args, { stdio: "ignore" });
      currentProcess = proc;

      // Give SSH a moment to connect before resolving
      const readyTimer = setTimeout(() => {
        if (proc === currentProcess) {
          status = { kind: "running", localPort };
          reconnectAttempt = 0;
          resolve();
        }
      }, 2_000);

      proc.on("error", (err) => {
        clearTimeout(readyTimer);
        status = { kind: "error", cause: err.message };
        reject(new Error(err.message));
      });

      proc.on("close", (code) => {
        clearTimeout(readyTimer);
        // Only reject the initial promise if we haven't resolved yet
        // (i.e., code < 0 or we died before the ready timer fired)
        if (status.kind === "starting") {
          status = { kind: "error", cause: `SSH exited with code ${String(code)}` };
          reject(new Error(`SSH exited with code ${String(code)}`));
        } else if (!stopRequested) {
          // Tunnel died after being established — schedule reconnect
          status = {
            kind: "error",
            cause: `SSH tunnel died (code ${String(code)}), reconnecting…`,
          };
          scheduleReconnect(config, localPort);
        }
      });
    });

  let reconnectConfig: RemoteHostConfig | null = null;
  let reconnectLocalPort = 0;

  const scheduleReconnect = (config: RemoteHostConfig, localPort: number) => {
    if (stopRequested) return;
    reconnectConfig = config;
    reconnectLocalPort = localPort;
    reconnectAttempt += 1;
    if (reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
      status = { kind: "error", cause: "Max SSH reconnect attempts reached" };
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      if (stopRequested || reconnectConfig === null) return;
      void spawnTunnel(reconnectConfig, reconnectLocalPort);
    }, delay);
  };

  const start: SshTunnelManagerShape["start"] = (config) =>
    Effect.tryPromise({
      try: async () => {
        stopRequested = false;
        cleanup();
        status = { kind: "starting" };
        const localPort = await reserveFreePort();
        await spawnTunnel(config, localPort);
        return { localPort };
      },
      catch: (err) =>
        new SshTunnelError({
          cause: err instanceof Error ? err.message : String(err),
        }),
    });

  const stop: SshTunnelManagerShape["stop"] = () =>
    Effect.sync(() => {
      stopRequested = true;
      cleanup();
      status = { kind: "idle" };
    });

  const getStatus: SshTunnelManagerShape["getStatus"] = () => status;

  return { start, stop, getStatus };
};
