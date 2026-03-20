import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import type { RemoteConnectionStatus, RemoteSyncStatus } from "@t3tools/contracts";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
