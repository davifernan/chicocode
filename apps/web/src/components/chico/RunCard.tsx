/**
 * RunCard — displays a single Chico run in the selector grid.
 */

import { CircleIcon, CheckCircle2Icon, XCircleIcon, Loader2Icon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ChicoRunSnapshot } from "@t3tools/contracts";
import { formatElapsed } from "./utils";
import { useLiveElapsed } from "./useLiveElapsed";

interface Props {
  run: ChicoRunSnapshot;
  onClick: () => void;
}

function PhaseLabel({ phase }: { phase: string }) {
  const isTerminal = phase === "complete" || phase === "error" || phase === "failed";
  const isRunning =
    phase.includes("spawning") ||
    phase.includes("running") ||
    phase.includes("merging") ||
    phase.includes("finalizing");

  return (
    <span
      className={cn(
        "text-[10px] font-mono tracking-wide uppercase",
        isTerminal && phase !== "error" && phase !== "failed" && "text-green-500",
        (phase === "error" || phase === "failed") && "text-destructive",
        isRunning && "text-primary",
        !isTerminal && !isRunning && "text-muted-foreground",
      )}
    >
      {phase.replace(/_/g, " ")}
    </span>
  );
}

function StatusIcon({ run }: { run: ChicoRunSnapshot }) {
  if (run.status === "disconnected") {
    return <CircleIcon className="size-2 text-muted-foreground/40" />;
  }
  const phase = run.phase;
  if (phase === "complete") return <CheckCircle2Icon className="size-3 text-green-500" />;
  if (phase === "error" || phase === "failed")
    return <XCircleIcon className="size-3 text-destructive" />;
  return <Loader2Icon className="size-3 text-primary animate-spin" />;
}

export function RunCard({ run, onClick }: Props) {
  const activeWorkers = run.workers.filter(
    (w) => w.lifecycle === "running" || w.lifecycle === "idle",
  ).length;
  const totalWorkers = run.workers.filter((w) => w.id !== 999).length;

  const connectedMs = useLiveElapsed(run.connectedAt);

  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex flex-col gap-3 rounded-lg border border-border",
        "bg-card p-4 text-left transition-all duration-150",
        "hover:border-primary/40 hover:bg-accent/30 hover:shadow-sm",
        run.status === "disconnected" && "opacity-60",
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon run={run} />
          <span className="font-semibold text-sm truncate text-foreground">
            {run.projectName || run.runId}
          </span>
        </div>
        <PhaseLabel phase={run.phase} />
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
        {totalWorkers > 0 && (
          <span>
            <span className="text-foreground font-medium">{activeWorkers}</span>
            <span className="text-muted-foreground/60">/{totalWorkers}</span> workers
          </span>
        )}
        {run.totalCostUsd > 0 && (
          <span>
            <span className="text-foreground font-medium">${run.totalCostUsd.toFixed(2)}</span>
          </span>
        )}
        <span>{formatElapsed(connectedMs)}</span>
      </div>

      {/* Run ID sub-label */}
      <p className="text-[10px] font-mono text-muted-foreground/40 truncate">{run.runId}</p>
    </button>
  );
}
