/**
 * RunDetail — full detail view for a selected Chico run.
 * Composes RunHeader, WorkersGrid, and EventStream in a split layout.
 */

import type { ChicoRunSnapshot } from "@t3tools/contracts";
import { RunHeader } from "./RunHeader";
import { WorkersGrid } from "./WorkersGrid";
import { EventStream } from "./EventStream";

interface Props {
  run: ChicoRunSnapshot;
}

export function RunDetail({ run }: Props) {
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <RunHeader run={run} />

      {/* Content split: workers (top) + events (bottom) */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Workers panel */}
        <div className="overflow-y-auto max-h-[40%] border-b border-border shrink-0">
          <WorkersGrid run={run} />
        </div>

        {/* Event stream — fills remaining space */}
        <EventStream run={run} />
      </div>
    </div>
  );
}
