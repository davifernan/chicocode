/**
 * ConnectionStatusBadge - Shows the current remote connection state in the sidebar.
 *
 * Subscribes to the global `t3:remoteStatus` custom event dispatched by
 * RemoteConnectionManager in main.tsx and renders an appropriate badge:
 *
 *  ● Connecting… (step)    (yellow, animated)
 *  ● remote.host           (green, connected — clickable → Settings/remote-host)
 *  ✕ Remote Error          (red, clickable → Settings/remote-host)
 *
 * @module ConnectionStatusBadge
 */
import { useEffect, useState } from "react";
import type { RemoteConnectionStatus } from "@t3tools/contracts";

import { REMOTE_STATUS_EVENT } from "../main";
import type { RemoteStatusEvent } from "../main";
import type { SettingsSectionId } from "./SettingsPanel";

interface ConnectionStatusBadgeProps {
  /** Called when the badge is clicked; opens settings at the remote-host section. */
  onOpenSettings?: (section: SettingsSectionId) => void;
}

export function ConnectionStatusBadge({ onOpenSettings }: ConnectionStatusBadgeProps) {
  const [status, setStatus] = useState<RemoteConnectionStatus | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      setStatus((e as RemoteStatusEvent).detail);
    };
    window.addEventListener(REMOTE_STATUS_EVENT, handler);
    return () => window.removeEventListener(REMOTE_STATUS_EVENT, handler);
  }, []);

  if (!status || status.status === "disconnected") return null;

  const openRemoteSettings = () => onOpenSettings?.("remote-host");

  if (status.status === "connecting") {
    return (
      <div className="mx-2 mb-2">
        <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-yellow-600 dark:text-yellow-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
          Connecting{status.step ? ` (${status.step})` : "…"}
        </div>
      </div>
    );
  }

  if (status.status === "connected") {
    const hostLabel = status.tunnelWsUrl ? new URL(status.tunnelWsUrl).hostname : "remote";
    return (
      <div className="mx-2 mb-2">
        <button
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-green-600 hover:bg-accent dark:text-green-400"
          onClick={openRemoteSettings}
          title={`Remote: ${status.tunnelWsUrl ?? ""} — click to manage`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          {hostLabel}
        </button>
      </div>
    );
  }

  if (status.status === "error") {
    return (
      <div className="mx-2 mb-2">
        <button
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-destructive hover:bg-accent"
          onClick={openRemoteSettings}
          title={`Remote error: ${status.error ?? "unknown"} — click to manage`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
          Remote Error
        </button>
      </div>
    );
  }

  return null;
}
