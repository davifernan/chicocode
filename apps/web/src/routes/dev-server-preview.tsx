/* oxlint-disable react/iframe-missing-sandbox */

import { createFileRoute } from "@tanstack/react-router";
import { RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/dev-server-preview")({
  validateSearch: (search: Record<string, unknown>) => ({
    /**
     * Legacy: raw dev server URL (local mode / Electron).
     * Takes precedence if both are provided for backwards compat.
     */
    target: typeof search.target === "string" ? search.target : "",
    /**
     * Preferred: project ID for routing through the T3 reverse proxy.
     * Results in `src="/__devproxy/<projectId>/"` — works in remote mode.
     */
    projectId: typeof search.projectId === "string" ? search.projectId : "",
  }),
  component: DevServerPreviewPage,
});

function extractDisplayHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

function DevServerPreviewPage() {
  const { target, projectId } = Route.useSearch();

  // Resolve the iframe src:
  //  - projectId present → proxy through T3 server (works in remote mode)
  //  - target present → raw URL (legacy / Electron local)
  //  - neither → empty (shows "No preview" state)
  const iframeSrc = projectId ? `/__devproxy/${projectId}/` : target;

  // Key increments on reload so React recreates the iframe element
  const [reloadKey, setReloadKey] = useState(0);
  const [isReloading, setIsReloading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const displayHost = iframeSrc ? extractDisplayHost(iframeSrc) : "";

  // Set document.title so Electron / macOS picks it up as window title
  useEffect(() => {
    document.title = iframeSrc ? `Dev Preview — ${displayHost}` : "Dev Preview";
  }, [iframeSrc, displayHost]);

  const handleReload = () => {
    setIsReloading(true);
    setReloadKey((k) => k + 1);
    // Brief animation then clear spinner
    setTimeout(() => setIsReloading(false), 600);
  };

  // Also reload when src changes from outside (project switch)
  const prevSrcRef = useRef(iframeSrc);
  useEffect(() => {
    if (iframeSrc !== prevSrcRef.current) {
      prevSrcRef.current = iframeSrc;
      setReloadKey((k) => k + 1);
    }
  }, [iframeSrc]);

  if (!iframeSrc) {
    return (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        {/* drag region even on empty state so the window is movable */}
        <div className="drag-region h-[52px] shrink-0 border-b border-border" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">No preview URL available.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* ── Drag-region header ─────────────────────────────────────────────────
          h-[52px] + pl-[76px]: matches main window & dev-logs-popout header height
          and clears macOS traffic-light buttons (⬤ ⬤ ⬤).
          Interactive children opt out of drag via [-webkit-app-region:no-drag].   */}
      <div className="drag-region flex h-[52px] shrink-0 items-center gap-3 border-b border-border pl-[76px] pr-3">
        {/* Status dot + label */}
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
          <span className="text-xs font-medium text-foreground/90">Dev Preview</span>
        </div>

        {/* URL bar — read-only, shows the target host */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
          <span className="truncate">{iframeSrc}</span>
        </div>

        {/* Reload button */}
        <button
          type="button"
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [-webkit-app-region:no-drag]",
          )}
          onClick={handleReload}
          title="Reload preview"
        >
          <RotateCwIcon className={cn("size-3.5", isReloading && "animate-spin")} />
        </button>
      </div>

      {/* ── iframe ────────────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <iframe
          ref={iframeRef}
          key={`${iframeSrc}-${reloadKey}`}
          src={iframeSrc}
          title={`Dev Preview — ${displayHost}`}
          sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
          className="block size-full border-0 bg-white"
        />
      </div>
    </div>
  );
}
