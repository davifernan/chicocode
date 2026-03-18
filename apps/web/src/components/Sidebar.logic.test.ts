import { ThreadId, type OrchestrationSessionStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Thread, ThreadSession } from "../types";

import {
  compareThreadsForSidebarDisplayOrder,
  compareThreadsForSidebarOrder,
  getThreadLastActivityTime,
  hasUnseenCompletion,
  isThreadActivelyWorking,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  shouldShowThreadRelativeTime,
} from "./Sidebar.logic";

function makeSession(
  status: ThreadSession["status"],
  orchestrationStatus: OrchestrationSessionStatus,
): ThreadSession {
  return {
    provider: "codex",
    status,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    orchestrationStatus,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: "full-access",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:05:00.000Z",
    interactionMode: "default",
    messages: [],
    messageCount: 0,
    latestMessageAt: null,
    messagesHydrated: true,
    error: null,
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    session: null,
    ...overrides,
  };
}

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        proposedPlans: [],
        session: null,
      }),
    ).toBe(true);
  });
});

describe("thread recency helpers", () => {
  it("treats running and connecting threads as actively working", () => {
    expect(
      isThreadActivelyWorking(
        makeThread({
          session: makeSession("running", "running"),
        }),
      ),
    ).toBe(true);
    expect(
      isThreadActivelyWorking(
        makeThread({
          session: makeSession("connecting", "starting"),
        }),
      ),
    ).toBe(true);
    expect(
      isThreadActivelyWorking(
        makeThread({
          session: makeSession("ready", "ready"),
        }),
      ),
    ).toBe(false);
  });

  it("uses the latest semantic activity timestamp for last activity", () => {
    expect(
      getThreadLastActivityTime(
        makeThread({
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "Done",
              createdAt: "2026-03-09T10:05:00.000Z",
              completedAt: "2026-03-09T10:05:00.000Z",
              streaming: false,
            },
          ],
        }),
      ),
    ).toBe(Date.parse("2026-03-09T10:05:00.000Z"));
  });

  it("falls back to updatedAt when there is no semantic activity yet", () => {
    expect(
      getThreadLastActivityTime(
        makeThread({
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ),
    ).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });

  it("hides relative time labels while a thread is actively working", () => {
    expect(
      shouldShowThreadRelativeTime(
        makeThread({
          session: makeSession("running", "running"),
        }),
      ),
    ).toBe(false);
    expect(shouldShowThreadRelativeTime(makeThread())).toBe(true);
  });

  it("sorts active threads first, then by recent activity", () => {
    const workingThread = makeThread({
      id: ThreadId.makeUnsafe("thread-working"),
      updatedAt: "2026-03-09T10:01:00.000Z",
      session: makeSession("running", "running"),
    });
    const recentIdleThread = makeThread({
      id: ThreadId.makeUnsafe("thread-idle-recent"),
      updatedAt: "2026-03-09T10:10:00.000Z",
    });
    const olderIdleThread = makeThread({
      id: ThreadId.makeUnsafe("thread-idle-old"),
      updatedAt: "2026-03-09T10:03:00.000Z",
    });

    expect(
      [recentIdleThread, olderIdleThread, workingThread].toSorted(compareThreadsForSidebarOrder),
    ).toEqual([workingThread, recentIdleThread, olderIdleThread]);
  });

  it("keeps starred threads above status threads", () => {
    const workingThread = makeThread({
      id: ThreadId.makeUnsafe("thread-working"),
      session: makeSession("running", "running"),
    });
    const doneThread = makeThread({
      id: ThreadId.makeUnsafe("thread-done"),
      latestTurn: makeLatestTurn(),
      lastVisitedAt: "2026-03-09T10:04:00.000Z",
      session: makeSession("ready", "ready"),
    });
    const starredIdleThread = makeThread({
      id: ThreadId.makeUnsafe("thread-starred"),
      starred: true,
      updatedAt: "2026-03-09T10:10:00.000Z",
    });

    const workingStatus = {
      label: "Working",
      colorClass: "",
      dotClass: "",
      pulse: true,
    } as const;
    const doneStatus = {
      label: "Done",
      colorClass: "",
      dotClass: "",
      pulse: false,
    } as const;
    const sorted = [starredIdleThread, doneThread, workingThread].toSorted((a, b) =>
      compareThreadsForSidebarDisplayOrder(
        a,
        b,
        a.id === workingThread.id ? workingStatus : a.id === doneThread.id ? doneStatus : null,
        b.id === workingThread.id ? workingStatus : b.id === doneThread.id ? doneStatus : null,
      ),
    );

    expect(sorted).toEqual([starredIdleThread, workingThread, doneThread]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    proposedPlans: [],
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("shows done when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Done", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the darker selected palette when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("keeps the accent palette for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-accent/85");
    expect(className).toContain("hover:bg-accent");
  });
});
