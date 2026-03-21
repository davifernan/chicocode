/**
 * RunGrid — shows all known Chico runs as clickable cards.
 * Displayed when no run is selected.
 */

import { ActivityIcon } from "lucide-react";
import type { ChicoRunSnapshot } from "@t3tools/contracts";
import { RunCard } from "./RunCard";

interface Props {
  runs: ChicoRunSnapshot[];
  onSelectRun: (runId: string) => void;
}

export function RunGrid({ runs, onSelectRun }: Props) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center p-8">
        <div className="rounded-full bg-muted/50 p-4">
          <ActivityIcon className="size-8 text-muted-foreground/40" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">No runs connected</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Start a Chico run with{" "}
            <span className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">
              CHICO_GRPC_ENDPOINT
            </span>{" "}
            pointing to this server.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-4 auto-rows-min">
      {runs.map((run) => (
        <RunCard key={run.runId} run={run} onClick={() => onSelectRun(run.runId)} />
      ))}
    </div>
  );
}
