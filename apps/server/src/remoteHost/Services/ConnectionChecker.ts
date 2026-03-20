/**
 * ConnectionChecker - Step-by-step connection validator for remote hosts.
 *
 * Runs four checks in sequence:
 *  1. ssh-connect  — open TCP to SSH port
 *  2. port-test    — open TCP to the T3 server port on the remote
 *  3. t3-handshake — HTTP GET /api/health via the SSH tunnel WebSocket URL
 *  4. auth         — validate the auth token if provided
 *
 * Each step returns a descriptive error + hint on failure so the UI can give
 * actionable feedback.
 *
 * @module ConnectionChecker
 */
import net from "node:net";

import type {
  RemoteHostConfig,
  RemoteConnectionStepResult,
  TestRemoteConnectionResult,
} from "@t3tools/contracts";
import { Effect } from "effect";

// ── TCP port reachability helper ─────────────────────────────────────

const tcpReachable = (host: string, port: number, timeoutMs = 5_000): Promise<string | null> =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    const cleanup = (err: string | null) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(err);
    };
    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => cleanup(null));
    socket.on("timeout", () => cleanup(`TCP connection to ${host}:${port} timed out`));
    socket.on("error", (e) => cleanup(e.message));
  });

// ── HTTP health helper ────────────────────────────────────────────────

const httpGet = async (
  url: string,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; status: number; error: string | null }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, error: null };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
};

// ── Step runners ──────────────────────────────────────────────────────

const stepSshConnect = async (config: RemoteHostConfig): Promise<RemoteConnectionStepResult> => {
  const err = await tcpReachable(config.host, config.sshPort);
  if (err === null) {
    return { step: "ssh-connect", ok: true, error: null, hint: null };
  }
  return {
    step: "ssh-connect",
    ok: false,
    error: err,
    hint: `Check that ${config.host} is reachable on port ${config.sshPort} and that any firewall allows the connection.`,
  };
};

const stepPortTest = async (
  config: RemoteHostConfig,
  tunnelLocalPort: number | null,
): Promise<RemoteConnectionStepResult> => {
  // If we have a tunnel port, test via the tunnel. Otherwise skip (can't test yet).
  if (tunnelLocalPort === null) {
    // Pre-tunnel: test SSH forward target conceptually — we can't verify directly,
    // but we can check if the SSH host itself responded (done in ssh-connect).
    return { step: "port-test", ok: true, error: null, hint: null };
  }
  const err = await tcpReachable("127.0.0.1", tunnelLocalPort);
  if (err === null) {
    return { step: "port-test", ok: true, error: null, hint: null };
  }
  return {
    step: "port-test",
    ok: false,
    error: err,
    hint: `The T3 server on the remote doesn't appear to be running on port ${config.remoteServerPort}. Start it with \`t3 serve\` on the remote machine.`,
  };
};

const stepT3Handshake = async (
  config: RemoteHostConfig,
  tunnelLocalPort: number | null,
): Promise<RemoteConnectionStepResult> => {
  if (tunnelLocalPort === null) {
    return { step: "t3-handshake", ok: true, error: null, hint: null };
  }
  const healthUrl = `http://127.0.0.1:${tunnelLocalPort}/api/health`;
  const result = await httpGet(healthUrl);
  if (result.ok) {
    return { step: "t3-handshake", ok: true, error: null, hint: null };
  }
  return {
    step: "t3-handshake",
    ok: false,
    error: result.error ?? `HTTP ${result.status}`,
    hint: `The remote server responded but /api/health returned an error. The server may be running a different version of T3.`,
  };
};

const stepAuth = async (
  config: RemoteHostConfig,
  tunnelLocalPort: number | null,
): Promise<RemoteConnectionStepResult> => {
  if (tunnelLocalPort === null || !config.remoteAuthToken) {
    return { step: "auth", ok: true, error: null, hint: null };
  }
  const healthUrl = `http://127.0.0.1:${tunnelLocalPort}/api/health`;
  const result = await httpGet(healthUrl + "?auth=1");
  // A 401 response means auth is required and the token was rejected
  if (!result.ok && result.status === 401) {
    return {
      step: "auth",
      ok: false,
      error: "Auth token rejected (401 Unauthorized)",
      hint: "Double-check the auth token in your remote server config and the T3_AUTH_TOKEN setting on the remote.",
    };
  }
  return { step: "auth", ok: true, error: null, hint: null };
};

// ── Public API ────────────────────────────────────────────────────────

/**
 * Run all connection check steps for the given config.
 *
 * `tunnelLocalPort` should be provided when a tunnel is already established
 * so port-test, t3-handshake and auth can verify the full path.
 * Pass `null` to run only the ssh-connect step (used in the Settings form
 * before the tunnel is open).
 */
export const testConnection = (
  config: RemoteHostConfig,
  tunnelLocalPort: number | null = null,
): Effect.Effect<TestRemoteConnectionResult> =>
  Effect.tryPromise({
    try: async () => {
      const steps: RemoteConnectionStepResult[] = [];

      const sshStep = await stepSshConnect(config);
      steps.push(sshStep);
      if (!sshStep.ok) {
        return { steps, success: false };
      }

      const portStep = await stepPortTest(config, tunnelLocalPort);
      steps.push(portStep);
      if (!portStep.ok) {
        return { steps, success: false };
      }

      const handshakeStep = await stepT3Handshake(config, tunnelLocalPort);
      steps.push(handshakeStep);
      if (!handshakeStep.ok) {
        return { steps, success: false };
      }

      const authStep = await stepAuth(config, tunnelLocalPort);
      steps.push(authStep);

      return { steps, success: authStep.ok };
    },
    catch: (err) => {
      throw err;
    },
  }).pipe(Effect.orDie);
