import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { readNativeApi } from "./nativeApi";
import { getWsTransport, replaceAppTransport } from "./wsNativeApi";
import type { RemoteConnectionStatus, RemoteSyncStatus } from "@t3tools/contracts";
import { runSync } from "./syncOrchestrator";
import { runProjectSync } from "./projectSyncOrchestrator";
import { loadRemoteHostConfig } from "./remoteHostConfig";
import { useStore } from "./store";

// ── History (module-level, stable across React re-renders) ────────────

// Electron loads the app from a file-backed shell, so hash history avoids
// path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

document.title = APP_DISPLAY_NAME;

// ── Custom events ─────────────────────────────────────────────────────

/**
 * Dispatched whenever the remote connection status changes.
 * Components listen with: window.addEventListener("t3:remoteStatus", handler)
 */
export const REMOTE_STATUS_EVENT = "t3:remoteStatus";
export const REMOTE_SYNC_EVENT = "t3:remoteSyncStatus";

export interface RemoteStatusEvent extends CustomEvent {
  detail: RemoteConnectionStatus;
}

export interface RemoteSyncEvent extends CustomEvent {
  detail: RemoteSyncStatus;
}

function dispatchSyncStatus(status: RemoteSyncStatus) {
  window.dispatchEvent(new CustomEvent(REMOTE_SYNC_EVENT, { detail: status }));
}

// ── RemoteConnectionManager ───────────────────────────────────────────

interface RemoteConnectionManagerProps {
  /** Called after the app transport is replaced, to trigger a React remount. */
  readonly onTransportSwitch: () => void;
}

/**
 * Subscribes to the management transport's remoteConnectionStatus channel.
 * On connect:   runs sync → replaces appTransport → triggers router remount
 * On disconnect: if was in remote mode → restores local appTransport → remount
 *
 * Lives OUTSIDE the keyed RouterProvider so it is never unmounted by a
 * transport switch — it must keep listening to the management transport always.
 */
function RemoteConnectionManager({ onTransportSwitch }: RemoteConnectionManagerProps) {
  // Guard: prevents double-triggering sync if status fires twice
  const syncInFlight = useRef(false);
  // Track whether we're currently in remote mode to detect disconnect
  const isInRemoteMode = useRef(false);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;

    return api.remoteHost.onConnectionStatus((status) => {
      // Always dispatch so badge/settings get the latest status
      window.dispatchEvent(new CustomEvent(REMOTE_STATUS_EVENT, { detail: status }));

      if (status.status === "connected" && status.tunnelWsUrl && !syncInFlight.current) {
        const tunnelWsUrl = status.tunnelWsUrl;
        const localTransport = getWsTransport();
        if (!localTransport) return;

        syncInFlight.current = true;
        dispatchSyncStatus({
          status: "syncing",
          total: 0,
          pushed: 0,
          pulled: 0,
          skipped: 0,
          diverged: [],
          error: null,
        });

        void runSync(localTransport, tunnelWsUrl, (progress) => {
          dispatchSyncStatus({
            status: "syncing",
            total: progress.total,
            pushed: progress.pushed,
            pulled: progress.pulled,
            skipped: progress.skipped,
            diverged: progress.diverged,
            error: null,
          });
        })
          .then(async (summary) => {
            dispatchSyncStatus({
              status: "done",
              total: summary.pushed + summary.pulled + summary.skipped + summary.diverged.length,
              pushed: summary.pushed,
              pulled: summary.pulled,
              skipped: summary.skipped,
              diverged: summary.diverged,
              error: summary.errors.length > 0 ? summary.errors.join("; ") : null,
            });

            // Project sync: auto-clone git projects on remote (best-effort, never blocks connect)
            try {
              const remoteConfig = await loadRemoteHostConfig();
              if (remoteConfig?.autoCloneGitProjects && remoteConfig.remoteWorkspaceBase.trim()) {
                const projects = useStore.getState().projects.map((p) => ({
                  id: p.id,
                  workspaceRoot: p.cwd,
                }));
                await runProjectSync(localTransport, tunnelWsUrl, remoteConfig, projects, () => {
                  // Progress handled silently for now — could add a separate banner later
                });
              }
            } catch {
              // Project sync errors are non-fatal — remote connect proceeds regardless
            }

            // Sync done → switch appTransport to tunnel → remount router
            replaceAppTransport(tunnelWsUrl);
            isInRemoteMode.current = true;
            onTransportSwitch();
          })
          .catch((err: unknown) => {
            dispatchSyncStatus({
              status: "error",
              total: 0,
              pushed: 0,
              pulled: 0,
              skipped: 0,
              diverged: [],
              error: err instanceof Error ? err.message : "Sync failed",
            });
            // Don't switch transport on sync failure — stay local
          })
          .finally(() => {
            syncInFlight.current = false;
          });
      }

      if (status.status === "disconnected" && isInRemoteMode.current) {
        // Tunnel dropped — switch back to local transport and remount
        replaceAppTransport(null);
        isInRemoteMode.current = false;
        onTransportSwitch();
      }
    });
  }, [onTransportSwitch]);

  return null;
}

// ── App root ──────────────────────────────────────────────────────────

function App() {
  // Incrementing this key forces RouterProvider (and the full React tree
  // under it) to unmount+remount. This causes all useEffect subscriptions in
  // __root.tsx to re-register on the new appTransport automatically.
  const [routerKey, setRouterKey] = useState(0);

  const handleTransportSwitch = useCallback(() => {
    setRouterKey((k) => k + 1);
  }, []);

  return (
    <>
      {/* Lives outside the keyed tree — never unmounted by transport switch */}
      <RemoteConnectionManager onTransportSwitch={handleTransportSwitch} />
      <RouterProvider key={routerKey} router={router} />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
