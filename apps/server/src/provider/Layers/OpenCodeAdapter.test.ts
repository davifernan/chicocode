import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { OpenCodeSseEvent } from "../../opencode/index.ts";
import {
  type OpenCodeChildSessionState,
  type OpenCodeSessionState,
  getOpenCodeEventSessionId,
  mapSseToRuntimeEvents,
  resolveOpenCodeEventTarget,
} from "./OpenCodeAdapter.ts";

function createChildSessionState(
  overrides?: Partial<OpenCodeChildSessionState>,
): OpenCodeChildSessionState {
  return {
    childSessionId: "session-subagent",
    parentSessionId: "session-parent",
    title: "Research helper",
    status: "inProgress",
    inputText: "",
    outputText: "",
    errorMessage: null,
    statusDetail: null,
    startedAt: "2026-03-18T12:00:00.000Z",
    completedAt: null,
    lastSnapshotFingerprint: null,
    ...overrides,
  };
}

function createSessionState(overrides?: Partial<OpenCodeSessionState>): OpenCodeSessionState {
  return {
    sessionId: "session-parent",
    directory: "/repo-parent",
    childSessionsById: new Map<string, OpenCodeChildSessionState>(),
    activeTurnId: null,
    interruptedTurnId: null,
    messageRoleById: new Map(),
    messageSessionIdById: new Map(),
    pendingQuestionIds: new Map(),
    partTypes: new Map(),
    partTextById: new Map(),
    toolFingerprintById: new Map(),
    lastStatusType: null,
    selectedAgent: null,
    selectedVariant: null,
    selectedModelRef: null,
    ...overrides,
  };
}

function createTrackedSessions() {
  return new Map([
    [ThreadId.makeUnsafe("thread-parent"), createSessionState()],
    [
      ThreadId.makeUnsafe("thread-other"),
      createSessionState({
        sessionId: "session-other",
        directory: "/repo-other",
      }),
    ],
  ]);
}

function createChildStatusEvent(statusType: string): OpenCodeSseEvent {
  return {
    directory: "/repo-parent",
    payload: {
      type: "session.status",
      properties: {
        sessionID: "session-subagent",
        status: {
          type: statusType,
          ...(statusType === "retry" ? { message: "Retrying subagent" } : {}),
        },
      },
    },
  };
}

describe("OpenCodeAdapter SSE routing", () => {
  it("does not fall back by directory when an unknown explicit session id is present", () => {
    const trackedSessions = createTrackedSessions();
    const event: OpenCodeSseEvent = {
      directory: "/repo-parent",
      payload: {
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "session-subagent",
            role: "assistant",
          },
        },
      },
    };

    expect(resolveOpenCodeEventTarget(event, trackedSessions)).toBeUndefined();
  });

  it("routes child session.created events to the tracked parent thread", () => {
    const trackedSessions = createTrackedSessions();
    const event: OpenCodeSseEvent = {
      directory: "/repo-parent",
      payload: {
        type: "session.created",
        properties: {
          info: {
            id: "session-subagent",
            parentID: "session-parent",
            title: "Research helper",
          },
        },
      },
    };

    expect(resolveOpenCodeEventTarget(event, trackedSessions)).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-parent"),
      session: {
        sessionId: "session-parent",
        directory: "/repo-parent",
      },
    });
  });

  it("tracks structured child session state on child session.created", () => {
    const sessionState = createSessionState();
    const event: OpenCodeSseEvent = {
      directory: "/repo-parent",
      payload: {
        type: "session.created",
        properties: {
          info: {
            id: "session-subagent",
            parentID: "session-parent",
            title: "Research helper",
          },
        },
      },
    };

    mapSseToRuntimeEvents(event, ThreadId.makeUnsafe("thread-parent"), sessionState);

    expect(sessionState.childSessionsById.get("session-subagent")).toMatchObject({
      childSessionId: "session-subagent",
      parentSessionId: "session-parent",
      title: "Research helper",
      status: "inProgress",
      inputText: "",
      outputText: "",
      completedAt: null,
    });
  });

  it("maps child session.created into a started collab agent lifecycle item", () => {
    const event: OpenCodeSseEvent = {
      directory: "/repo-parent",
      payload: {
        type: "session.created",
        properties: {
          info: {
            id: "session-subagent",
            parentID: "session-parent",
            title: "Research helper",
          },
        },
      },
    };

    expect(
      mapSseToRuntimeEvents(event, ThreadId.makeUnsafe("thread-parent"), createSessionState()),
    ).toMatchObject([
      {
        threadId: ThreadId.makeUnsafe("thread-parent"),
        type: "item.started",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Research helper",
          data: {
            childSessionId: "session-subagent",
            parentSessionId: "session-parent",
            title: "Research helper",
            status: "inProgress",
          },
        },
      },
    ]);
  });

  it("does not fall back by directory for child session.created without a tracked parent", () => {
    const trackedSessions = createTrackedSessions();
    const event: OpenCodeSseEvent = {
      directory: "/repo-parent",
      payload: {
        type: "session.created",
        properties: {
          info: {
            id: "session-subagent",
            parentID: "session-missing",
            title: "Research helper",
          },
        },
      },
    };

    expect(resolveOpenCodeEventTarget(event, trackedSessions)).toBeUndefined();
  });

  it("still falls back by directory when no explicit session id exists", () => {
    const trackedSessions = createTrackedSessions();
    const event: OpenCodeSseEvent = {
      directory: "/repo-parent",
      payload: {
        type: "session.status",
        properties: {
          status: {
            type: "busy",
          },
        },
      },
    };

    expect(resolveOpenCodeEventTarget(event, trackedSessions)).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-parent"),
      session: {
        sessionId: "session-parent",
        directory: "/repo-parent",
      },
    });
  });

  it("resolves child status events to the parent tracked thread", () => {
    const parentState = createSessionState({
      childSessionsById: new Map([["session-subagent", createChildSessionState()]]),
    });
    const trackedSessions = new Map([
      [ThreadId.makeUnsafe("thread-parent"), parentState],
      [
        ThreadId.makeUnsafe("thread-other"),
        createSessionState({
          sessionId: "session-other",
          directory: "/repo-other",
        }),
      ],
    ]);
    const event = createChildStatusEvent("idle");

    expect(resolveOpenCodeEventTarget(event, trackedSessions)).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-parent"),
      session: parentState,
    });
  });

  it("does not let child busy idle or error events drive parent lifecycle", () => {
    const turnId = TurnId.makeUnsafe("turn-parent");
    const parentState = createSessionState({
      activeTurnId: turnId,
      childSessionsById: new Map([["session-subagent", createChildSessionState()]]),
    });

    const busyEvents = mapSseToRuntimeEvents(
      createChildStatusEvent("busy"),
      ThreadId.makeUnsafe("thread-parent"),
      parentState,
    );
    expect(busyEvents).toMatchObject([
      {
        type: "item.updated",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
        },
      },
    ]);
    expect(busyEvents.map((event) => event.type)).not.toContain("session.state.changed");
    expect(busyEvents.map((event) => event.type)).not.toContain("turn.started");
    expect(parentState.activeTurnId).toBe(turnId);
    expect(parentState.lastStatusType).toBeNull();

    const idleEvents = mapSseToRuntimeEvents(
      createChildStatusEvent("idle"),
      ThreadId.makeUnsafe("thread-parent"),
      parentState,
    );
    expect(idleEvents).toMatchObject([
      {
        type: "item.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
        },
      },
    ]);
    expect(idleEvents.map((event) => event.type)).not.toContain("turn.completed");
    expect(parentState.activeTurnId).toBe(turnId);

    const errorEvents = mapSseToRuntimeEvents(
      {
        directory: "/repo-parent",
        payload: {
          type: "session.error",
          properties: {
            sessionID: "session-subagent",
            error: { message: "Subagent failed" },
          },
        },
      },
      ThreadId.makeUnsafe("thread-parent"),
      parentState,
    );
    expect(errorEvents).toMatchObject([
      {
        type: "item.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "failed",
          data: {
            errorMessage: "Subagent failed",
          },
        },
      },
    ]);
    expect(errorEvents.map((event) => event.type)).not.toContain("turn.completed");
    expect(parentState.activeTurnId).toBe(turnId);
  });

  it("emits subagent item updates from child user and assistant text snapshots", () => {
    const parentState = createSessionState({
      childSessionsById: new Map([["session-subagent", createChildSessionState()]]),
    });
    const threadId = ThreadId.makeUnsafe("thread-parent");

    mapSseToRuntimeEvents(
      {
        directory: "/repo-parent",
        payload: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-user",
              sessionID: "session-subagent",
              role: "user",
            },
          },
        },
      },
      threadId,
      parentState,
    );
    const userEvents = mapSseToRuntimeEvents(
      {
        directory: "/repo-parent",
        payload: {
          type: "message.part.updated",
          properties: {
            messageID: "msg-user",
            part: {
              id: "part-user",
              type: "text",
              text: "Inspect failing parser tests",
              sessionID: "session-subagent",
            },
          },
        },
      },
      threadId,
      parentState,
    );
    expect(userEvents).toMatchObject([
      {
        type: "item.updated",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            childSessionId: "session-subagent",
            inputText: "Inspect failing parser tests",
          },
        },
      },
    ]);

    mapSseToRuntimeEvents(
      {
        directory: "/repo-parent",
        payload: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-assistant",
              sessionID: "session-subagent",
              role: "assistant",
            },
          },
        },
      },
      threadId,
      parentState,
    );
    const assistantEvents = mapSseToRuntimeEvents(
      {
        directory: "/repo-parent",
        payload: {
          type: "message.part.updated",
          properties: {
            messageID: "msg-assistant",
            part: {
              id: "part-assistant",
              type: "text",
              text: "The parser fails because the tokenizer drops escaped pipes.",
              sessionID: "session-subagent",
            },
          },
        },
      },
      threadId,
      parentState,
    );
    expect(assistantEvents).toMatchObject([
      {
        type: "item.updated",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            childSessionId: "session-subagent",
            inputText: "Inspect failing parser tests",
            outputText: "The parser fails because the tokenizer drops escaped pipes.",
          },
        },
      },
    ]);
  });

  it("tags child internal tool lifecycle events with subagent identity", () => {
    const parentState = createSessionState({
      childSessionsById: new Map([["session-subagent", createChildSessionState()]]),
      messageRoleById: new Map([["msg-assistant", "assistant"]]),
      messageSessionIdById: new Map([["msg-assistant", "session-subagent"]]),
    });

    const events = mapSseToRuntimeEvents(
      {
        directory: "/repo-parent",
        payload: {
          type: "message.part.updated",
          properties: {
            messageID: "msg-assistant",
            part: {
              id: "tool-part-1",
              type: "tool",
              tool: "glob",
              sessionID: "session-subagent",
              state: {
                status: "completed",
                title: "Glob",
                output: "src/**/*.ts",
              },
            },
          },
        },
      },
      ThreadId.makeUnsafe("thread-parent"),
      parentState,
    );

    expect(events).toMatchObject([
      {
        type: "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          data: {
            childSessionId: "session-subagent",
            parentSessionId: "session-parent",
            subagentTitle: "Research helper",
          },
        },
      },
    ]);
  });

  it("still lets the parent session complete the turn normally after child events", () => {
    const turnId = TurnId.makeUnsafe("turn-parent");
    const parentState = createSessionState({
      activeTurnId: turnId,
      lastStatusType: "busy",
      childSessionsById: new Map([["session-subagent", createChildSessionState()]]),
    });

    const childIdleEvents = mapSseToRuntimeEvents(
      {
        directory: "/repo-parent",
        payload: {
          type: "session.idle",
          properties: {
            sessionID: "session-subagent",
          },
        },
      },
      ThreadId.makeUnsafe("thread-parent"),
      parentState,
    );
    expect(childIdleEvents.map((event) => event.type)).not.toContain("turn.completed");
    expect(parentState.activeTurnId).toBe(turnId);

    const parentIdleEvents = mapSseToRuntimeEvents(
      {
        directory: "/repo-parent",
        payload: {
          type: "session.idle",
          properties: {
            sessionID: "session-parent",
          },
        },
      },
      ThreadId.makeUnsafe("thread-parent"),
      parentState,
    );

    expect(parentIdleEvents).toMatchObject([
      {
        threadId: ThreadId.makeUnsafe("thread-parent"),
        turnId,
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      },
    ]);
    expect(parentState.activeTurnId).toBeNull();
  });

  it("does not mistake message ids for session ids", () => {
    expect(
      getOpenCodeEventSessionId("message.updated", {
        info: {
          id: "message-1",
        },
      }),
    ).toBeUndefined();

    expect(
      getOpenCodeEventSessionId("session.created", {
        info: {
          id: "session-1",
        },
      }),
    ).toBe("session-1");
  });
});
