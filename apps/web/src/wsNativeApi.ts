/**
 * wsNativeApi - WebSocket-backed NativeApi implementation.
 *
 * Two-transport architecture:
 *
 *  managementTransport — always local server, never changes.
 *    handles: server.*, remoteHost.*, devServer.*
 *    push channels: serverRemoteConnectionStatus, serverRemoteSyncStatus
 *
 *  appTransport — starts as local, switches to tunnel after remote connect.
 *    handles: orchestration.*, terminal.*, git.*, projects.*, shell.*, sync.*
 *    push channels: serverWelcome, serverConfigUpdated
 *
 * replaceAppTransport(tunnelWsUrl) swaps appTransport live. JS closures
 * capture variable bindings, so all api method closures automatically use the
 * new transport on the next call. Push subscriptions are re-registered on the
 * new transport. The old transport is disposed after a short delay to let
 * in-flight requests complete.
 *
 * @module wsNativeApi
 */
import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  ServerConfigUpdatedPayload,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
  type RemoteConnectionStatus,
  type RemoteServerMetrics,
  type RemoteSyncStatus,
} from "@t3tools/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { WsTransport } from "./wsTransport";

// ── Module-level state ────────────────────────────────────────────────

let instance: {
  api: NativeApi;
  managementTransport: WsTransport;
  appTransport: WsTransport;
  /** Unsubscribe functions for push channels registered on appTransport. */
  appSubscriptionCleanups: Array<() => void>;
} | null = null;

// These listener sets are long-lived — they survive transport switches.
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
const serverConfigUpdatedListeners = new Set<(payload: ServerConfigUpdatedPayload) => void>();
const remoteConnectionStatusListeners = new Set<(payload: RemoteConnectionStatus) => void>();
const remoteSyncStatusListeners = new Set<(payload: RemoteSyncStatus) => void>();
const remoteMetricsListeners = new Set<(payload: RemoteServerMetrics) => void>();

// ── Push subscription setup ───────────────────────────────────────────

/**
 * Register the app-transport push channels (serverWelcome, serverConfigUpdated).
 * Returns unsubscribe functions so callers can clean up when replacing the transport.
 */
function setupAppTransportSubscriptions(t: WsTransport): Array<() => void> {
  const cleanups: Array<() => void> = [];
  cleanups.push(
    t.subscribe(WS_CHANNELS.serverWelcome, (message) => {
      const payload = message.data;
      for (const listener of welcomeListeners) {
        try {
          listener(payload);
        } catch {
          // swallow
        }
      }
    }),
  );

  cleanups.push(
    t.subscribe(WS_CHANNELS.serverConfigUpdated, (message) => {
      const payload = message.data;
      for (const listener of serverConfigUpdatedListeners) {
        try {
          listener(payload);
        } catch {
          // swallow
        }
      }
    }),
  );

  cleanups.push(
    t.subscribe(WS_CHANNELS.serverMetrics, (message) => {
      const payload = message.data;
      for (const listener of remoteMetricsListeners) {
        try {
          listener(payload);
        } catch {
          // swallow
        }
      }
    }),
  );

  return cleanups;
}

/**
 * Register the management-transport push channels.
 * Called once at init — management transport never changes.
 */
function setupManagementTransportSubscriptions(t: WsTransport): void {
  t.subscribe(WS_CHANNELS.serverRemoteConnectionStatus, (message) => {
    const payload = message.data;
    for (const listener of remoteConnectionStatusListeners) {
      try {
        listener(payload);
      } catch {
        // swallow
      }
    }
  });

  t.subscribe(WS_CHANNELS.serverRemoteSyncStatus, (message) => {
    const payload = message.data;
    for (const listener of remoteSyncStatusListeners) {
      try {
        listener(payload);
      } catch {
        // swallow
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  welcomeListeners.add(listener);

  const latestWelcome =
    instance?.appTransport.getLatestPush(WS_CHANNELS.serverWelcome)?.data ?? null;
  if (latestWelcome) {
    try {
      listener(latestWelcome);
    } catch {
      // swallow
    }
  }

  return () => {
    welcomeListeners.delete(listener);
  };
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
): () => void {
  serverConfigUpdatedListeners.add(listener);

  const latestConfig =
    instance?.appTransport.getLatestPush(WS_CHANNELS.serverConfigUpdated)?.data ?? null;
  if (latestConfig) {
    try {
      listener(latestConfig);
    } catch {
      // swallow
    }
  }

  return () => {
    serverConfigUpdatedListeners.delete(listener);
  };
}

/**
 * Returns the current app WsTransport, or null if not yet initialized.
 * Used by syncOrchestrator to access the local transport directly during sync
 * (before the transport is switched to the tunnel).
 */
export function getWsTransport(): WsTransport | null {
  return instance?.appTransport ?? null;
}

/**
 * Replace the app transport with a new one pointing at tunnelWsUrl.
 * Pass null to return to the default local URL.
 *
 * Steps:
 *  1. Create new WsTransport with the target URL
 *  2. Re-register app push subscriptions on the new transport
 *  3. Update module state so all api method closures use the new transport
 *  4. Dispose old transport after 5s (lets in-flight requests resolve)
 */
export function replaceAppTransport(tunnelWsUrl: string | null): void {
  if (!instance) return;

  // Unsubscribe from old app transport channels before replacing
  for (const cleanup of instance.appSubscriptionCleanups) {
    cleanup();
  }

  const old = instance.appTransport;
  const next = new WsTransport(tunnelWsUrl ?? undefined);
  const newCleanups = setupAppTransportSubscriptions(next);

  instance = { ...instance, appTransport: next, appSubscriptionCleanups: newCleanups };

  // Give in-flight requests time to settle before closing the old socket.
  setTimeout(() => old.dispose(), 5_000);
}

// ── Factory ───────────────────────────────────────────────────────────

export function createWsNativeApi(): NativeApi {
  if (instance) return instance.api;

  const managementTransport = new WsTransport();
  const appTransport = new WsTransport();

  setupManagementTransportSubscriptions(managementTransport);
  const appSubscriptionCleanups = setupAppTransportSubscriptions(appTransport);

  // All api method closures read from `instance.managementTransport` or
  // `instance.appTransport` at call time — NOT at definition time — because
  // they go through the getter functions below. This is the key that makes
  // replaceAppTransport() work without rebuilding the api object.
  const mgmt = () => instance!.managementTransport;
  const app = () => instance!.appTransport;

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => app().request(WS_METHODS.terminalOpen, input),
      write: (input) => app().request(WS_METHODS.terminalWrite, input),
      resize: (input) => app().request(WS_METHODS.terminalResize, input),
      clear: (input) => app().request(WS_METHODS.terminalClear, input),
      restart: (input) => app().request(WS_METHODS.terminalRestart, input),
      close: (input) => app().request(WS_METHODS.terminalClose, input),
      onEvent: (callback) =>
        app().subscribe(WS_CHANNELS.terminalEvent, (message) => callback(message.data)),
    },
    projects: {
      searchEntries: (input) => app().request(WS_METHODS.projectsSearchEntries, input),
      writeFile: (input) => app().request(WS_METHODS.projectsWriteFile, input),
    },
    shell: {
      openInEditor: (cwd, editor) => app().request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: (input) => app().request(WS_METHODS.gitPull, input),
      status: (input) => app().request(WS_METHODS.gitStatus, input),
      runStackedAction: (input) => app().request(WS_METHODS.gitRunStackedAction, input),
      listBranches: (input) => app().request(WS_METHODS.gitListBranches, input),
      createWorktree: (input) => app().request(WS_METHODS.gitCreateWorktree, input),
      removeWorktree: (input) => app().request(WS_METHODS.gitRemoveWorktree, input),
      createBranch: (input) => app().request(WS_METHODS.gitCreateBranch, input),
      checkout: (input) => app().request(WS_METHODS.gitCheckout, input),
      init: (input) => app().request(WS_METHODS.gitInit, input),
      resolvePullRequest: (input) => app().request(WS_METHODS.gitResolvePullRequest, input),
      preparePullRequestThread: (input) =>
        app().request(WS_METHODS.gitPreparePullRequestThread, input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => mgmt().request(WS_METHODS.serverGetConfig),
      getUiState: (input) => mgmt().request(WS_METHODS.serverGetUiState, input),
      upsertKeybinding: (input) => mgmt().request(WS_METHODS.serverUpsertKeybinding, input),
      upsertUiState: (input) => mgmt().request(WS_METHODS.serverUpsertUiState, input),
    },
    orchestration: {
      getSnapshot: () => app().request(ORCHESTRATION_WS_METHODS.getSnapshot),
      getThreadMessages: (input) =>
        app().request(ORCHESTRATION_WS_METHODS.getThreadMessages, input),
      dispatchCommand: (command) =>
        app().request(ORCHESTRATION_WS_METHODS.dispatchCommand, { command }),
      getTurnDiff: (input) => app().request(ORCHESTRATION_WS_METHODS.getTurnDiff, input),
      getFullThreadDiff: (input) =>
        app().request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, input),
      replayEvents: (fromSequenceExclusive) =>
        app().request(ORCHESTRATION_WS_METHODS.replayEvents, { fromSequenceExclusive }),
      onDomainEvent: (callback) =>
        app().subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (message) => callback(message.data)),
    },
    devServer: {
      start: (input) => mgmt().request(WS_METHODS.devServerStart, input),
      stop: (input) => mgmt().request(WS_METHODS.devServerStop, input),
      getStatus: (input) => mgmt().request(WS_METHODS.devServerGetStatus, input),
      getStatuses: () => mgmt().request(WS_METHODS.devServerGetStatuses),
      getLogs: (input) => mgmt().request(WS_METHODS.devServerGetLogs, input),
      onStatusChanged: (callback) =>
        mgmt().subscribe(WS_CHANNELS.devServerStatusChanged, (message) => callback(message.data)),
      onLogLine: (callback) =>
        mgmt().subscribe(WS_CHANNELS.devServerLogLine, (message) => callback(message.data)),
    },
    remoteHost: {
      setConfig: (config) => mgmt().request(WS_METHODS.serverSetRemoteHostConfig, { config }),
      testConnection: (config) => mgmt().request(WS_METHODS.serverTestRemoteConnection, { config }),
      onConnectionStatus: (callback) =>
        mgmt().subscribe(WS_CHANNELS.serverRemoteConnectionStatus, (message) =>
          callback(message.data),
        ),
      onSyncStatus: (callback) =>
        mgmt().subscribe(WS_CHANNELS.serverRemoteSyncStatus, (message) => callback(message.data)),
      onMetrics: (callback) => {
        remoteMetricsListeners.add(callback);
        return () => {
          remoteMetricsListeners.delete(callback);
        };
      },
    },
    sync: {
      getThreadManifest: () => app().request(WS_METHODS.syncGetThreadManifest),
      exportThreadEvents: (threadId) =>
        app().request(WS_METHODS.syncExportThreadEvents, { threadId }),
      receiveEvents: (events) => app().request(WS_METHODS.syncReceiveEvents, { events }),
    },
  };

  instance = { api, managementTransport, appTransport, appSubscriptionCleanups };
  return api;
}
