import {
  ArrowUpRightIcon,
  CheckIcon,
  ClipboardIcon,
  ExternalLinkIcon,
  RotateCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { renderLogLine } from "~/lib/ansiRenderer";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

interface DevLogsPanelProps {
  logs: string[];
  serverUrl?: string | undefined;
  /** Package manager detected by the server (bun, npm, yarn, pnpm) */
  packageManager?: string | undefined;
  /** Project name shown in the embedded-panel header */
  projectName?: string | undefined;
  /** Called when the user clicks the popout button (embedded panel only) */
  onPopout?: (() => void) | undefined;
  /** When true: renders the popout layout (drag region, URL bar, restart button) */
  isPopout?: boolean | undefined;
  /**
   * Called when the user clicks the restart button.
   * The returned Promise is awaited — the button spins until it resolves.
   */
  onRestart?: (() => Promise<void>) | undefined;
  className?: string | undefined;
}

/** Extracts ":PORT" from a URL string, e.g. "http://localhost:3001" → ":3001" */
function extractPortLabel(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { port } = new URL(url);
    return port ? `:${port}` : null;
  } catch {
    return null;
  }
}

export function DevLogsPanel({
  logs,
  serverUrl,
  packageManager,
  projectName,
  onPopout,
  isPopout,
  onRestart,
  className,
}: DevLogsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [urlCopied, setUrlCopied] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  // Auto-scroll to bottom when new logs arrive, unless the user has scrolled up
  useEffect(() => {
    if (!isAtBottom) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, isAtBottom]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    setIsAtBottom(atBottom);
  };

  const handleCopyUrl = () => {
    if (!serverUrl) return;
    void navigator.clipboard.writeText(serverUrl);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 1500);
  };

  const handleRestartClick = async () => {
    if (isRestarting || !onRestart) return;
    setIsRestarting(true);
    try {
      await onRestart();
    } finally {
      setIsRestarting(false);
    }
  };

  const portLabel = extractPortLabel(serverUrl);

  return (
    <div className={cn("flex flex-col bg-background", className)}>
      {isPopout ? (
        // ── Popout header ───────────────────────────────────────────────────────
        // drag-region: whole bar is draggable; pl-[76px] clears macOS traffic lights.
        // h-[52px] matches the standard Electron title-bar height used elsewhere.
        // Buttons/inputs auto-get -webkit-app-region:no-drag via the .drag-region CSS rule.
        <div className="drag-region flex h-[52px] shrink-0 items-center gap-3 border-b border-border pl-[76px] pr-3">
          {/* Left: status dot + label + pm badge */}
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
            <span className="text-xs font-medium text-foreground/90">Dev Logs</span>
            {packageManager && (
              <Badge
                variant="outline"
                size="sm"
                className="shrink-0 font-mono text-muted-foreground"
              >
                {packageManager}
              </Badge>
            )}
          </div>

          {/* Center: URL bar — styled like a minimal browser address bar */}
          {serverUrl ? (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground [-webkit-app-region:no-drag]"
              onClick={() => {
                // In Electron, use desktopBridge.openExternal so the URL
                // goes directly to shell.openExternal → system browser,
                // bypassing setWindowOpenHandler entirely.
                if (window.desktopBridge) {
                  void window.desktopBridge.openExternal(serverUrl);
                } else {
                  window.open(serverUrl, "_blank", "noopener,noreferrer");
                }
              }}
              title={`Open ${serverUrl} in browser`}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
              <span className="truncate">{serverUrl}</span>
              <ExternalLinkIcon className="size-2.5 shrink-0 opacity-40" />
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2.5 py-1 font-mono text-[11px] text-muted-foreground/50">
              <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
              <span>Starting…</span>
            </div>
          )}

          {/* Right: restart button */}
          {onRestart && (
            <Button
              size="xs"
              variant="ghost"
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
              onClick={() => void handleRestartClick()}
              disabled={isRestarting}
              title="Restart dev server"
            >
              <RotateCwIcon className={cn("size-3.5", isRestarting && "animate-spin")} />
            </Button>
          )}
        </div>
      ) : (
        // ── Embedded panel header ───────────────────────────────────────────────
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          {/* Left: status dot + label + badges + project name */}
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
            <span className="shrink-0 text-xs font-medium text-foreground/90">Dev Logs</span>

            {packageManager && (
              <Badge
                variant="outline"
                size="sm"
                className="shrink-0 font-mono text-muted-foreground"
              >
                {packageManager}
              </Badge>
            )}

            {/* Port badge — click to copy the full URL */}
            {portLabel && serverUrl && (
              <Badge
                variant="outline"
                size="sm"
                render={
                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    title={urlCopied ? "Copied!" : `Copy ${serverUrl}`}
                  />
                }
                className={cn(
                  "shrink-0 gap-0.5 font-mono transition-colors",
                  urlCopied
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "cursor-pointer text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {urlCopied ? (
                  <>
                    <CheckIcon className="size-2.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <ClipboardIcon className="size-2.5 opacity-60" />
                    {portLabel}
                  </>
                )}
              </Badge>
            )}

            {projectName && (
              <span className="truncate text-xs text-muted-foreground">· {projectName}</span>
            )}
          </div>

          {/* Right: popout button */}
          <div className="flex shrink-0 items-center">
            {onPopout && (
              <Button
                size="xs"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                onClick={onPopout}
                title="Open in separate window"
              >
                <ArrowUpRightIcon className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Log output */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-2 font-mono"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Waiting for dev server output…
          </div>
        ) : (
          <div className="space-y-0.5">
            {logs.map((line, i) => (
              <div
                key={i} // eslint-disable-line react/no-array-index-key
                className="whitespace-pre-wrap break-all text-xs leading-5 text-foreground/80"
              >
                {renderLogLine(line)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
