import { type ProjectId, type ThreadId } from "@t3tools/contracts";

import type { DraftThreadState } from "./composerDraftStore";
import type { Thread } from "./types";

export const LOCAL_DRAFT_THREAD_TITLE = "New Session";

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModel: string,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: LOCAL_DRAFT_THREAD_TITLE,
    starred: false,
    model: fallbackModel,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    messageCount: 0,
    latestMessageAt: null,
    messagesHydrated: true,
    error,
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    latestTurn: null,
    lastVisitedAt: draftThread.createdAt,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function resolveProjectThreadsWithDraft(input: {
  projectId: ProjectId;
  projectModel: string;
  projectDraftThreadId: ThreadId | undefined;
  draftThreadsByThreadId: Readonly<Record<ThreadId, DraftThreadState>>;
  threads: readonly Thread[];
}): Thread[] {
  const projectThreads = input.threads.filter((thread) => thread.projectId === input.projectId);
  const draftThreadId = input.projectDraftThreadId;

  if (!draftThreadId || projectThreads.some((thread) => thread.id === draftThreadId)) {
    return projectThreads;
  }

  const draftThread = input.draftThreadsByThreadId[draftThreadId];
  if (!draftThread || draftThread.projectId !== input.projectId) {
    return projectThreads;
  }

  return [
    ...projectThreads,
    buildLocalDraftThread(draftThreadId, draftThread, input.projectModel, null),
  ];
}
