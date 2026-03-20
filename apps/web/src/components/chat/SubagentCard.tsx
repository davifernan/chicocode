import { BotIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import {
  formatElapsed,
  type SubagentTimelineEntryData,
  type WorkLogEntry,
} from "../../session-logic";
import { Badge } from "../ui/badge";
import { cn } from "~/lib/utils";

interface SubagentCardProps {
  subagent: SubagentTimelineEntryData;
  expanded: boolean;
  nowIso: string;
  onToggleInternals: () => void;
  renderInternalEntry: (entry: WorkLogEntry) => ReactNode;
}

function subagentStatusLabel(status: SubagentTimelineEntryData["status"]): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Running";
  }
}

function subagentStatusVariant(
  status: SubagentTimelineEntryData["status"],
): "info" | "success" | "error" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    default:
      return "info";
  }
}

function subagentElapsedText(subagent: SubagentTimelineEntryData, nowIso: string): string | null {
  const elapsed = formatElapsed(subagent.startedAt, subagent.completedAt ?? nowIso);
  if (!elapsed) {
    return null;
  }
  return elapsed;
}

function subagentStatusBadgeClass(status: SubagentTimelineEntryData["status"]): string {
  switch (status) {
    case "completed":
      return "border-success/20 bg-success/10 text-success-foreground dark:bg-success/14";
    case "failed":
      return "border-destructive/20 bg-destructive/10 text-destructive-foreground dark:bg-destructive/14";
    default:
      return "border-info/20 bg-info/10 text-info-foreground dark:bg-info/14";
  }
}

function subagentStatusDotClass(status: SubagentTimelineEntryData["status"]): string {
  switch (status) {
    case "completed":
      return "bg-success";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-info animate-pulse";
  }
}

function sectionShellClassName(
  kind: "input" | "output",
  status: SubagentTimelineEntryData["status"],
): string {
  if (kind === "input") {
    return "border-border/55 bg-background/45 text-foreground/80";
  }

  if (status === "failed") {
    return "border-destructive/18 bg-destructive/6 text-rose-300/90 dark:text-rose-200/90";
  }

  return "border-border/60 bg-background/70 text-foreground/84";
}

export const SubagentCard = memo(function SubagentCard(props: SubagentCardProps) {
  const {
    subagent,
    expanded: bodyExpanded,
    nowIso,
    onToggleInternals: onToggleBody,
    renderInternalEntry,
  } = props;
  const outputText = subagent.errorMessage ?? subagent.outputText ?? null;
  const elapsedText = subagentElapsedText(subagent, nowIso);
  const hasInternals = subagent.internals.length > 0;
  const hasDetails = Boolean(subagent.inputText || outputText || subagent.status === "running");
  const hasExpandableBody = hasDetails || hasInternals;
  const shouldClampOutput = Boolean(outputText && outputText.length > 420);
  const ToggleIcon = bodyExpanded ? ChevronUpIcon : ChevronDownIcon;

  return (
    <div
      className="overflow-hidden rounded-2xl border border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] shadow-[0_1px_0_rgba(255,255,255,0.03),0_18px_40px_rgba(0,0,0,0.16)]"
      data-subagent-card="true"
    >
      <div className="border-b border-border/55 bg-background/35 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-[9px]">
              <span className="mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/78 text-foreground/76 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <BotIcon className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/46">
                  Subagent
                </p>
                <div className="mt-1 flex items-start justify-between gap-2.5">
                  <div className="min-w-0 flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground/64">
                    {elapsedText && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-border/55 bg-background/52 px-1.5 py-[3px] font-medium tabular-nums text-foreground/70">
                        <span className="text-muted-foreground/50">Runtime</span>
                        <span>{elapsedText}</span>
                      </span>
                    )}
                    <span
                      className="inline-flex max-w-[18ch] items-center truncate rounded-md border border-border/55 bg-background/40 px-1.5 py-[3px] font-mono text-[9px] text-muted-foreground/62"
                      title={subagent.childSessionId}
                    >
                      {subagent.childSessionId}
                    </span>
                    {subagent.status === "failed" && subagent.errorMessage && (
                      <span className="inline-flex items-center rounded-md border border-destructive/18 bg-destructive/8 px-1.5 py-[3px] text-destructive-foreground/78">
                        Error returned
                      </span>
                    )}
                  </div>
                  {hasExpandableBody && (
                    <button
                      type="button"
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg border border-border/55 bg-background/48 text-muted-foreground/68 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-border/75 hover:bg-background/66 hover:text-foreground/84"
                      aria-expanded={bodyExpanded}
                      aria-label={
                        bodyExpanded ? "Collapse subagent details" : "Expand subagent details"
                      }
                      onClick={onToggleBody}
                    >
                      <ToggleIcon className="size-3.5" />
                    </button>
                  )}
                </div>
                <p className="truncate pt-1.5 text-sm font-semibold tracking-tight text-foreground/94">
                  {subagent.title}
                </p>
              </div>
            </div>
          </div>
          <Badge
            variant={subagentStatusVariant(subagent.status)}
            size="sm"
            className={cn(
              "h-5 min-w-0 shrink-0 gap-1 rounded-full border px-[9px] py-0 text-[10px] font-semibold tracking-[0.01em] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
              subagentStatusBadgeClass(subagent.status),
            )}
          >
            <span
              className={cn("size-1.5 rounded-full", subagentStatusDotClass(subagent.status))}
              aria-hidden="true"
            />
            {subagentStatusLabel(subagent.status)}
          </Badge>
        </div>
      </div>

      {hasExpandableBody && bodyExpanded && (
        <div className="space-y-3 px-3 py-3">
          {hasDetails && (
            <section className="space-y-2.5 rounded-xl border border-border/55 bg-background/28 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
              {subagent.inputText && (
                <section className="space-y-[5px]">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/52">
                      Input
                    </p>
                    <span className="text-[9px] text-muted-foreground/34">Instruction</span>
                  </div>
                  <div
                    className={cn(
                      "rounded-xl border px-3 py-[9px] text-[12px] leading-[1.45rem] whitespace-pre-wrap break-words shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
                      sectionShellClassName("input", subagent.status),
                    )}
                  >
                    <div className="max-w-[74ch]">{subagent.inputText}</div>
                  </div>
                </section>
              )}

              <section className="space-y-[5px]">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/52">
                    Output
                  </p>
                  <span className="text-[9px] text-muted-foreground/34">
                    {subagent.status === "failed"
                      ? "Result"
                      : subagent.status === "running"
                        ? "Streaming"
                        : "Final"}
                  </span>
                </div>
                <div
                  className={cn(
                    "rounded-xl border px-3 py-[9px] text-[12px] leading-[1.45rem] whitespace-pre-wrap break-words shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
                    sectionShellClassName("output", subagent.status),
                  )}
                >
                  {outputText ? (
                    <div
                      className={cn(
                        "max-w-[74ch]",
                        shouldClampOutput &&
                          "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_78%,transparent)]",
                      )}
                    >
                      {outputText}
                    </div>
                  ) : subagent.status === "running" ? (
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground/70">
                      <span className="inline-flex items-center gap-1 rounded-full border border-info/18 bg-info/8 px-2 py-[3px] text-[10px] font-medium text-info-foreground/78">
                        <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
                          <span className="h-1 w-1 rounded-full bg-info/70 animate-pulse" />
                          <span className="h-1 w-1 rounded-full bg-info/70 animate-pulse [animation-delay:160ms]" />
                          <span className="h-1 w-1 rounded-full bg-info/70 animate-pulse [animation-delay:320ms]" />
                        </span>
                        Working
                      </span>
                      <span className="text-[11px] text-muted-foreground/56">
                        Awaiting final output
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground/62">No output captured.</span>
                  )}
                </div>
              </section>
            </section>
          )}

          {hasInternals && (
            <section className="rounded-lg border border-border/42 bg-background/14 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/46">
                    Internals
                  </p>
                  <p className="text-[10px] text-muted-foreground/56">
                    {subagent.internals.length} runtime event
                    {subagent.internals.length === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
              <div className="mt-2 space-y-0.5 border-l border-border/38 pl-2.5">
                {subagent.internals.map(renderInternalEntry)}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
});
