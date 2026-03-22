/**
 * WorkersGrid — compact table of all workers in a run.
 */

import { cn } from "../../lib/utils";
import type { ChicoRunSnapshot, ChicoWorkerSnapshot } from "@t3tools/contracts";
import { lifecycleIcon, lifecycleColor, formatElapsed } from "./utils";
import { useLiveElapsed } from "./useLiveElapsed";

function WorkerRow({ worker }: { worker: ChicoWorkerSnapshot }) {
  const isManager = worker.id === 999;
  // Convert startedAt (number | null) to an ISO string for useLiveElapsed,
  // which expects a string timestamp. null means not started yet.
  const startedAtIso = worker.startedAt != null ? new Date(worker.startedAt).toISOString() : null;
  const elapsedMs = useLiveElapsed(startedAtIso);
  const elapsed = worker.startedAt != null ? formatElapsed(elapsedMs) : "—";

  return (
    <div
      className={cn(
        "grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-3 items-baseline",
        "px-4 py-1.5 text-xs border-b border-border/50 last:border-0",
        "hover:bg-accent/20 transition-colors",
        isManager && "bg-muted/30",
      )}
    >
      {/* Lifecycle icon */}
      <span className={cn("font-mono text-[11px]", lifecycleColor(worker.lifecycle))}>
        {lifecycleIcon(worker.lifecycle)}
      </span>

      {/* Label + activity */}
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className={cn("font-medium text-foreground/90", isManager && "text-primary/90")}>
          {isManager ? "Manager" : worker.label || `worker-${worker.id}`}
        </span>
        {worker.activity && (
          <span className="text-muted-foreground/70 truncate text-[11px] font-mono leading-tight">
            {worker.activity}
          </span>
        )}
      </div>

      {/* Steps */}
      <span className="font-mono text-muted-foreground/60 tabular-nums">
        {worker.steps > 0 ? `${worker.steps}s` : "—"}
      </span>

      {/* Cost */}
      <span className="font-mono text-muted-foreground/70 tabular-nums">
        {worker.cost > 0 ? `$${worker.cost.toFixed(2)}` : "—"}
      </span>

      {/* Elapsed */}
      <span className="font-mono text-muted-foreground/50 tabular-nums">{elapsed}</span>
    </div>
  );
}

interface Props {
  run: ChicoRunSnapshot;
}

export function WorkersGrid({ run }: Props) {
  const manager = run.workers.find((w) => w.id === 999);
  const workers = run.workers.filter((w) => w.id !== 999).toSorted((a, b) => a.id - b.id);

  if (run.workers.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-xs text-muted-foreground/50">
        No workers yet
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Column headers */}
      <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-3 px-4 py-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground/40 border-b border-border/50">
        <span />
        <span>Worker</span>
        <span>Steps</span>
        <span>Cost</span>
        <span>Time</span>
      </div>

      {manager && <WorkerRow key={999} worker={manager} />}
      {workers.map((w) => (
        <WorkerRow key={w.id} worker={w} />
      ))}
    </div>
  );
}
