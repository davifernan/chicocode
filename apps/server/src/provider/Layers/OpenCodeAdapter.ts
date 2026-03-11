/**
 * OpenCodeAdapterLive - Scoped live implementation for the OpenCode provider adapter.
 *
 * Wraps `OpenCodeProcessManager`, `OpenCodeClient`, and `OpenCodeSseClient`
 * behind the `OpenCodeAdapter` service contract and maps failures into the
 * shared `ProviderAdapterError` algebra.
 *
 * This is a SIMPLIFIED initial adapter that:
 * - Manages OpenCode process lifecycle (start / attach)
 * - Creates sessions and sends prompts via HTTP
 * - Subscribes to SSE for streaming response events
 * - Handles abort (interrupt)
 * - Emits basic session.started, session.state.changed, content.delta, turn.completed events
 *
 * Full event mapping for every OpenCode SSE event type is deferred to a later phase.
 *
 * @module OpenCodeAdapterLive
 */
import {
  type ProviderRuntimeEvent,
  EventId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeProcessManager,
  OpenCodeSseClient,
  type OpenCodeSseEvent,
} from "../../opencode/index.ts";

const PROVIDER = "opencode" as const;

// ── Helpers ────────────────────────────────────────────────────────

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function makeEventId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── SSE → ProviderRuntimeEvent mapping ────────────────────────────

interface OpenCodeSessionState {
  readonly sessionId: string;
  readonly directory: string;
  activeTurnId: string | null;
}

/**
 * Map a single OpenCode SSE event into zero or more canonical runtime events.
 *
 * This simplified mapper covers the core event types. Unknown event types
 * are silently dropped — they will be mapped in a later phase.
 */
function mapSseToRuntimeEvents(
  sseEvent: OpenCodeSseEvent,
  threadId: ThreadId,
  sessionState: OpenCodeSessionState,
): ReadonlyArray<ProviderRuntimeEvent> {
  const { type: eventType, properties } = sseEvent.payload;
  const baseFields = {
    eventId: EventId.makeUnsafe(makeEventId()),
    provider: PROVIDER as const,
    threadId,
    createdAt: nowIso(),
    raw: {
      source: "opencode.sse.global" as const,
      messageType: eventType,
      payload: sseEvent.payload as unknown,
    },
  };

  switch (eventType) {
    // ── Session lifecycle ──────────────────────────────────────────
    case "session.updated": {
      return [
        {
          ...baseFields,
          type: "session.state.changed",
          payload: {
            state: "ready",
            reason: "Session updated",
          },
        },
      ];
    }

    // ── Message lifecycle (assistant response streaming) ───────────
    case "message.created": {
      const role = properties.role as string | undefined;
      if (role === "assistant") {
        const turnId = TurnId.makeUnsafe(
          (properties.id as string | undefined) ?? makeEventId(),
        );
        sessionState.activeTurnId = turnId;
        return [
          {
            ...baseFields,
            turnId,
            type: "turn.started",
            payload: {},
          },
        ];
      }
      return [];
    }

    case "message.updated": {
      const role = properties.role as string | undefined;
      if (role === "assistant") {
        // message.updated may carry accumulated text — we use part.updated
        // for streaming deltas instead. Emit a session state update to
        // signal the turn is in progress.
        return [
          {
            ...baseFields,
            ...(sessionState.activeTurnId
              ? { turnId: sessionState.activeTurnId }
              : {}),
            type: "session.state.changed",
            payload: {
              state: "running",
            },
          },
        ];
      }
      return [];
    }

    case "message.completed": {
      const role = properties.role as string | undefined;
      if (role === "assistant") {
        const turnId =
          sessionState.activeTurnId ??
          TurnId.makeUnsafe(
            (properties.id as string | undefined) ?? makeEventId(),
          );
        const cost = properties.cost as number | undefined;
        const tokens = properties.tokens as
          | { input?: number; output?: number }
          | undefined;
        sessionState.activeTurnId = null;
        return [
          {
            ...baseFields,
            turnId,
            type: "turn.completed",
            payload: {
              state: "completed",
              ...(cost !== undefined ? { totalCostUsd: cost } : {}),
              ...(tokens ? { usage: tokens } : {}),
            },
          },
        ];
      }
      return [];
    }

    // ── Part-level streaming (text deltas) ─────────────────────────
    case "part.updated": {
      const partType = properties.type as string | undefined;
      const text = properties.text as string | undefined;
      if (partType === "text" && text && text.length > 0) {
        return [
          {
            ...baseFields,
            ...(sessionState.activeTurnId
              ? { turnId: sessionState.activeTurnId }
              : {}),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: text,
            },
          },
        ];
      }
      if (partType === "tool") {
        const toolName = properties.tool as string | undefined;
        return [
          {
            ...baseFields,
            ...(sessionState.activeTurnId
              ? { turnId: sessionState.activeTurnId }
              : {}),
            type: "item.started",
            payload: {
              itemType: "mcp_tool_call",
              status: "inProgress",
              ...(toolName ? { title: toolName } : {}),
            },
          },
        ];
      }
      return [];
    }

    case "part.completed": {
      const partType = properties.type as string | undefined;
      if (partType === "tool") {
        const toolName = properties.tool as string | undefined;
        return [
          {
            ...baseFields,
            ...(sessionState.activeTurnId
              ? { turnId: sessionState.activeTurnId }
              : {}),
            type: "item.completed",
            payload: {
              itemType: "mcp_tool_call",
              status: "completed",
              ...(toolName ? { title: toolName } : {}),
            },
          },
        ];
      }
      return [];
    }

    // ── Error events ──────────────────────────────────────────────
    case "error": {
      const message =
        (properties.message as string | undefined) ??
        (properties.error as string | undefined) ??
        "OpenCode runtime error";
      return [
        {
          ...baseFields,
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
          },
        },
      ];
    }

    default:
      // Unknown event type — silently skip (will be mapped later).
      return [];
  }
}

// ── Adapter factory ────────────────────────────────────────────────

export interface OpenCodeAdapterLiveOptions {
  readonly serverUrl?: string;
}

const makeOpenCodeAdapter = (options?: OpenCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    // ── Process manager lifecycle ──────────────────────────────────
    const processManager = yield* Effect.acquireRelease(
      Effect.sync(() => new OpenCodeProcessManager()),
      (pm) =>
        Effect.promise(async () => {
          try {
            await pm.stop();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    // ── SSE client lifecycle ──────────────────────────────────────
    const sseClient = yield* Effect.acquireRelease(
      Effect.sync(() => new OpenCodeSseClient()),
      (sse) =>
        Effect.sync(() => {
          sse.disconnect();
        }),
    );

    // ── Runtime event queue ───────────────────────────────────────
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    // Track active sessions: threadId → OpenCode session state
    const sessions = new Map<string, OpenCodeSessionState>();

    // ── Ensure the OpenCode server is running ─────────────────────
    const ensureServerRunning = Effect.gen(function* () {
      if (processManager.isRunning()) {
        return;
      }

      const serverUrl =
        options?.serverUrl ??
        process.env.OPENCODE_SERVER_URL ??
        `http://127.0.0.1:4096`;

      // First try attaching to an existing server.
      const attached = yield* Effect.tryPromise({
        try: () => processManager.attach(serverUrl),
        catch: () => false as const,
      });

      if (!attached) {
        // Start a fresh server.
        yield* Effect.tryPromise({
          try: () => processManager.start(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("__startup__"),
              detail: toMessage(cause, "Failed to start OpenCode server."),
              cause,
            }),
        });
      }

      // Connect SSE to the running server.
      const client = processManager.createClient();
      sseClient.connect(client.getBaseUrl(), client.getAuthHeader());
    });

    // ── SSE event listener ────────────────────────────────────────
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const services = yield* Effect.services<never>();
        const handler = (sseEvent: OpenCodeSseEvent) => {
          // Route the event to the correct thread by matching the directory.
          let targetThreadId: ThreadId | undefined;
          let targetState: OpenCodeSessionState | undefined;

          for (const [tid, state] of sessions) {
            if (
              sseEvent.directory === undefined ||
              sseEvent.directory === state.directory
            ) {
              targetThreadId = tid as ThreadId;
              targetState = state;
              break;
            }
          }

          if (!targetThreadId || !targetState) {
            // If we only have one session, route all events there.
            if (sessions.size === 1) {
              const [tid, state] = sessions.entries().next().value!;
              targetThreadId = tid as ThreadId;
              targetState = state;
            } else {
              return;
            }
          }

          const runtimeEvents = mapSseToRuntimeEvents(
            sseEvent,
            targetThreadId,
            targetState,
          );
          if (runtimeEvents.length === 0) return;

          Queue.offerAll(runtimeEventQueue, runtimeEvents).pipe(
            Effect.runPromiseWith(services),
          );
        };
        sseClient.onEvent(handler);
        return handler;
      }),
      (handler) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            sseClient.offEvent(handler);
          });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    // ── Adapter methods ───────────────────────────────────────────

    const startSession: OpenCodeAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      return Effect.gen(function* () {
        yield* ensureServerRunning;

        const client = processManager.createClient();
        const directory = input.cwd ?? process.cwd();

        // Create or resume an OpenCode session.
        const session = yield* Effect.tryPromise({
          try: () => client.createSession(directory),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to create OpenCode session."),
              cause,
            }),
        });

        const sessionState: OpenCodeSessionState = {
          sessionId: session.id,
          directory,
          activeTurnId: null,
        };
        sessions.set(input.threadId, sessionState);

        const now = nowIso();
        return {
          provider: PROVIDER,
          status: "ready" as const,
          runtimeMode: input.runtimeMode,
          cwd: directory,
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
        };
      });
    };

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const state = sessions.get(input.threadId);
        if (!state) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          );
        }

        const client = processManager.createClient();
        const message = input.input ?? "";
        const turnId = TurnId.makeUnsafe(makeEventId());

        yield* Effect.tryPromise({
          try: () =>
            client.sendPromptAsync(state.sessionId, message, state.directory),
          catch: (cause) => toRequestError(input.threadId, "sendTurn", cause),
        });

        state.activeTurnId = turnId;

        return {
          threadId: input.threadId,
          turnId,
        };
      });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId) => {
      const state = sessions.get(threadId);
      if (!state) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }

      return Effect.tryPromise({
        try: () => {
          const client = processManager.createClient();
          return client.abortSession(state.sessionId, state.directory);
        },
        catch: (cause) => toRequestError(threadId, "interruptTurn", cause),
      });
    };

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
      threadId,
      _requestId,
      _decision,
    ) =>
      // OpenCode doesn't have the same approval flow as Codex.
      // This is a no-op for now; will be extended in a later phase.
      Effect.gen(function* () {
        yield* Effect.logDebug(
          "OpenCode adapter: respondToRequest is a no-op in simplified adapter",
          { threadId },
        );
      });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
      threadId,
      _requestId,
      _answers,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logDebug(
          "OpenCode adapter: respondToUserInput is a no-op in simplified adapter",
          { threadId },
        );
      });

    const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        sessions.delete(threadId);
      });

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => {
        const now = nowIso();
        return Array.from(sessions.entries()).map(([threadId, state]) => ({
          provider: PROVIDER as const,
          status: "ready" as const,
          runtimeMode: "full-access" as const,
          cwd: state.directory,
          threadId: threadId as ThreadId,
          createdAt: now,
          updatedAt: now,
        }));
      });

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = (threadId) => {
      const state = sessions.get(threadId);
      if (!state) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }

      return Effect.gen(function* () {
        const client = processManager.createClient();
        const messages = yield* Effect.tryPromise({
          try: () => client.getMessages(state.sessionId, state.directory),
          catch: (cause) => toRequestError(threadId, "readThread", cause),
        });

        return {
          threadId,
          turns: messages
            .filter((m) => m.info.role === "assistant")
            .map((m) => ({
              id: TurnId.makeUnsafe(m.info.id),
              items: m.parts,
            })),
        };
      });
    };

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (
      threadId,
      _numTurns,
    ) =>
      // OpenCode doesn't natively support rollback. Return current state.
      readThread(threadId);

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        sessions.clear();
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies OpenCodeAdapterShape;
  });

export const OpenCodeAdapterLive = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(),
);

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  return Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter(options));
}
