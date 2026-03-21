/**
 * RunMiniBar — compact run selector shown when a run is active in RunDetail.
 * Renders runs as small pills; clicking one switches the active run.
 */

import { ChevronDownIcon } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/utils";
import type { ChicoRunSnapshot } from "@t3tools/contracts";

interface Props {
  runs: ChicoRunSnapshot[];
  selectedRunId: string;
  onSelectRun: (runId: string) => void;
  onClearSelection: () => void;
}

function RunPill({
  run,
  isSelected,
  onClick,
}: {
  run: ChicoRunSnapshot;
  isSelected: boolean;
  onClick: () => void;
}) {
  const isActive = run.status === "active";
  const isTerminal = run.phase === "complete";
  const isError = run.phase === "error" || run.phase === "failed";

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all",
        "border",
        isSelected
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          isSelected && isActive && !isTerminal && !isError && "bg-primary animate-pulse",
          isTerminal && "bg-green-500",
          isError && "bg-destructive",
          !isActive && "bg-muted-foreground/30",
          isActive && !isTerminal && !isError && !isSelected && "bg-primary/60",
        )}
      />
      <span className="truncate max-w-[120px]">{run.projectName || run.runId}</span>
    </button>
  );
}

export function RunMiniBar({ runs, selectedRunId, onSelectRun, onClearSelection }: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  // Show up to 3 pills inline; overflow goes into dropdown
  const INLINE_LIMIT = 3;
  const inlineRuns = runs.slice(0, INLINE_LIMIT);
  const overflowRuns = runs.slice(INLINE_LIMIT);

  return (
    <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 bg-background/80 backdrop-blur-sm">
      {/* Back to overview */}
      <button
        onClick={onClearSelection}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors mr-1"
        title="Back to all runs"
      >
        ← All runs
      </button>

      <div className="h-3 w-px bg-border mx-1" />

      {/* Inline run pills */}
      {inlineRuns.map((run) => (
        <RunPill
          key={run.runId}
          run={run}
          isSelected={run.runId === selectedRunId}
          onClick={() => onSelectRun(run.runId)}
        />
      ))}

      {/* Overflow dropdown */}
      {overflowRuns.length > 0 && (
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            className={cn(
              "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs",
              "border border-border bg-muted/40 text-muted-foreground",
              "hover:bg-muted hover:text-foreground transition-colors",
            )}
          >
            +{overflowRuns.length}
            <ChevronDownIcon className="size-3" />
          </button>
          {dropdownOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 min-w-[160px] rounded-md border border-border bg-popover shadow-md">
              {overflowRuns.map((run) => (
                <button
                  key={run.runId}
                  onClick={() => {
                    onSelectRun(run.runId);
                    setDropdownOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-xs text-left",
                    "hover:bg-accent transition-colors",
                    run.runId === selectedRunId && "text-primary font-medium",
                  )}
                >
                  {run.projectName || run.runId}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
