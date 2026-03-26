/**
 * RemoteHostService.test.ts - Tests for tunnelWsUrl token construction.
 *
 * Verifies that the tunnelWsUrl published in RemoteConnectionStatus
 * includes the `?token=<remoteAuthToken>` query parameter when the
 * config has a remoteAuthToken set, and omits it when null/empty.
 *
 * Uses a mocked SshTunnelManager and bypasses the full SSH flow.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";

import type { RemoteConnectionStatus, RemoteHostConfig } from "@t3tools/contracts";
import { SshTunnelManager, type SshTunnelManagerShape } from "./SshTunnelManager";

// We import the factory, not the service tag, so we can provide mocked deps.
import { makeRemoteHostService } from "./RemoteHostService";

// ── Helpers ──────────────────────────────────────────────────────────

const makeConfig = (overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig => ({
  host: "127.0.0.1",
  sshPort: 22,
  sshUser: "test",
  sshKeyPath: "",
  sshPassword: null,
  remoteServerPort: 3773,
  remoteAuthToken: null,
  enabled: true,
  autoCloneGitProjects: false,
  remoteWorkspaceBase: "",
  ...overrides,
});

/**
 * Build a mock SshTunnelManager that returns a fixed localPort and never
 * actually opens an SSH connection.
 */
function mockTunnelManager(localPort: number): SshTunnelManagerShape {
  return {
    start: () => Effect.succeed({ localPort }),
    stop: () => Effect.void,
    getStatus: () => ({ kind: "running" as const, localPort }),
  };
}

/**
 * Mock `testConnection` at the module level so `applyConfig` doesn't
 * actually try to reach a real server.
 */
vi.mock("./ConnectionChecker.ts", () => ({
  testConnection: () =>
    Effect.succeed({
      steps: [
        { step: "ssh-connect", ok: true, error: null, hint: null },
        { step: "port-test", ok: true, error: null, hint: null },
        { step: "t3-handshake", ok: true, error: null, hint: null },
        { step: "auth", ok: true, error: null, hint: null },
      ],
      success: true,
    }),
}));

// ── Tests ────────────────────────────────────────────────────────────

async function runWithTunnelPort(
  tunnelPort: number,
  config: RemoteHostConfig,
): Promise<RemoteConnectionStatus> {
  const layer = Layer.succeed(SshTunnelManager, mockTunnelManager(tunnelPort));

  return Effect.runPromise(
    makeRemoteHostService.pipe(
      Effect.flatMap((service) =>
        Effect.gen(function* () {
          yield* service.applyConfig(config);
          yield* Effect.sleep("50 millis");
          return yield* service.getConnectionStatus();
        }),
      ),
      Effect.scoped,
      Effect.provide(layer),
    ),
  );
}

describe("RemoteHostService — tunnelWsUrl token", () => {
  it("includes ?token= in tunnelWsUrl when remoteAuthToken is set", async () => {
    const status = await runWithTunnelPort(
      12345,
      makeConfig({ remoteAuthToken: "my-secret-token" }),
    );
    expect(status.status).toBe("connected");
    expect(status.tunnelWsUrl).toBe("ws://127.0.0.1:12345?token=my-secret-token");
  });

  it("omits ?token= from tunnelWsUrl when remoteAuthToken is null", async () => {
    const status = await runWithTunnelPort(12346, makeConfig({ remoteAuthToken: null }));
    expect(status.status).toBe("connected");
    expect(status.tunnelWsUrl).toBe("ws://127.0.0.1:12346");
    expect(status.tunnelWsUrl).not.toContain("?token=");
  });

  it("omits ?token= from tunnelWsUrl when remoteAuthToken is empty string", async () => {
    const status = await runWithTunnelPort(12347, makeConfig({ remoteAuthToken: "" }));
    expect(status.status).toBe("connected");
    expect(status.tunnelWsUrl).toBe("ws://127.0.0.1:12347");
    expect(status.tunnelWsUrl).not.toContain("?token=");
  });

  it("URL-encodes special characters in the token", async () => {
    const status = await runWithTunnelPort(
      12348,
      makeConfig({ remoteAuthToken: "token with spaces&special=chars" }),
    );
    expect(status.status).toBe("connected");
    expect(status.tunnelWsUrl).toBe(
      `ws://127.0.0.1:12348?token=${encodeURIComponent("token with spaces&special=chars")}`,
    );
  });
});
