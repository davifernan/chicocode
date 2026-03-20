import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationSummaryReadModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  appendDevServerLogLines,
  mapProjectsFromReadModel,
  markThreadUnread,
  reorderProjects,
  setProjectExpanded,
  syncServerReadModel,
  toggleThreadStarred,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    messageCount: 0,
    latestMessageAt: null,
    messagesHydrated: true,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5-codex",
        expanded: true,
        scripts: [],
      },
    ],
    threads: [thread],
    threadsHydrated: true,
    devServerByProjectId: {},
    devServerLogsByProjectId: {},
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationSummaryReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5.3-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    messageCount: 0,
    latestMessageAt: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationSummaryReadModel["threads"][number];
}

function makeReadModel(
  thread: OrchestrationSummaryReadModel["threads"][number],
): OrchestrationSummaryReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5.3-codex",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationSummaryReadModel["projects"][number]>,
): OrchestrationSummaryReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModel: "gpt-5.3-codex",
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("toggleThreadStarred flips the starred state for a thread", () => {
    const initialState = makeState(
      makeThread({
        starred: false,
      }),
    );

    const next = toggleThreadStarred(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next.threads[0]?.starred).toBe(true);
    expect(toggleThreadStarred(next, ThreadId.makeUnsafe("thread-1")).threads[0]?.starred).toBe(
      false,
    );
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = {
      projects: [
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project3,
          name: "Project 3",
          cwd: "/tmp/project-3",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
      ],
      threads: [],
      threadsHydrated: true,
      devServerByProjectId: {},
      devServerLogsByProjectId: {},
    };

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });

  it("expanding a project collapses the others", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: false,
          scripts: [],
        },
      ],
      threads: [],
      threadsHydrated: true,
      devServerByProjectId: {},
      devServerLogsByProjectId: {},
    };

    const next = setProjectExpanded(state, project2, true);

    expect(next.projects).toMatchObject([
      { id: project1, expanded: false },
      { id: project2, expanded: true },
    ]);
  });

  it("keeps up to the configured number of expanded projects", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = {
      projects: [
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project3,
          name: "Project 3",
          cwd: "/tmp/project-3",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: false,
          scripts: [],
        },
      ],
      threads: [],
      threadsHydrated: true,
      devServerByProjectId: {},
      devServerLogsByProjectId: {},
    };

    const next = setProjectExpanded(state, project3, true, 2);

    expect(next.projects).toMatchObject([
      { id: project1, expanded: false },
      { id: project2, expanded: true },
      { id: project3, expanded: true },
    ]);
  });
});

describe("store read model sync", () => {
  it("falls back to the codex default for unsupported provider models without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "claude-opus-4-6",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves starred state when a thread receives a fresh read-model snapshot", () => {
    const initialState = makeState(
      makeThread({
        starred: true,
      }),
    );

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.threads[0]?.starred).toBe(true);
  });

  it("preserves the current project order when syncing incoming read model updates", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
      ],
      threads: [],
      threadsHydrated: true,
      devServerByProjectId: {},
      devServerLogsByProjectId: {},
    };
    const readModel: OrchestrationSummaryReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project1, project3]);
  });

  it("uses persisted ordering for projects that arrive after the first snapshot", () => {
    const bootstrapProject = makeReadModelProject({
      id: ProjectId.makeUnsafe("project-bootstrap"),
      title: "Bootstrap",
      workspaceRoot: "/tmp/bootstrap",
    });
    const project1 = makeReadModelProject({
      id: ProjectId.makeUnsafe("project-1"),
      title: "Project 1",
      workspaceRoot: "/tmp/project-1",
    });
    const project2 = makeReadModelProject({
      id: ProjectId.makeUnsafe("project-2"),
      title: "Project 2",
      workspaceRoot: "/tmp/project-2",
    });

    const previousProjects = [
      {
        id: ProjectId.makeUnsafe("project-bootstrap"),
        name: "Bootstrap",
        cwd: "/tmp/bootstrap",
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
        expanded: true,
        scripts: [],
      },
    ];

    const next = mapProjectsFromReadModel(
      [project1, bootstrapProject, project2],
      previousProjects,
      {
        persistedExpandedCwds: new Set<string>(),
        persistedOrderCwds: ["/tmp/project-2", "/tmp/project-1"],
      },
    );

    expect(next.map((project) => project.cwd)).toEqual([
      "/tmp/bootstrap",
      "/tmp/project-2",
      "/tmp/project-1",
    ]);
  });
});

// ── appendDevServerLogLines ───────────────────────────────────────────────────

describe("appendDevServerLogLines", () => {
  const pid = "project-1";

  const emptyState = (): AppState => ({
    projects: [],
    threads: [],
    threadsHydrated: false,
    devServerByProjectId: {},
    devServerLogsByProjectId: {},
  });

  it("returns the same state reference when lines is empty", () => {
    const state = emptyState();
    const next = appendDevServerLogLines(state, pid, []);
    expect(next).toBe(state);
  });

  it("appends lines to an empty log buffer", () => {
    const state = emptyState();
    const next = appendDevServerLogLines(state, pid, ["line1", "line2"]);
    expect(next.devServerLogsByProjectId[pid]).toEqual(["line1", "line2"]);
  });

  it("appends lines to an existing log buffer", () => {
    const state = {
      ...emptyState(),
      devServerLogsByProjectId: { [pid]: ["old"] },
    };
    const next = appendDevServerLogLines(state, pid, ["new1", "new2"]);
    expect(next.devServerLogsByProjectId[pid]).toEqual(["old", "new1", "new2"]);
  });

  it("preserves logs for other projects", () => {
    const other = "project-2";
    const state = {
      ...emptyState(),
      devServerLogsByProjectId: { [other]: ["untouched"] },
    };
    const next = appendDevServerLogLines(state, pid, ["line1"]);
    expect(next.devServerLogsByProjectId[other]).toEqual(["untouched"]);
    expect(next.devServerLogsByProjectId[pid]).toEqual(["line1"]);
  });

  it("trims the oldest lines when the buffer would exceed DEV_SERVER_MAX_LOG_LINES (500)", () => {
    // Fill the buffer to exactly 500 lines
    const existing = Array.from({ length: 500 }, (_, i) => `existing-${i}`);
    const state = {
      ...emptyState(),
      devServerLogsByProjectId: { [pid]: existing },
    };
    const newLines = ["new1", "new2", "new3"];
    const next = appendDevServerLogLines(state, pid, newLines);
    const result = next.devServerLogsByProjectId[pid] ?? [];

    expect(result.length).toBe(500);
    // The oldest lines are removed to make room
    expect(result.at(-1)).toBe("new3");
    expect(result.at(-2)).toBe("new2");
    expect(result.at(-3)).toBe("new1");
    // Oldest existing lines are gone
    expect(result.includes("existing-0")).toBe(false);
    expect(result.includes("existing-1")).toBe(false);
    expect(result.includes("existing-2")).toBe(false);
  });

  it("handles a batch larger than the cap by keeping only the tail", () => {
    const newLines = Array.from({ length: 600 }, (_, i) => `line-${i}`);
    const state = emptyState();
    const next = appendDevServerLogLines(state, pid, newLines);
    const result = next.devServerLogsByProjectId[pid] ?? [];

    expect(result.length).toBe(500);
    expect(result[0]).toBe("line-100"); // first of the kept tail
    expect(result.at(-1)).toBe("line-599");
  });

  it("does not mutate the original state", () => {
    const state = emptyState();
    const stateBefore = JSON.stringify(state);
    appendDevServerLogLines(state, pid, ["a", "b"]);
    expect(JSON.stringify(state)).toBe(stateBefore);
  });
});
