import type { Thread } from "../types";
import { cn } from "../lib/utils";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export type SidebarNewThreadEnvMode = "local" | "worktree";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Done"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready"
    | "Draft";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "proposedPlans" | "session"
>;

type ThreadRecencyInput = Pick<
  Thread,
  | "createdAt"
  | "id"
  | "latestMessageAt"
  | "latestTurn"
  | "messages"
  | "proposedPlans"
  | "session"
  | "updatedAt"
>;

type ThreadSidebarDisplayOrderInput = ThreadRecencyInput & Pick<Thread, "starred">;

function toTimestamp(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

export function isThreadActivelyWorking(thread: Pick<Thread, "session">): boolean {
  return thread.session?.status === "running" || thread.session?.status === "connecting";
}

function getLatestDefinedTimestamp(...timestamps: readonly (string | null | undefined)[]): number {
  let latest = 0;
  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    latest = Math.max(latest, toTimestamp(timestamp));
  }
  return latest;
}

export function getThreadLastActivityTime(thread: {
  readonly createdAt: string;
  readonly latestMessageAt: string | null;
  readonly latestTurn: Thread["latestTurn"];
  readonly messages: Thread["messages"];
  readonly proposedPlans: Thread["proposedPlans"];
  readonly updatedAt: string;
}): number {
  const latestMessageTime = Math.max(
    getLatestDefinedTimestamp(thread.latestMessageAt),
    thread.messages.reduce(
      (latest, message) =>
        Math.max(latest, getLatestDefinedTimestamp(message.completedAt, message.createdAt)),
      0,
    ),
  );
  const latestTurnTime = getLatestDefinedTimestamp(
    thread.latestTurn?.completedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.requestedAt,
  );
  const latestProposedPlanTime = thread.proposedPlans.reduce(
    (latest, proposedPlan) =>
      Math.max(latest, getLatestDefinedTimestamp(proposedPlan.updatedAt, proposedPlan.createdAt)),
    0,
  );
  const hasSemanticActivity =
    latestMessageTime > 0 || latestTurnTime > 0 || latestProposedPlanTime > 0;

  return Math.max(
    toTimestamp(thread.createdAt),
    latestMessageTime,
    latestTurnTime,
    latestProposedPlanTime,
    hasSemanticActivity ? 0 : toTimestamp(thread.updatedAt),
  );
}

export function shouldShowThreadRelativeTime(thread: Pick<Thread, "session">): boolean {
  return !isThreadActivelyWorking(thread);
}

export function compareThreadsForSidebarOrder(
  a: ThreadRecencyInput,
  b: ThreadRecencyInput,
): number {
  const activeDelta = Number(isThreadActivelyWorking(b)) - Number(isThreadActivelyWorking(a));
  if (activeDelta !== 0) {
    return activeDelta;
  }

  const activityDelta = getThreadLastActivityTime(b) - getThreadLastActivityTime(a);
  if (activityDelta !== 0) {
    return activityDelta;
  }

  const createdDelta = toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return b.id.localeCompare(a.id);
}

export function compareThreadsForSidebarDisplayOrder(
  a: ThreadSidebarDisplayOrderInput,
  b: ThreadSidebarDisplayOrderInput,
  aStatus: ThreadStatusPill | null,
  bStatus: ThreadStatusPill | null,
): number {
  const starredDelta = Number(b.starred === true) - Number(a.starred === true);
  if (starredDelta !== 0) {
    return starredDelta;
  }

  const statusDelta = Number(bStatus !== null) - Number(aStatus !== null);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  return compareThreadsForSidebarOrder(a, b);
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    hasActionableProposedPlan(
      findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    );
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Done",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}
