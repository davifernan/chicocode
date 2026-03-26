/**
 * ConnectionChecker.test.ts - Tests for step-by-step connection validation.
 *
 * Spins up a minimal HTTP server that implements /api/health with token
 * checking, then exercises the stepT3Handshake and stepAuth logic through
 * the public `testConnection` function.
 *
 * To make `testConnection` reach the handshake/auth steps, we need the
 * ssh-connect TCP check to succeed first. We achieve this by pointing
 * `config.host` + `config.sshPort` at the same HTTP server (TCP is TCP).
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { RemoteHostConfig } from "@t3tools/contracts";
import { testConnection } from "./ConnectionChecker";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Start a tiny HTTP server that mirrors the /api/health route we added
 * to wsServer.ts. Returns the assigned port and a cleanup function.
 */
function startHealthServer(
  serverAuthToken: string | null,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      if (url.pathname === "/api/health") {
        const providedToken = url.searchParams.get("token");
        if (providedToken !== null && serverAuthToken && providedToken !== serverAuthToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((res) => srv.close(() => res())),
      });
    });
  });
}

/**
 * Build a config where host + sshPort point to the test server so the
 * ssh-connect TCP check passes (it's just a TCP connect, not real SSH).
 */
const makeConfig = (
  serverPort: number,
  overrides: Partial<RemoteHostConfig> = {},
): RemoteHostConfig => ({
  host: "127.0.0.1",
  sshPort: serverPort, // TCP check will succeed against our HTTP server
  sshUser: "test",
  sshKeyPath: "",
  sshPassword: null,
  remoteServerPort: serverPort,
  remoteAuthToken: null,
  enabled: true,
  autoCloneGitProjects: false,
  remoteWorkspaceBase: "",
  ...overrides,
});

// ── Tests ────────────────────────────────────────────────────────────

describe("ConnectionChecker", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("t3-handshake succeeds against a running health server", async () => {
    const { port, close } = await startHealthServer(null);
    cleanup = close;

    const result = await Effect.runPromise(testConnection(makeConfig(port), port));
    const handshake = result.steps.find((s) => s.step === "t3-handshake");
    expect(handshake).toBeDefined();
    expect(handshake!.ok).toBe(true);
  });

  it("auth step succeeds with correct token", async () => {
    const { port, close } = await startHealthServer("my-secret");
    cleanup = close;

    const config = makeConfig(port, { remoteAuthToken: "my-secret" });
    const result = await Effect.runPromise(testConnection(config, port));
    const auth = result.steps.find((s) => s.step === "auth");
    expect(auth).toBeDefined();
    expect(auth!.ok).toBe(true);
    expect(result.success).toBe(true);
  });

  it("auth step fails with wrong token (401)", async () => {
    const { port, close } = await startHealthServer("correct-token");
    cleanup = close;

    const config = makeConfig(port, { remoteAuthToken: "wrong-token" });
    const result = await Effect.runPromise(testConnection(config, port));
    const auth = result.steps.find((s) => s.step === "auth");
    expect(auth).toBeDefined();
    expect(auth!.ok).toBe(false);
    expect(auth!.error).toContain("401");
  });

  it("auth step is skipped when remoteAuthToken is null", async () => {
    const { port, close } = await startHealthServer("server-token");
    cleanup = close;

    const config = makeConfig(port, { remoteAuthToken: null });
    const result = await Effect.runPromise(testConnection(config, port));
    const auth = result.steps.find((s) => s.step === "auth");
    expect(auth).toBeDefined();
    // No token provided by client -> step is skipped (ok: true)
    expect(auth!.ok).toBe(true);
    expect(result.success).toBe(true);
  });

  it("fails early when tunnel port is unreachable", async () => {
    // Start a server just for the SSH TCP check to pass, then use a different
    // port for the tunnel where nothing is listening. The test validates that
    // testConnection returns success: false — it will fail at either port-test
    // or t3-handshake depending on timing.
    const { port: sshPort, close } = await startHealthServer(null);
    cleanup = close;

    const config = makeConfig(sshPort);
    const result = await Effect.runPromise(testConnection(config, 19999));
    expect(result.success).toBe(false);
    // At least one step should have failed
    const failedStep = result.steps.find((s) => !s.ok);
    expect(failedStep).toBeDefined();
  });
});
