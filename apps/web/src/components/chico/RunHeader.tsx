/**
 * RunHeader — shows phase, elapsed time, total cost and model info
 * for the currently selected run.
 */

import { cn } from "../../lib/utils";
import type { ChicoRunSnapshot } from "@t3tools/contracts";
import { formatElapsed } from "./utils";
import { useLiveElapsed } from "./useLiveElapsed";

interface Props {
  run: ChicoRunSnapshot;
}

function StatBadge({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-0.5 px-3", className)}>
      <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60">
        {label}
      </span>
      <span className="text-sm font-mono font-medium text-foreground">{value}</span>
    </div>
  );
}

function PhaseChip({ phase }: { phase: string }) {
  const isTerminal = phase === "complete";
  const isError = phase === "error" || phase === "failed";
  const isRunning = !isTerminal && !isError;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-mono font-medium",
        "border",
        isTerminal && "border-green-500/30 bg-green-500/10 text-green-500",
        isError && "border-destructive/30 bg-destructive/10 text-destructive",
        isRunning && "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          isTerminal && "bg-green-500",
          isError && "bg-destructive",
          isRunning && "bg-primary animate-pulse",
        )}
      />
      {phase.replace(/_/g, " ")}
    </div>
  );
}

export function RunHeader({ run }: Props) {
  const elapsedMs = useLiveElapsed(run.connectedAt);

  const managerWorker = run.workers.find((w) => w.id === 999);
  const workerWorkers = run.workers.filter((w) => w.id !== 999);
  const activeWorkers = workerWorkers.filter(
    (w) => w.lifecycle === "running" || w.lifecycle === "idle",
  ).length;

  return (
    <div className="flex flex-wrap items-center gap-x-0 gap-y-2 border-b border-border px-4 py-3 bg-card/50">
      {/* Project + phase */}
      <div className="flex flex-1 items-center gap-3 min-w-0 mr-4">
        <h2 className="text-sm font-semibold text-foreground truncate">
          {run.projectName || run.runId}
        </h2>
        <PhaseChip phase={run.phase} />
      </div>

      {/* Stats */}
      <div className="flex items-center divide-x divide-border">
        <StatBadge label="elapsed" value={formatElapsed(elapsedMs)} />
        <StatBadge
          label="cost"
          value={run.totalCostUsd > 0 ? `$${run.totalCostUsd.toFixed(3)}` : "—"}
        />
        {workerWorkers.length > 0 && (
          <StatBadge label="workers" value={`${activeWorkers}/${workerWorkers.length}`} />
        )}
        {managerWorker && (
          <StatBadge
            label="manager"
            value={managerWorker.lifecycle === "completed" ? "done" : managerWorker.lifecycle}
            className={cn(
              managerWorker.lifecycle === "completed" && "[&_span:last-child]:text-green-500",
            )}
          />
        )}
        {run.status === "disconnected" && (
          <StatBadge
            label="status"
            value="disconnected"
            className="[&_span:last-child]:text-muted-foreground/60"
          />
        )}
      </div>
    </div>
  );
}
