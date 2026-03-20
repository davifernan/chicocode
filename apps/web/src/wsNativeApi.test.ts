import {
  CommandId,
  type ContextMenuItem,
  EventId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  type WsPush,
  type WsPushChannel,
  type WsPushData,
  type WsPushMessage,
  type ServerProviderStatus,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Per-instance transport mock ───────────────────────────────────────
//
// The new wsNativeApi creates TWO WsTransport instances:
//   index 0 = managementTransport (always local)
//   index 1 = appTransport (switchable)
//
// Each instance gets its own request/subscribe/dispose mocks and channel
// listener map. Tests use emitTo(index, channel, data) to simulate pushes
// from a specific transport.

interface MockTransportState {
  request: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  channelListeners: Map<string, Set<(message: WsPush) => void>>;
  latestPushByChannel: Map<string, WsPush>;
}

let transportInstances: MockTransportState[] = [];
let nextPushSequence = 1;

function makeTransportState(): MockTransportState {
  const channelListeners = new Map<string, Set<(message: WsPush) => void>>();
  const latestPushByChannel = new Map<string, WsPush>();
  return {
    request: vi.fn(),
    dispose: vi.fn(),
    channelListeners,
    latestPushByChannel,
  };
}

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      private state: MockTransportState;
      constructor() {
        this.state = makeTransportState();
        transportInstances.push(this.state);
      }
      request(...args: unknown[]) {
        return (this.state.request as CallableFunction)(...args);
      }
      subscribe(channel: string, listener: (message: WsPush) => void): () => void {
        const set =
          this.state.channelListeners.get(channel) ?? new Set<(message: WsPush) => void>();
        set.add(listener);
        this.state.channelListeners.set(channel, set);

        // Replay latest if available (matches WsTransport.subscribe with replayLatest)
        const latest = this.state.latestPushByChannel.get(channel);
        if (latest) listener(latest);

        return () => {
          set.delete(listener);
          if (set.size === 0) this.state.channelListeners.delete(channel);
        };
      }
      getLatestPush(channel: string): WsPush | null {
        return this.state.latestPushByChannel.get(channel) ?? null;
      }
      dispose() {
        (this.state.dispose as CallableFunction)();
      }
    },
  };
});

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

// ── Helpers ───────────────────────────────────────────────────────────

function emitTo<C extends WsPushChannel>(
  transportIdx: number,
  channel: C,
  data: WsPushData<C>,
): void {
  const t = transportInstances[transportIdx];
  if (!t) throw new Error(`Transport at index ${transportIdx} does not exist yet`);
  const message = {
    type: "push" as const,
    sequence: nextPushSequence++,
    channel,
    data,
  } as WsPushMessage<C>;
  t.latestPushByChannel.set(channel, message);
  const listeners = t.channelListeners.get(channel);
  if (!listeners) return;
  for (const listener of listeners) listener(message);
}

/** Emit on management transport (index 0) */
const emitManagement = <C extends WsPushChannel>(channel: C, data: WsPushData<C>) =>
  emitTo(0, channel, data);

/** Emit on app transport (index 1) */
const emitApp = <C extends WsPushChannel>(channel: C, data: WsPushData<C>) =>
  emitTo(1, channel, data);

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

const defaultProviders: ReadonlyArray<ServerProviderStatus> = [
  {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
];

beforeEach(() => {
  vi.resetModules();
  transportInstances = [];
  nextPushSequence = 1;
  showContextMenuFallbackMock.mockReset();
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("wsNativeApi — two-transport routing", () => {
  it("creates exactly two transports on first call (management + app)", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    createWsNativeApi();
    expect(transportInstances).toHaveLength(2);
  });

  it("routes server.* methods to the management transport (index 0)", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    transportInstances[0]!.request.mockResolvedValue({});
    await api.server.getConfig();
    expect(transportInstances[0]!.request).toHaveBeenCalledWith(WS_METHODS.serverGetConfig);
    expect(transportInstances[1]!.request).not.toHaveBeenCalled();
  });

  it("routes remoteHost.setConfig to the management transport", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    transportInstances[0]!.request.mockResolvedValue(undefined);
    await api.remoteHost.setConfig(null);
    expect(transportInstances[0]!.request).toHaveBeenCalledWith(
      WS_METHODS.serverSetRemoteHostConfig,
      { config: null },
    );
    expect(transportInstances[1]!.request).not.toHaveBeenCalled();
  });

  it("routes devServer.* methods to the management transport", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    transportInstances[0]!.request.mockResolvedValue([]);
    await api.devServer.getStatuses();
    expect(transportInstances[0]!.request).toHaveBeenCalledWith(WS_METHODS.devServerGetStatuses);
    expect(transportInstances[1]!.request).not.toHaveBeenCalled();
  });

  it("routes orchestration.* methods to the app transport (index 1)", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    transportInstances[1]!.request.mockResolvedValue({ snapshot: [] });
    await api.orchestration.getSnapshot();
    expect(transportInstances[1]!.request).toHaveBeenCalledWith(
      ORCHESTRATION_WS_METHODS.getSnapshot,
    );
    expect(transportInstances[0]!.request).not.toHaveBeenCalled();
  });

  it("routes terminal.* methods to the app transport", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    transportInstances[1]!.request.mockResolvedValue({});
    await api.terminal.open({
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      threadId: ThreadId.makeUnsafe("t1"),
    });
    expect(transportInstances[1]!.request).toHaveBeenCalledWith(
      WS_METHODS.terminalOpen,
      expect.any(Object),
    );
    expect(transportInstances[0]!.request).not.toHaveBeenCalled();
  });

  it("routes sync.* methods to the app transport", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    transportInstances[1]!.request.mockResolvedValue({ threads: [] });
    await api.sync.getThreadManifest();
    expect(transportInstances[1]!.request).toHaveBeenCalledWith(WS_METHODS.syncGetThreadManifest);
    expect(transportInstances[0]!.request).not.toHaveBeenCalled();
  });
});

describe("wsNativeApi — push subscription routing", () => {
  it("delivers serverRemoteConnectionStatus from management transport to listeners", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const listener = vi.fn();

    api.remoteHost.onConnectionStatus(listener);

    const status = {
      status: "connected" as const,
      step: null,
      tunnelWsUrl: "ws://localhost:9999",
      error: null,
      connectedAt: "2026-01-01T00:00:00.000Z",
    };
    emitManagement(WS_CHANNELS.serverRemoteConnectionStatus, status);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(status);
  });

  it("does NOT deliver app transport events to remoteConnectionStatus listeners", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const listener = vi.fn();

    api.remoteHost.onConnectionStatus(listener);

    // Emit on app transport (index 1) — should NOT reach management listeners
    emitApp(WS_CHANNELS.serverRemoteConnectionStatus, {
      status: "connected",
      step: null,
      tunnelWsUrl: null,
      error: null,
      connectedAt: null,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers serverWelcome from app transport to onServerWelcome listeners", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");
    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitApp(WS_CHANNELS.serverWelcome, { cwd: "/tmp", projectName: "test" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp" }));
  });

  it("does NOT deliver management transport events to onServerWelcome listeners", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");
    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    // Emit on management transport — should NOT reach welcome listeners
    emitManagement(WS_CHANNELS.serverWelcome, { cwd: "/tmp", projectName: "wrong" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("replays cached serverWelcome from app transport for late subscribers", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");
    createWsNativeApi();

    emitApp(WS_CHANNELS.serverWelcome, { cwd: "/tmp", projectName: "test" });

    const lateListener = vi.fn();
    onServerWelcome(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp" }));
  });

  it("delivers terminal events from app transport", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const onEvent = vi.fn();

    api.terminal.onEvent(onEvent);
    emitApp(WS_CHANNELS.terminalEvent, {
      threadId: "t1",
      terminalId: "term-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "output",
      data: "hello",
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ data: "hello" }));
  });
});

describe("wsNativeApi — replaceAppTransport", () => {
  it("creates a new transport (index 2) when replaceAppTransport is called", async () => {
    const { createWsNativeApi, replaceAppTransport } = await import("./wsNativeApi");
    createWsNativeApi();
    expect(transportInstances).toHaveLength(2);

    replaceAppTransport("ws://tunnel:9999");

    expect(transportInstances).toHaveLength(3);
  });

  it("routes orchestration calls to new app transport after replace", async () => {
    const { createWsNativeApi, replaceAppTransport } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    replaceAppTransport("ws://tunnel:9999");
    // index 2 = new app transport
    transportInstances[2]!.request.mockResolvedValue({ snapshot: [] });

    await api.orchestration.getSnapshot();

    expect(transportInstances[2]!.request).toHaveBeenCalledWith(
      ORCHESTRATION_WS_METHODS.getSnapshot,
    );
    // Old app transport (index 1) should NOT be called
    expect(transportInstances[1]!.request).not.toHaveBeenCalled();
  });

  it("delivers serverWelcome from NEW app transport to listeners after replace", async () => {
    const { createWsNativeApi, replaceAppTransport, onServerWelcome } =
      await import("./wsNativeApi");
    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    replaceAppTransport("ws://tunnel:9999");

    // Emit on new app transport (index 2)
    emitTo(2, WS_CHANNELS.serverWelcome, { cwd: "/remote", projectName: "remote-server" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/remote" }));
  });

  it("does NOT deliver old app transport events after replace", async () => {
    const { createWsNativeApi, replaceAppTransport, onServerWelcome } =
      await import("./wsNativeApi");
    createWsNativeApi();

    replaceAppTransport("ws://tunnel:9999");

    const listener = vi.fn();
    onServerWelcome(listener);

    // Emit on OLD app transport (index 1) — should NOT reach listener
    emitApp(WS_CHANNELS.serverWelcome, { cwd: "/old", projectName: "old" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("disposes old app transport after a delay", async () => {
    vi.useFakeTimers();
    const { createWsNativeApi, replaceAppTransport } = await import("./wsNativeApi");
    createWsNativeApi();

    replaceAppTransport("ws://tunnel:9999");

    // Not disposed yet
    expect(transportInstances[1]!.dispose).not.toHaveBeenCalled();

    // After 5s delay
    await vi.advanceTimersByTimeAsync(5_001);

    expect(transportInstances[1]!.dispose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("management transport is never affected by replaceAppTransport", async () => {
    const { createWsNativeApi, replaceAppTransport } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    replaceAppTransport("ws://tunnel:9999");

    // Management calls still go to index 0
    transportInstances[0]!.request.mockResolvedValue({});
    await api.server.getConfig();
    expect(transportInstances[0]!.request).toHaveBeenCalled();
    expect(transportInstances[1]!.request).not.toHaveBeenCalled();
    expect(transportInstances[2]!.request).not.toHaveBeenCalled();
  });

  it("replaceAppTransport(null) creates a plain local transport (no url arg)", async () => {
    const { createWsNativeApi, replaceAppTransport } = await import("./wsNativeApi");
    createWsNativeApi();

    replaceAppTransport("ws://tunnel:9999");
    replaceAppTransport(null);

    // 4 total: management, original app, tunnel app, local-restore app
    expect(transportInstances).toHaveLength(4);
  });
});

describe("wsNativeApi — original behaviors preserved", () => {
  it("caches serverWelcome and replays for late subscribers", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");
    createWsNativeApi();

    emitApp(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/workspace",
      projectName: "t3-code",
    });

    const late = vi.fn();
    onServerWelcome(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("caches serverConfigUpdated and replays for late subscribers", async () => {
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");
    createWsNativeApi();

    const payload = { issues: [], providers: defaultProviders } as const;
    emitApp(WS_CHANNELS.serverConfigUpdated, payload);

    const late = vi.fn();
    onServerConfigUpdated(late);
    expect(late).toHaveBeenCalledWith(payload);
  });

  it("wraps orchestration dispatchCommand in the command envelope", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    transportInstances[1]!.request.mockResolvedValue(undefined);
    const command = {
      type: "project.create" as const,
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModel: "gpt-5-codex",
      createdAt: "2026-02-24T00:00:00.000Z",
    };
    await api.orchestration.dispatchCommand(command);
    expect(transportInstances[1]!.request).toHaveBeenCalledWith(
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      { command },
    );
  });

  it("forwards terminal and orchestration events from app transport", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();
    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output" as const,
      data: "hello",
    };
    emitApp(WS_CHANNELS.terminalEvent, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-1"),
      aggregateKind: "project" as const,
      aggregateId: ProjectId.makeUnsafe("project-1"),
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created" as const,
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModel: null,
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "project.created" }>;
    emitApp(ORCHESTRATION_WS_CHANNELS.domainEvent, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
  });

  it("uses desktop bridge for context menu when available", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: { showContextMenu },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show([{ id: "delete", label: "Delete", destructive: true }], {
      x: 10,
      y: 20,
    });

    expect(showContextMenu).toHaveBeenCalledTimes(1);
  });

  it("uses fallback context menu when desktop bridge is unavailable", async () => {
    showContextMenuFallbackMock.mockResolvedValue("delete");
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show([{ id: "delete", label: "Delete", destructive: true }]);

    expect(showContextMenuFallbackMock).toHaveBeenCalledTimes(1);
  });
});
