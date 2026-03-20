import { Fragment, type ReactNode, createElement } from "react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DevServerInfo,
  type DevServerLogLinePayload,
  type ProviderKind,
  ThreadId,
  type OrchestrationSummaryReadModel,
  type OrchestrationSessionStatus,
  type OrchestrationThreadMessagesResult,
} from "@t3tools/contracts";
import {
  getModelOptions,
  normalizeModelSlug,
  resolveModelSlug,
  resolveModelSlugForProvider,
} from "@t3tools/shared/model";
import { create } from "zustand";
import { type ChatMessage, type Project, type Thread } from "./types";
import { Debouncer } from "@tanstack/react-pacer";
import { SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS, type SidebarOpenProjectLimit } from "./appSettings";

import { persistServerUiState } from "./serverUiState";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsHydrated: boolean;
  devServerByProjectId: Record<string, DevServerInfo>;
  devServerLogsByProjectId: Record<string, string[]>;
}

const PERSISTED_STATE_KEY = "t3code:renderer-state:v8";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const initialState: AppState = {
  projects: [],
  threads: [],
  threadsHydrated: false,
  devServerByProjectId: {},
  devServerLogsByProjectId: {},
};
type PersistedRendererState = {
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  starredThreadIds?: string[];
};

const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedStarredThreadIds = new Set<ThreadId>();

// ── Persist helpers ──────────────────────────────────────────────────

function applyPersistedRendererState(parsed: PersistedRendererState): void {
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  persistedStarredThreadIds.clear();

  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
      persistedProjectOrderCwds.push(cwd);
    }
  }
  for (const threadId of parsed.starredThreadIds ?? []) {
    if (typeof threadId === "string" && threadId.length > 0) {
      persistedStarredThreadIds.add(threadId as ThreadId);
    }
  }
}

function parsePersistedRendererState(raw: string | null): void {
  if (!raw) {
    applyPersistedRendererState({});
    return;
  }

  try {
    applyPersistedRendererState(JSON.parse(raw) as PersistedRendererState);
  } catch {
    applyPersistedRendererState({});
  }
}

function readLegacyPersistedStateValue(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(PERSISTED_STATE_KEY);
  } catch {
    return null;
  }
}

function readPersistedState(): AppState {
  parsePersistedRendererState(readLegacyPersistedStateValue());
  return { ...initialState };
}

let legacyKeysCleanedUp = false;

function writeLegacyPersistedStateValue(value: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (value === null) {
      window.localStorage.removeItem(PERSISTED_STATE_KEY);
    } else {
      window.localStorage.setItem(PERSISTED_STATE_KEY, value);
    }

    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

function serializePersistedState(state: AppState): string {
  return JSON.stringify({
    expandedProjectCwds: state.projects
      .filter((project) => project.expanded)
      .map((project) => project.cwd),
    projectOrderCwds: state.projects.map((project) => project.cwd),
    starredThreadIds: state.threads
      .filter((thread) => thread.starred === true)
      .map((thread) => thread.id),
  } satisfies PersistedRendererState);
}

function applyPersistedRendererStateToStore(state: AppState): AppState {
  const nextProjects = state.projects
    .map((project) => {
      const expanded = persistedExpandedProjectCwds.has(project.cwd);
      return project.expanded === expanded ? project : { ...project, expanded };
    })
    .map((project, incomingIndex) => ({
      project,
      incomingIndex,
      persistedIndex: persistedProjectOrderCwds.indexOf(project.cwd),
    }))
    .toSorted((a, b) => {
      const aHasPersistedIndex = a.persistedIndex >= 0;
      const bHasPersistedIndex = b.persistedIndex >= 0;
      if (aHasPersistedIndex !== bHasPersistedIndex) {
        return aHasPersistedIndex ? -1 : 1;
      }
      if (aHasPersistedIndex && bHasPersistedIndex) {
        return a.persistedIndex - b.persistedIndex;
      }
      return a.incomingIndex - b.incomingIndex;
    })
    .map((entry) => entry.project);

  const nextThreads = state.threads.map((thread) => {
    const starred = persistedStarredThreadIds.has(thread.id);
    return thread.starred === starred ? thread : { ...thread, starred };
  });

  const projectsChanged = nextProjects.some((project, index) => project !== state.projects[index]);
  const threadsChanged = nextThreads.some((thread, index) => thread !== state.threads[index]);
  if (!projectsChanged && !threadsChanged) {
    return state;
  }

  return {
    ...state,
    projects: nextProjects,
    threads: nextThreads,
  };
}

export function readPersistedRendererStateValue(): string | null {
  return readLegacyPersistedStateValue();
}

export function hydratePersistedRendererState(value: string | null): void {
  parsePersistedRendererState(value);
  writeLegacyPersistedStateValue(value);
  useStore.setState((state) => applyPersistedRendererStateToStore(state));
}

let rendererPersistenceReady = false;

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;

  const raw = serializePersistedState(state);
  writeLegacyPersistedStateValue(raw);
  if (rendererPersistenceReady) {
    persistServerUiState("rendererState", raw);
  }
}
const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function normalizeSidebarOpenProjectLimit(limit?: number): SidebarOpenProjectLimit {
  return SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS.includes(limit as SidebarOpenProjectLimit)
    ? (limit as SidebarOpenProjectLimit)
    : 1;
}

function applyExpandedProjectLimit(
  projects: Project[],
  preferredExpandedIds: readonly Project["id"][],
  maxExpandedProjects?: number,
): Project[] {
  const normalizedLimit = normalizeSidebarOpenProjectLimit(maxExpandedProjects);
  const nextExpandedIds = new Set<Project["id"]>();

  for (const projectId of preferredExpandedIds) {
    if (nextExpandedIds.has(projectId)) continue;
    nextExpandedIds.add(projectId);
    if (nextExpandedIds.size >= normalizedLimit) break;
  }

  return projects.map((project) => {
    const expanded = nextExpandedIds.has(project.id);
    return project.expanded === expanded ? project : { ...project, expanded };
  });
}

interface MapProjectsFromReadModelOptions {
  readonly persistedExpandedCwds?: ReadonlySet<string>;
  readonly persistedOrderCwds?: readonly string[];
}

export function mapProjectsFromReadModel(
  incoming: OrchestrationSummaryReadModel["projects"],
  previous: Project[],
  options?: MapProjectsFromReadModelOptions,
): Project[] {
  const expandedCwds = options?.persistedExpandedCwds ?? persistedExpandedProjectCwds;
  const orderCwds = options?.persistedOrderCwds ?? persistedProjectOrderCwds;
  const previousById = new Map(previous.map((project) => [project.id, project] as const));
  const previousByCwd = new Map(previous.map((project) => [project.cwd, project] as const));
  const previousOrderById = new Map(previous.map((project, index) => [project.id, index] as const));
  const previousOrderByCwd = new Map(
    previous.map((project, index) => [project.cwd, index] as const),
  );
  const persistedOrderByCwd = new Map(orderCwds.map((cwd, index) => [cwd, index] as const));

  const mappedProjects = incoming.map((project) => {
    const existing = previousById.get(project.id) ?? previousByCwd.get(project.workspaceRoot);
    return {
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      model:
        existing?.model ??
        resolveModelSlug(project.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.codex),
      expanded:
        existing?.expanded ??
        (expandedCwds.size > 0 ? expandedCwds.has(project.workspaceRoot) : false),
      scripts: project.scripts.map((script) => ({ ...script })),
    } satisfies Project;
  });

  return mappedProjects
    .map((project, incomingIndex) => {
      const previousIndex =
        previousOrderById.get(project.id) ?? previousOrderByCwd.get(project.cwd);
      const persistedIndex = persistedOrderByCwd.get(project.cwd);
      const sourceRank = previousIndex !== undefined ? 0 : persistedIndex !== undefined ? 1 : 2;
      const orderIndex = previousIndex ?? persistedIndex ?? incomingIndex;
      return { project, incomingIndex, orderIndex, sourceRank };
    })
    .toSorted((a, b) => {
      const bySourceRank = a.sourceRank - b.sourceRank;
      if (bySourceRank !== 0) return bySourceRank;
      const byOrder = a.orderIndex - b.orderIndex;
      if (byOrder !== 0) return byOrder;
      return a.incomingIndex - b.incomingIndex;
    })
    .map((entry) => entry.project);
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "opencode") {
    return providerName;
  }
  return "codex";
}

const CODEX_MODEL_SLUGS = new Set<string>(getModelOptions("codex").map((option) => option.slug));
const OPENCODE_MODEL_SLUGS = new Set<string>(
  getModelOptions("opencode").map((option) => option.slug),
);

function inferProviderForThreadModel(input: {
  readonly model: string;
  readonly sessionProviderName: string | null;
}): ProviderKind {
  if (input.sessionProviderName === "codex" || input.sessionProviderName === "opencode") {
    return input.sessionProviderName;
  }
  const normalizedCodex = normalizeModelSlug(input.model, "codex");
  if (normalizedCodex && CODEX_MODEL_SLUGS.has(normalizedCodex)) {
    return "codex";
  }
  const normalizedOpenCode = normalizeModelSlug(input.model, "opencode");
  if (normalizedOpenCode && OPENCODE_MODEL_SLUGS.has(normalizedOpenCode)) {
    return "opencode";
  }
  return "codex";
}

export function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function mapReadModelMessage(
  message: OrchestrationThreadMessagesResult["messages"][number],
): ChatMessage {
  const attachments = message.attachments?.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
  }));

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(
  state: AppState,
  readModel: OrchestrationSummaryReadModel,
): AppState {
  const projects = mapProjectsFromReadModel(
    readModel.projects.filter((project) => project.deletedAt === null),
    state.projects,
  );
  const existingThreadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existing = existingThreadById.get(thread.id);
      return {
        id: thread.id,
        codexThreadId: null,
        projectId: thread.projectId,
        title: thread.title,
        starred: existing?.starred ?? persistedStarredThreadIds.has(thread.id),
        model: resolveModelSlugForProvider(
          inferProviderForThreadModel({
            model: thread.model,
            sessionProviderName: thread.session?.providerName ?? null,
          }),
          thread.model,
        ),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        provider: thread.provider ?? undefined,
        source: thread.source ?? undefined,
        externalSessionId: thread.externalSessionId ?? undefined,
        providerMetadata: thread.providerMetadata ?? undefined,
        session: thread.session
          ? {
              provider: toLegacyProvider(thread.session.providerName),
              status: toLegacySessionStatus(thread.session.status),
              orchestrationStatus: thread.session.status,
              activeTurnId: thread.session.activeTurnId ?? undefined,
              createdAt: thread.session.updatedAt,
              updatedAt: thread.session.updatedAt,
              ...(thread.session.lastError ? { lastError: thread.session.lastError } : {}),
            }
          : null,
        messages:
          existing &&
          existing.messageCount === thread.messageCount &&
          existing.latestMessageAt === thread.latestMessageAt
            ? existing.messages
            : (existing?.messages ?? []),
        messageCount: thread.messageCount,
        latestMessageAt: thread.latestMessageAt,
        messagesHydrated:
          thread.messageCount === 0 ||
          (existing?.messagesHydrated === true &&
            existing.messageCount === thread.messageCount &&
            existing.latestMessageAt === thread.latestMessageAt),
        proposedPlans: thread.proposedPlans.map((proposedPlan) => ({
          id: proposedPlan.id,
          turnId: proposedPlan.turnId,
          planMarkdown: proposedPlan.planMarkdown,
          createdAt: proposedPlan.createdAt,
          updatedAt: proposedPlan.updatedAt,
        })),
        error: thread.session?.lastError ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        latestTurn: thread.latestTurn,
        lastVisitedAt: existing?.lastVisitedAt ?? thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        turnDiffSummaries: thread.checkpoints.map((checkpoint) => ({
          turnId: checkpoint.turnId,
          completedAt: checkpoint.completedAt,
          status: checkpoint.status,
          assistantMessageId: checkpoint.assistantMessageId ?? undefined,
          checkpointTurnCount: checkpoint.checkpointTurnCount,
          checkpointRef: checkpoint.checkpointRef,
          files: checkpoint.files.map((file) => ({ ...file })),
        })),
        activities: thread.activities.map((activity) => ({ ...activity })),
      };
    });
  return {
    ...state,
    projects,
    threads,
    threadsHydrated: true,
  };
}

export function hydrateThreadMessages(
  state: AppState,
  result: OrchestrationThreadMessagesResult,
): AppState {
  const threads = updateThread(state.threads, result.threadId, (thread) => ({
    ...thread,
    messages: result.messages.map(mapReadModelMessage),
    messageCount: result.messageCount,
    latestMessageAt: result.latestMessageAt,
    messagesHydrated: true,
  }));
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const threads = updateThread(state.threads, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function toggleThreadStarred(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => ({
    ...thread,
    starred: thread.starred !== true,
  }));
  return threads === state.threads ? state : { ...state, threads };
}

export function toggleProject(
  state: AppState,
  projectId: Project["id"],
  maxExpandedProjects?: number,
): AppState {
  const targetProject = state.projects.find((project) => project.id === projectId);
  if (!targetProject) return state;

  if (!targetProject.expanded) {
    const projects = applyExpandedProjectLimit(
      state.projects,
      [
        projectId,
        ...state.projects
          .filter((project) => project.expanded)
          .map((project) => project.id)
          .toReversed(),
      ],
      maxExpandedProjects,
    );
    const changed = projects.some((project, index) => project !== state.projects[index]);
    return changed ? { ...state, projects } : state;
  }

  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id === projectId ? { ...project, expanded: false } : project,
    ),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
  maxExpandedProjects?: number,
): AppState {
  const projects = expanded
    ? applyExpandedProjectLimit(
        state.projects,
        [
          projectId,
          ...state.projects
            .filter((project) => project.expanded)
            .map((project) => project.id)
            .toReversed(),
        ],
        maxExpandedProjects,
      )
    : state.projects.map((project) =>
        project.id === projectId ? { ...project, expanded: false } : project,
      );
  const changed = projects.some((project, index) => project !== state.projects[index]);
  return changed ? { ...state, projects } : state;
}

export function reorderProjects(
  state: AppState,
  draggedProjectId: Project["id"],
  targetProjectId: Project["id"],
): AppState {
  if (draggedProjectId === targetProjectId) return state;
  const draggedIndex = state.projects.findIndex((project) => project.id === draggedProjectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) return state;
  const projects = [...state.projects];
  const [draggedProject] = projects.splice(draggedIndex, 1);
  if (!draggedProject) return state;
  projects.splice(targetIndex, 0, draggedProject);
  return { ...state, projects };
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

// ── Zustand store ────────────────────────────────────────────────────

// ── Dev Server reducers ──────────────────────────────────────────────

const DEV_SERVER_MAX_LOG_LINES = 500;

function upsertDevServerStatus(state: AppState, info: DevServerInfo): AppState {
  return {
    ...state,
    devServerByProjectId: {
      ...state.devServerByProjectId,
      [info.projectId]: info,
    },
  };
}

function appendDevServerLogLine(state: AppState, payload: DevServerLogLinePayload): AppState {
  return appendDevServerLogLines(state, payload.projectId, [payload.line]);
}

/**
 * Appends multiple log lines in a single state update.
 * Callers should prefer this over calling appendDevServerLogLine() in a loop —
 * one Zustand set() means one React render instead of N.
 */
export function appendDevServerLogLines(
  state: AppState,
  projectId: string,
  newLines: string[],
): AppState {
  if (newLines.length === 0) return state;
  const existing = state.devServerLogsByProjectId[projectId] ?? [];
  const combined = existing.length === 0 ? newLines : [...existing, ...newLines];
  const updated =
    combined.length > DEV_SERVER_MAX_LOG_LINES
      ? combined.slice(combined.length - DEV_SERVER_MAX_LOG_LINES)
      : combined;
  return {
    ...state,
    devServerLogsByProjectId: {
      ...state.devServerLogsByProjectId,
      [projectId]: updated,
    },
  };
}

/**
 * Replaces (not appends) the log buffer for one project with the given lines.
 * Used when seeding from the server's rolling buffer after a reconnect so that
 * stale client-side lines are discarded and the authoritative server view is shown.
 */
export function setDevServerLogs(state: AppState, projectId: string, lines: string[]): AppState {
  const trimmed =
    lines.length > DEV_SERVER_MAX_LOG_LINES
      ? lines.slice(lines.length - DEV_SERVER_MAX_LOG_LINES)
      : lines;
  return {
    ...state,
    devServerLogsByProjectId: {
      ...state.devServerLogsByProjectId,
      [projectId]: trimmed,
    },
  };
}

// ── Store interface ──────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationSummaryReadModel) => void;
  hydrateThreadMessages: (result: OrchestrationThreadMessagesResult) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleThreadStarred: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"], maxExpandedProjects?: number) => void;
  setProjectExpanded: (
    projectId: Project["id"],
    expanded: boolean,
    maxExpandedProjects?: number,
  ) => void;
  reorderProjects: (draggedProjectId: Project["id"], targetProjectId: Project["id"]) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
  upsertDevServerStatus: (info: DevServerInfo) => void;
  appendDevServerLogLine: (payload: DevServerLogLinePayload) => void;
  appendDevServerLogLinesBatch: (projectId: string, lines: string[]) => void;
  setDevServerLogs: (projectId: string, lines: string[]) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  hydrateThreadMessages: (result) => set((state) => hydrateThreadMessages(state, result)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleThreadStarred: (threadId) => set((state) => toggleThreadStarred(state, threadId)),
  toggleProject: (projectId, maxExpandedProjects) =>
    set((state) => toggleProject(state, projectId, maxExpandedProjects)),
  setProjectExpanded: (projectId, expanded, maxExpandedProjects) =>
    set((state) => setProjectExpanded(state, projectId, expanded, maxExpandedProjects)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  upsertDevServerStatus: (info) => set((state) => upsertDevServerStatus(state, info)),
  appendDevServerLogLine: (payload) => set((state) => appendDevServerLogLine(state, payload)),
  appendDevServerLogLinesBatch: (projectId, lines) =>
    set((state) => appendDevServerLogLines(state, projectId, lines)),
  setDevServerLogs: (projectId, lines) => set((state) => setDevServerLogs(state, projectId, lines)),
}));

export function markRendererPersistenceReady(): void {
  rendererPersistenceReady = true;
  persistState(useStore.getState());
}

// Persist state changes with debouncing to avoid localStorage thrashing
useStore.subscribe((state) => {
  if (!rendererPersistenceReady) {
    return;
  }
  debouncedPersistState.maybeExecute(state);
});

// Flush pending writes synchronously before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  return createElement(Fragment, null, children);
}
