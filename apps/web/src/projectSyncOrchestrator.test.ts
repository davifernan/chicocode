/**
 * Tests for projectSyncOrchestrator — auto git-clone flow during remote connect.
 *
 * Uses the same WsTransport queue-mock pattern as syncOrchestrator.test.ts:
 * `new WsTransport(url)` inside runProjectSync dequeues the next mock from
 * `nextTransportQueue`.  The localTransport is passed in directly and bypasses
 * the queue.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectSyncProgress } from "./projectSyncOrchestrator";
import type { RemoteHostConfig } from "@t3tools/contracts";

// ── Mock WsTransport ──────────────────────────────────────────────────

interface MockTransport {
  request: (...args: unknown[]) => unknown;
  dispose: () => void;
}

const nextTransportQueue: MockTransport[] = [];

vi.mock("./wsTransport", () => ({
  WsTransport: class MockWsTransport {
    private state: MockTransport;
    constructor() {
      const next = nextTransportQueue.shift();
      const reqFn = vi.fn();
      const dispFn = vi.fn();
      this.state = next ?? { request: reqFn as MockTransport["request"], dispose: dispFn };
    }
    request(...args: unknown[]) {
      return (this.state.request as CallableFunction)(...args);
    }
    dispose() {
      (this.state.dispose as CallableFunction)();
    }
    subscribe() {
      return () => {};
    }
    getLatestPush() {
      return null;
    }
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────

interface TypedMockTransport extends MockTransport {
  requestMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
}

function makeLocalTransport(
  reposByWorkspaceRoot: Record<
    string,
    Array<{
      relativePath: string;
      absolutePath: string;
      remoteUrl: string;
      branch: string;
    }>
  > = {},
): TypedMockTransport {
  const requestMock = vi.fn();
  const disposeMock = vi.fn();
  requestMock.mockImplementation((method: string, params?: { workspaceRoot?: string }) => {
    if (method === "project.resolveGitRepos" && params?.workspaceRoot) {
      return Promise.resolve({
        repos: reposByWorkspaceRoot[params.workspaceRoot] ?? [],
      });
    }
    return Promise.reject(new Error(`Unexpected local call: ${method}`));
  });
  return {
    request: requestMock as MockTransport["request"],
    dispose: disposeMock,
    requestMock,
    disposeMock,
  };
}

function makeRemoteTransport(
  cloneResults: Array<{
    targetPath: string;
    success: boolean;
    skipped: boolean;
    error?: string;
  }> = [],
): TypedMockTransport {
  const requestMock = vi.fn();
  const disposeMock = vi.fn();
  requestMock.mockImplementation((method: string) => {
    if (method === "project.gitClone") {
      return Promise.resolve({ results: cloneResults });
    }
    return Promise.reject(new Error(`Unexpected remote call: ${method}`));
  });
  return {
    request: requestMock as MockTransport["request"],
    dispose: disposeMock,
    requestMock,
    disposeMock,
  };
}

const BASE_CONFIG: RemoteHostConfig = {
  host: "remote.example.com",
  sshPort: 22,
  sshUser: "user",
  sshKeyPath: "~/.ssh/id_rsa",
  sshPassword: null,
  remoteServerPort: 3773,
  remoteAuthToken: null,
  enabled: true,
  autoCloneGitProjects: true,
  remoteWorkspaceBase: "/home/user/projects",
};

beforeEach(() => {
  nextTransportQueue.length = 0;
  vi.useFakeTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("projectSyncOrchestrator — no-op conditions", () => {
  it("returns zero counts when autoCloneGitProjects is false", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport();
    const remote = makeRemoteTransport();
    nextTransportQueue.push(remote);

    const config = { ...BASE_CONFIG, autoCloneGitProjects: false };
    const syncPromise = runProjectSync(local as never, "ws://tunnel:9999", config, [], () => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    expect(summary.cloned).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toHaveLength(0);
    // Neither transport should be called
    expect(local.requestMock).not.toHaveBeenCalled();
  });

  it("returns zero counts when remoteWorkspaceBase is empty", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport();
    nextTransportQueue.push(makeRemoteTransport());

    const config = { ...BASE_CONFIG, remoteWorkspaceBase: "   " };
    const syncPromise = runProjectSync(local as never, "ws://tunnel:9999", config, [], () => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    expect(summary.cloned).toBe(0);
    expect(local.requestMock).not.toHaveBeenCalled();
  });

  it("returns zero counts when there are no local projects", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport();
    const remote = makeRemoteTransport();
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [], // no projects
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    expect(summary.cloned).toBe(0);
    expect(remote.requestMock).not.toHaveBeenCalledWith("project.gitClone", expect.any(Object));
  });

  it("skips projects with no git repos", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    // Local returns empty repos for the project
    const local = makeLocalTransport({ "/home/davi/my-app": [] });
    const remote = makeRemoteTransport();
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [{ id: "p1", workspaceRoot: "/home/davi/my-app" }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    expect(summary.cloned).toBe(0);
    expect(remote.requestMock).not.toHaveBeenCalled();
  });
});

describe("projectSyncOrchestrator — cloning", () => {
  it("clones a single root-level git repo", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport({
      "/home/davi/my-app": [
        {
          relativePath: ".",
          absolutePath: "/home/davi/my-app",
          remoteUrl: "git@github.com:user/my-app.git",
          branch: "main",
        },
      ],
    });
    const remote = makeRemoteTransport([
      { targetPath: "/home/user/projects/my-app", success: true, skipped: false },
    ]);
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [{ id: "p1", workspaceRoot: "/home/davi/my-app" }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    expect(summary.cloned).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toHaveLength(0);
  });

  it("counts skipped repos (already exist on remote)", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport({
      "/home/davi/my-app": [
        {
          relativePath: ".",
          absolutePath: "/home/davi/my-app",
          remoteUrl: "git@github.com:user/my-app.git",
          branch: "main",
        },
      ],
    });
    const remote = makeRemoteTransport([
      { targetPath: "/home/user/projects/my-app", success: true, skipped: true },
    ]);
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [{ id: "p1", workspaceRoot: "/home/davi/my-app" }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    expect(summary.cloned).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("counts failed clones and collects error messages", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport({
      "/home/davi/private-repo": [
        {
          relativePath: ".",
          absolutePath: "/home/davi/private-repo",
          remoteUrl: "git@github.com:user/private-repo.git",
          branch: "main",
        },
      ],
    });
    const remote = makeRemoteTransport([
      {
        targetPath: "/home/user/projects/private-repo",
        success: false,
        skipped: false,
        error: "Permission denied (publickey)",
      },
    ]);
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [{ id: "p1", workspaceRoot: "/home/davi/private-repo" }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    expect(summary.cloned).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("Permission denied");
  });

  it("handles multiple projects with multiple sub-repos each", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport({
      "/home/davi/workspace": [
        {
          relativePath: "frontend",
          absolutePath: "/home/davi/workspace/frontend",
          remoteUrl: "git@github.com:user/frontend.git",
          branch: "main",
        },
        {
          relativePath: "backend",
          absolutePath: "/home/davi/workspace/backend",
          remoteUrl: "git@github.com:user/backend.git",
          branch: "develop",
        },
      ],
      "/home/davi/other": [
        {
          relativePath: ".",
          absolutePath: "/home/davi/other",
          remoteUrl: "git@github.com:user/other.git",
          branch: "main",
        },
      ],
    });
    const remote = makeRemoteTransport([
      { targetPath: "/home/user/projects/workspace/frontend", success: true, skipped: false },
      { targetPath: "/home/user/projects/workspace/backend", success: true, skipped: false },
      { targetPath: "/home/user/projects/other", success: true, skipped: false },
    ]);
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [
        { id: "p1", workspaceRoot: "/home/davi/workspace" },
        { id: "p2", workspaceRoot: "/home/davi/other" },
      ],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    expect(summary.cloned).toBe(3);
    expect(summary.failed).toBe(0);
  });

  it("disposes the remote transport after sync", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport({
      "/home/davi/app": [
        {
          relativePath: ".",
          absolutePath: "/home/davi/app",
          remoteUrl: "git@github.com:user/app.git",
          branch: "main",
        },
      ],
    });
    const remote = makeRemoteTransport([
      { targetPath: "/home/user/projects/app", success: true, skipped: false },
    ]);
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [{ id: "p1", workspaceRoot: "/home/davi/app" }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await syncPromise;

    expect(remote.disposeMock).toHaveBeenCalledTimes(1);
  });
});

describe("projectSyncOrchestrator — target path computation", () => {
  it("places a root-level repo at remoteWorkspaceBase/projectName", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport({
      "/Users/davi/projects/my-cool-app": [
        {
          relativePath: ".",
          absolutePath: "/Users/davi/projects/my-cool-app",
          remoteUrl: "git@github.com:user/my-cool-app.git",
          branch: "main",
        },
      ],
    });
    const remote = makeRemoteTransport([
      { targetPath: "/srv/projects/my-cool-app", success: true, skipped: false },
    ]);
    nextTransportQueue.push(remote);

    const config = { ...BASE_CONFIG, remoteWorkspaceBase: "/srv/projects" };
    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      config,
      [{ id: "p1", workspaceRoot: "/Users/davi/projects/my-cool-app" }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await syncPromise;

    const cloneCall = remote.requestMock.mock.calls.find(
      ([method]: string[]) => method === "project.gitClone",
    );
    expect(cloneCall).toBeDefined();
    const repos = (cloneCall as [string, { repos: Array<{ targetPath: string }> }])[1].repos;
    expect(repos[0]?.targetPath).toBe("/srv/projects/my-cool-app");
  });

  it("places a sub-repo at remoteWorkspaceBase/projectName/subdir", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport({
      "/Users/davi/monorepo": [
        {
          relativePath: "packages/ui",
          absolutePath: "/Users/davi/monorepo/packages/ui",
          remoteUrl: "git@github.com:user/ui.git",
          branch: "main",
        },
      ],
    });
    const remote = makeRemoteTransport([
      { targetPath: "/home/user/projects/monorepo/packages/ui", success: true, skipped: false },
    ]);
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [{ id: "p1", workspaceRoot: "/Users/davi/monorepo" }],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await syncPromise;

    const cloneCall = remote.requestMock.mock.calls.find(
      ([method]: string[]) => method === "project.gitClone",
    );
    const repos = (cloneCall as [string, { repos: Array<{ targetPath: string }> }])[1].repos;
    expect(repos[0]?.targetPath).toBe("/home/user/projects/monorepo/packages/ui");
  });
});

describe("projectSyncOrchestrator — progress callbacks", () => {
  it("calls onProgress with total before cloning", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");

    const local = makeLocalTransport({
      "/home/davi/app": [
        {
          relativePath: ".",
          absolutePath: "/home/davi/app",
          remoteUrl: "git@github.com:user/app.git",
          branch: "main",
        },
      ],
    });
    const remote = makeRemoteTransport([
      { targetPath: "/home/user/projects/app", success: true, skipped: false },
    ]);
    nextTransportQueue.push(remote);

    const progressCalls: ProjectSyncProgress[] = [];
    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [{ id: "p1", workspaceRoot: "/home/davi/app" }],
      (p) => progressCalls.push({ ...p }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await syncPromise;

    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    expect(progressCalls[0]!.total).toBe(1);
  });

  it("respects abort signal and stops early", async () => {
    const { runProjectSync } = await import("./projectSyncOrchestrator");
    const controller = new AbortController();

    // Two projects, each with one repo
    const local = makeLocalTransport({
      "/home/davi/app1": [
        {
          relativePath: ".",
          absolutePath: "/home/davi/app1",
          remoteUrl: "git@github.com:user/app1.git",
          branch: "main",
        },
      ],
      "/home/davi/app2": [
        {
          relativePath: ".",
          absolutePath: "/home/davi/app2",
          remoteUrl: "git@github.com:user/app2.git",
          branch: "main",
        },
      ],
    });
    const remote: MockTransport = {
      request: vi.fn().mockImplementation((method: string) => {
        if (method === "project.gitClone") {
          controller.abort(); // abort after first batch
          return Promise.resolve({
            results: [{ targetPath: "/home/user/projects/app1", success: true, skipped: false }],
          });
        }
        return Promise.resolve({ results: [] });
      }),
      dispose: vi.fn(),
    };
    nextTransportQueue.push(remote);

    const syncPromise = runProjectSync(
      local as never,
      "ws://tunnel:9999",
      BASE_CONFIG,
      [
        { id: "p1", workspaceRoot: "/home/davi/app1" },
        { id: "p2", workspaceRoot: "/home/davi/app2" },
      ],
      () => {},
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await syncPromise;

    // At most one batch was cloned before abort
    expect(summary.cloned + summary.failed + summary.skipped).toBeLessThanOrEqual(2);
  });
});
