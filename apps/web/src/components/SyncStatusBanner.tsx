/**
 * SyncStatusBanner - Non-blocking banner that shows thread sync progress.
 *
 * Subscribes to the global `t3:remoteSyncStatus` custom event dispatched
 * by the RemoteConnectionManager in main.tsx and renders a compact banner:
 *
 *  Syncing 3/15 chats to remote…      (during sync)
 *  Synced – 12 new, 3 skipped         (done)
 *  ⚠ 2 threads diverged               (warning, if diverged.length > 0)
 *  Sync failed: <error>               (error)
 *
 * Auto-dismisses "done" state after 5 seconds.
 *
 * @module SyncStatusBanner
 */
import { useEffect, useRef, useState } from "react";
import type { RemoteSyncStatus } from "@t3tools/contracts";

import { REMOTE_SYNC_EVENT } from "../main";
import type { RemoteSyncEvent } from "../main";

export function SyncStatusBanner() {
  const [syncStatus, setSyncStatus] = useState<RemoteSyncStatus | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const event = e as RemoteSyncEvent;
      setSyncStatus(event.detail);

      // Auto-dismiss "done" after 5 s
      if (event.detail.status === "done") {
        if (dismissTimer.current) clearTimeout(dismissTimer.current);
        dismissTimer.current = setTimeout(() => setSyncStatus(null), 5_000);
      }
    };

    window.addEventListener(REMOTE_SYNC_EVENT, handler);
    return () => {
      window.removeEventListener(REMOTE_SYNC_EVENT, handler);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, []);

  if (!syncStatus || syncStatus.status === "idle") return null;

  const isSyncing = syncStatus.status === "syncing";
  const isDone = syncStatus.status === "done";
  const isError = syncStatus.status === "error";

  return (
    <div
      className={`pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-xs shadow-lg ${
        isError
          ? "bg-destructive text-destructive-foreground"
          : isDone
            ? "bg-card border border-border text-foreground"
            : "bg-card border border-border text-foreground"
      }`}
    >
      {isSyncing && (
        <span>
          <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
          {syncStatus.total > 0
            ? `Syncing ${syncStatus.pushed + syncStatus.pulled}/${syncStatus.total} chats…`
            : "Preparing sync…"}
        </span>
      )}

      {isDone && (
        <span>
          {"Synced"}
          {syncStatus.pushed > 0 ? ` — ${syncStatus.pushed} uploaded` : ""}
          {syncStatus.pulled > 0
            ? `${syncStatus.pushed > 0 ? ", " : " — "}${syncStatus.pulled} downloaded`
            : ""}
          {syncStatus.pushed === 0 && syncStatus.pulled === 0 ? " — up to date" : ""}
          {syncStatus.skipped > 0 ? `, ${syncStatus.skipped} skipped` : ""}
          {syncStatus.diverged.length > 0 ? ` · ⚠ ${syncStatus.diverged.length} diverged` : ""}
        </span>
      )}

      {isError && <span>Sync failed: {syncStatus.error ?? "unknown error"}</span>}
    </div>
  );
}
