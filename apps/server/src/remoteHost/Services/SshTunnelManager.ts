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

/**
 * Poll the local port with TCP connection attempts until it accepts connections
 * or the deadline is reached. SSH sets up the local listener for `-L` forwarding
 * only after the full SSH handshake is complete, so we need to probe rather than
 * use a blind `setTimeout`.
 */
const waitForLocalPortReady = (port: number, maxWaitMs = 30_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + maxWaitMs;
    const attempt = () => {
      const socket = new net.Socket();
      const onConnected = () => {
        socket.destroy();
        resolve();
      };
      const onFail = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(
            new Error(`SSH tunnel local port ${port} did not become ready within ${maxWaitMs}ms`),
          );
          return;
        }
        setTimeout(attempt, 250);
      };
      socket.setTimeout(1_000);
      socket.once("connect", onConnected);
      socket.once("error", onFail);
      socket.once("timeout", onFail);
      socket.connect(port, "127.0.0.1");
    };
    attempt();
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

      // Guard against double-settling (process exit can race with port-ready check)
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) {
          status = { kind: "error", cause: err.message };
          reject(err);
        } else {
          status = { kind: "running", localPort };
          reconnectAttempt = 0;
          resolve();
        }
      };

      proc.on("error", (err) => {
        settle(new Error(err.message));
      });

      proc.on("close", (code) => {
        if (!settled) {
          // SSH exited before the tunnel was established
          settle(new Error(`SSH exited with code ${String(code)}`));
        } else if (!stopRequested) {
          // Tunnel died after being established — schedule reconnect
          status = {
            kind: "error",
            cause: `SSH tunnel died (code ${String(code)}), reconnecting…`,
          };
          scheduleReconnect(config, localPort);
        }
      });

      // Poll the local port until SSH sets up the -L listener. This replaces the
      // previous blind 2-second setTimeout, which was too short on slow networks
      // and caused "Transport did not connect" errors on the client side.
      waitForLocalPortReady(localPort, 30_000)
        .then(() => {
          if (proc === currentProcess) {
            settle();
          }
        })
        .catch((err: unknown) => {
          settle(err instanceof Error ? err : new Error(String(err)));
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
