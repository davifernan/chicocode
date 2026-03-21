/**
 * ChicoCenter — self-contained Chico Observability root component.
 *
 * This component is intentionally designed to be embeddable anywhere:
 *   - As the main outlet in the /chico route
 *   - Later: as a popover/panel, sidebar widget, or popout window
 *
 * Manages its own bootstrapping and subscriptions via useChicoSubscriptions.
 *
 * @module ChicoCenter
 */

import { useMemo } from "react";
import { useChicoStore } from "../../chico/chicoStore";
import { useChicoSubscriptions } from "../../chico/useChicoSubscriptions";
import { ChicoServerInfo } from "./ChicoServerInfo";
import { RunGrid } from "./RunGrid";
import { RunMiniBar } from "./RunMiniBar";
import { RunDetail } from "./RunDetail";
import { Loader2Icon } from "lucide-react";

export function ChicoCenter() {
  useChicoSubscriptions();

  const isBootstrapping = useChicoStore((s) => s.isBootstrapping);
  const bootstrapError = useChicoStore((s) => s.bootstrapError);
  const serverInfo = useChicoStore((s) => s.serverInfo);
  const runsById = useChicoStore((s) => s.runs);
  const selectedRunId = useChicoStore((s) => s.selectedRunId);
  const selectRun = useChicoStore((s) => s.selectRun);

  // Avoid returning fresh arrays/objects directly from Zustand selectors.
  // `useSyncExternalStore` treats unstable selector results as changed even when
  // the underlying store snapshot is the same, which can cause infinite
  // re-render loops in production builds.
  const runs = useMemo(
    () =>
      Array.from(runsById.values()).toSorted(
        (a, b) => new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime(),
      ),
    [runsById],
  );
  const selectedRun = useMemo(
    () => (selectedRunId ? runsById.get(selectedRunId) ?? null : null),
    [runsById, selectedRunId],
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      {/* Top bar: title + server info */}
      <div className="flex items-center justify-between gap-4 px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">Chico Central</span>
          {runs.length > 0 && (
            <span className="text-xs font-mono text-muted-foreground/60">
              {runs.filter((r) => r.status === "active").length}/{runs.length} active
            </span>
          )}
        </div>
        {serverInfo && <ChicoServerInfo info={serverInfo} />}
      </div>

      {/* Body */}
      {isBootstrapping ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Connecting…
        </div>
      ) : bootstrapError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-destructive p-8 text-center">
          <p className="font-medium">Failed to connect</p>
          <p className="text-xs text-muted-foreground max-w-sm">{bootstrapError}</p>
        </div>
      ) : selectedRun ? (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Collapsed run bar + run detail */}
          <RunMiniBar
            runs={runs}
            selectedRunId={selectedRun.runId}
            onSelectRun={(id) => selectRun(id)}
            onClearSelection={() => selectRun(null)}
          />
          <RunDetail run={selectedRun} />
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
          <RunGrid runs={runs} onSelectRun={(id) => selectRun(id)} />
        </div>
      )}
    </div>
  );
}
