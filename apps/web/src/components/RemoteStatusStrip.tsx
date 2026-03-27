/**
 * RemoteStatusStrip - Compact status bar shown above the Projects list when
 * a remote server is connected.
 *
 * Displays:
 *  - Green indicator dot + hostname
 *  - CPU %, RAM %, connected-since duration (live, updated every 10 s)
 *  - Gear button to open the Remote Connect modal
 *
 * Subscribes to:
 *  - `t3:remoteStatus` custom event (from RemoteConnectionManager)
 *  - `api.remoteHost.onMetrics` push channel (from appTransport / remote server)
 *
 * Renders nothing when disconnected.
 *
 * @module RemoteStatusStrip
 */
import { useEffect, useRef, useState } from "react";
import { Settings2Icon } from "lucide-react";
import type { RemoteConnectionStatus, RemoteServerMetrics } from "@t3tools/contracts";

import { REMOTE_STATUS_EVENT } from "../main";
import type { RemoteStatusEvent } from "../main";
import { readNativeApi } from "../nativeApi";

// ── Helpers ────────────────────────────────────────────────────────────

function formatConnectedSince(connectedAt: string | null): string {
  if (!connectedAt) return "";
  const ms = Date.now() - new Date(connectedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function resolveHostname(status: RemoteConnectionStatus): string {
  if (status.tunnelWsUrl) {
    try {
      return new URL(status.tunnelWsUrl).hostname;
    } catch {
      // fallback below
    }
  }
  return "remote";
}

// ── Component ──────────────────────────────────────────────────────────

interface RemoteStatusStripProps {
  onOpenModal: () => void;
}

export function RemoteStatusStrip({ onOpenModal }: RemoteStatusStripProps) {
  const [status, setStatus] = useState<RemoteConnectionStatus | null>(null);
  const [metrics, setMetrics] = useState<RemoteServerMetrics | null>(null);
  const [, setTick] = useState(0);

  // Subscribe to connection status events
  useEffect(() => {
    const handler = (e: Event) => setStatus((e as RemoteStatusEvent).detail);
    window.addEventListener(REMOTE_STATUS_EVENT, handler);
    return () => window.removeEventListener(REMOTE_STATUS_EVENT, handler);
  }, []);

  // Subscribe to live metrics from the appTransport (switches to remote when tunneled)
  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.remoteHost.onMetrics((m) => setMetrics(m));
  }, []);

  // Re-render every 10 s to keep the "connected since" duration fresh
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // Reset metrics on any status transition so stale values don't linger.
  // Clearing on → "connected" prevents local server metrics from briefly
  // showing while the remote server hasn't pushed its first metrics yet.
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = status?.status ?? null;
    if (curr !== prev) {
      setMetrics(null);
    }
    prevStatusRef.current = curr;
  }, [status]);

  if (!status || status.status === "disconnected") return null;

  // ── Connecting state ──────────────────────────────────────────────

  if (status.status === "connecting") {
    return (
      <div className="mx-2 mb-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-2.5 py-1.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400 shrink-0" />
          <span className="text-[11px] text-yellow-600 dark:text-yellow-400">
            Connecting{status.step ? ` (${status.step})` : "…"}
          </span>
        </div>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────

  if (status.status === "error") {
    return (
      <div className="mx-2 mb-2">
        <button
          className="flex w-full items-center gap-1.5 rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-left hover:bg-destructive/10 transition-colors"
          onClick={onOpenModal}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-destructive shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-destructive">
            {status.error ?? "Remote error"}
          </span>
          <Settings2Icon className="size-3 shrink-0 text-destructive/60" />
        </button>
      </div>
    );
  }

  // ── Connected state ───────────────────────────────────────────────

  const hostname = resolveHostname(status);
  const connectedSince = formatConnectedSince(status.connectedAt);

  return (
    <div className="mx-2 mb-2">
      <div className="rounded-lg border border-green-500/20 bg-green-500/5 px-2.5 py-1.5">
        {/* Row 1: hostname + gear */}
        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
            <span className="truncate text-[11px] font-medium text-green-700 dark:text-green-400">
              {hostname}
            </span>
          </div>
          <button
            className="shrink-0 rounded p-0.5 text-green-700/60 hover:bg-green-500/15 hover:text-green-700 dark:text-green-400/60 dark:hover:text-green-400 transition-colors"
            onClick={onOpenModal}
            aria-label="Manage remote connection"
            title="Manage remote connection"
          >
            <Settings2Icon className="size-3" />
          </button>
        </div>

        {/* Row 2: metrics */}
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
          {metrics !== null ? (
            <>
              <span>CPU {metrics.cpuPercent}%</span>
              <span>·</span>
              <span>RAM {metrics.memPercent}%</span>
              {connectedSince ? (
                <>
                  <span>·</span>
                  <span>{connectedSince}</span>
                </>
              ) : null}
            </>
          ) : connectedSince ? (
            <span>{connectedSince}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
