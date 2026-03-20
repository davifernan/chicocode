import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { DraftThreadState } from "./composerDraftStore";
import type { Thread } from "./types";

import { LOCAL_DRAFT_THREAD_TITLE, resolveProjectThreadsWithDraft } from "./draftThreads";

const PROJECT_ID = "project-1" as ProjectId;
const DRAFT_THREAD_ID = ThreadId.makeUnsafe("draft-thread-1");

function makeDraftThread(overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    projectId: PROJECT_ID,
    createdAt: "2026-03-09T10:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Existing thread",
    model: "gpt-5-codex",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    messageCount: 0,
    latestMessageAt: null,
    messagesHydrated: true,
    error: null,
    createdAt: "2026-03-09T09:00:00.000Z",
    updatedAt: "2026-03-09T09:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    ...overrides,
  };
}

describe("resolveProjectThreadsWithDraft", () => {
  it("includes a local draft thread for the project", () => {
    const projectThreads = resolveProjectThreadsWithDraft({
      projectId: PROJECT_ID,
      projectModel: "gpt-5-codex",
      projectDraftThreadId: DRAFT_THREAD_ID,
      draftThreadsByThreadId: {
        [DRAFT_THREAD_ID]: makeDraftThread(),
      },
      threads: [],
    });

    expect(projectThreads).toHaveLength(1);
    expect(projectThreads[0]).toMatchObject({
      id: DRAFT_THREAD_ID,
      projectId: PROJECT_ID,
      title: LOCAL_DRAFT_THREAD_TITLE,
    });
  });

  it("prefers the server thread when the draft has already been promoted", () => {
    const serverThread = makeThread({ id: DRAFT_THREAD_ID, title: "Real title" });

    const projectThreads = resolveProjectThreadsWithDraft({
      projectId: PROJECT_ID,
      projectModel: "gpt-5-codex",
      projectDraftThreadId: DRAFT_THREAD_ID,
      draftThreadsByThreadId: {
        [DRAFT_THREAD_ID]: makeDraftThread(),
      },
      threads: [serverThread],
    });

    expect(projectThreads).toEqual([serverThread]);
  });
});
