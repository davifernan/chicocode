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
  type ProviderUserInputAnswers,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
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
  openCodeServerControl,
  OpenCodeSseClient,
  type OpenCodeSseEvent,
} from "../../opencode/index.ts";
import { normalizeOpenCodeTodos, normalizeOpenCodeUsage } from "../../opencode/providerMetadata.ts";

const PROVIDER = "opencode" as const;
const MAX_CHILD_SESSION_SNAPSHOT_CHARS = 4_000;

// ── Helpers ────────────────────────────────────────────────────────

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
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

export interface OpenCodeSessionState {
  readonly sessionId: string;
  readonly directory: string;
  childSessionsById: Map<string, OpenCodeChildSessionState>;
  activeTurnId: TurnId | null;
  interruptedTurnId: TurnId | null;
  messageRoleById: Map<string, string>;
  messageSessionIdById: Map<string, string>;
  pendingQuestionIds: Map<string, ReadonlyArray<string>>;
  partTypes: Map<string, string>;
  partTextById: Map<string, string>;
  toolFingerprintById: Map<string, string>;
  lastStatusType: "busy" | "retry" | "idle" | null;
  selectedAgent: string | null;
  selectedVariant: string | null;
  selectedModelRef: {
    readonly providerID: string;
    readonly modelID: string;
  } | null;
}

export interface OpenCodeChildSessionState {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  title: string | null;
  status: "inProgress" | "completed" | "failed";
  inputText: string;
  outputText: string;
  errorMessage: string | null;
  statusDetail: string | null;
  startedAt: string;
  completedAt: string | null;
  lastSnapshotFingerprint: string | null;
}

function getOpenCodeChildSessionParentId(
  eventType: string,
  properties: Record<string, unknown>,
): string | undefined {
  if (eventType !== "session.created") {
    return undefined;
  }

  const info = asRecord(properties.info);
  return asTrimmedString(info?.parentID);
}

function getOpenCodeChildSessionId(properties: Record<string, unknown>): string | undefined {
  const info = asRecord(properties.info);
  return asTrimmedString(info?.sessionID) ?? asTrimmedString(info?.id);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  const raw = asString(value)?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }

  const parts = asArray(value)
    ?.map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  if (!parts || parts.length === 0) {
    return undefined;
  }

  return parts.join(" ");
}

function toCanonicalUserInputAnswer(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    if (answers.length === 0) {
      return undefined;
    }
    return answers.length === 1 ? answers[0] : answers;
  }

  const record = asRecord(value);
  const answers = asArray(record?.answers)?.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (!answers || answers.length === 0) {
    return undefined;
  }

  return answers.length === 1 ? answers[0] : answers;
}

function toOpenCodeQuestionAnswer(value: unknown): string[] {
  const normalized = toCanonicalUserInputAnswer(value);
  if (!normalized) {
    return [];
  }

  return typeof normalized === "string" ? [normalized] : normalized;
}

function toUserInputQuestions(properties: Record<string, unknown>, requestId: string) {
  const questions = asArray(properties.questions);
  if (!questions) {
    return undefined;
  }

  const parsed = questions
    .map((entry, index) => {
      const question = asRecord(entry);
      if (!question) return undefined;
      const header = asString(question.header)?.trim();
      const prompt = asString(question.question)?.trim();
      const options = asArray(question.options)
        ?.map((option) => {
          const record = asRecord(option);
          if (!record) return undefined;
          const label = asString(record.label)?.trim();
          const description = asString(record.description)?.trim();
          if (!label || !description) {
            return undefined;
          }
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== undefined);
      if (!header || !prompt || !options || options.length === 0) {
        return undefined;
      }
      return {
        id: `${requestId}:${index}`,
        header,
        question: prompt,
        options,
      };
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      } => question !== undefined,
    );

  return parsed.length > 0 ? parsed : undefined;
}

export function getOpenCodeEventSessionId(
  eventType: string,
  properties: Record<string, unknown>,
): string | undefined {
  const directSessionId = asString(properties.sessionID)?.trim();
  if (directSessionId) {
    return directSessionId;
  }

  const info = asRecord(properties.info);
  const infoSessionId = asString(info?.sessionID)?.trim();
  if (infoSessionId) {
    return infoSessionId;
  }

  const infoId = asString(info?.id)?.trim();
  if (infoId && eventType.startsWith("session.")) {
    return infoId;
  }

  const part = asRecord(properties.part);
  const partSessionId = asString(part?.sessionID)?.trim();
  if (partSessionId) {
    return partSessionId;
  }

  return undefined;
}

type OpenCodeTrackedSessionLike = Pick<OpenCodeSessionState, "sessionId" | "directory"> & {
  readonly childSessionsById?: ReadonlyMap<string, OpenCodeChildSessionState>;
};

export function resolveOpenCodeEventTarget<T extends OpenCodeTrackedSessionLike>(
  sseEvent: OpenCodeSseEvent,
  sessions: Iterable<readonly [string, T]>,
):
  | {
      readonly threadId: ThreadId;
      readonly session: T;
    }
  | undefined {
  const properties = asRecord(sseEvent.payload.properties) ?? {};
  const parentSessionId = getOpenCodeChildSessionParentId(sseEvent.payload.type, properties);

  if (parentSessionId) {
    for (const [threadId, session] of sessions) {
      if (session.sessionId === parentSessionId) {
        return { threadId: threadId as ThreadId, session };
      }
    }
  }

  const eventSessionId = getOpenCodeEventSessionId(sseEvent.payload.type, properties);

  if (eventSessionId) {
    for (const [threadId, session] of sessions) {
      if (session.sessionId === eventSessionId) {
        return { threadId: threadId as ThreadId, session };
      }
    }

    for (const [threadId, session] of sessions) {
      if (session.childSessionsById?.has(eventSessionId)) {
        return { threadId: threadId as ThreadId, session };
      }
    }

    return undefined;
  }

  for (const [threadId, session] of sessions) {
    if (sseEvent.directory !== undefined && sseEvent.directory === session.directory) {
      return { threadId: threadId as ThreadId, session };
    }
  }

  const iterator = sessions[Symbol.iterator]();
  const first = iterator.next();
  if (!first.done && iterator.next().done) {
    const [threadId, session] = first.value;
    return { threadId: threadId as ThreadId, session };
  }

  return undefined;
}

function buildOpenCodeChildSessionCreatedEvent(
  eventType: string,
  sseEvent: OpenCodeSseEvent,
  threadId: ThreadId,
  sessionState: OpenCodeSessionState,
  properties: Record<string, unknown>,
): ProviderRuntimeEvent | null {
  const info = asRecord(properties.info);
  const parentSessionId = asTrimmedString(info?.parentID);
  if (!parentSessionId) {
    return null;
  }

  const childSessionId = getOpenCodeChildSessionId(properties);
  if (!childSessionId) {
    return null;
  }

  const childSession = upsertOpenCodeChildSession(sessionState, {
    childSessionId,
    parentSessionId,
    ...(() => {
      const title =
        asTrimmedString(info?.title) ?? asTrimmedString(info?.name) ?? asTrimmedString(info?.agent);
      return title ? { title } : {};
    })(),
  });

  return buildOpenCodeChildSessionLifecycleEvent(
    eventType,
    sseEvent,
    threadId,
    sessionState,
    childSession,
    "item.started",
  );
}

function truncateChildSessionSnapshotText(value: string): string {
  if (value.length <= MAX_CHILD_SESSION_SNAPSHOT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_CHILD_SESSION_SNAPSHOT_CHARS - 3)}...`;
}

function buildOpenCodeChildSessionTitle(childSession: OpenCodeChildSessionState): string {
  return childSession.title ?? "Sub-agent";
}

function buildOpenCodeChildSessionDetail(
  childSession: OpenCodeChildSessionState,
  lifecycleType: "item.started" | "item.updated" | "item.completed",
): string | undefined {
  if (childSession.errorMessage) {
    return childSession.errorMessage;
  }
  if (childSession.outputText) {
    return childSession.outputText;
  }
  if (childSession.inputText) {
    return childSession.inputText;
  }
  if (childSession.statusDetail) {
    return childSession.statusDetail;
  }
  if (lifecycleType === "item.started") {
    return `Started ${buildOpenCodeChildSessionTitle(childSession)}`;
  }
  return undefined;
}

function serializeOpenCodeChildSessionData(childSession: OpenCodeChildSessionState) {
  return {
    tool: "subagent",
    childSessionId: childSession.childSessionId,
    sessionId: childSession.childSessionId,
    parentSessionId: childSession.parentSessionId,
    status: childSession.status,
    ...(childSession.title ? { title: childSession.title } : {}),
    ...(childSession.inputText ? { inputText: childSession.inputText } : {}),
    ...(childSession.outputText ? { outputText: childSession.outputText } : {}),
    ...(childSession.errorMessage ? { errorMessage: childSession.errorMessage } : {}),
    ...(childSession.statusDetail ? { statusDetail: childSession.statusDetail } : {}),
    startedAt: childSession.startedAt,
    ...(childSession.completedAt ? { completedAt: childSession.completedAt } : {}),
    item: {
      tool: "subagent",
      result: {
        sessionId: childSession.childSessionId,
        parentSessionId: childSession.parentSessionId,
        status: childSession.status,
        ...(childSession.title ? { title: childSession.title } : {}),
        ...(childSession.inputText ? { inputText: childSession.inputText } : {}),
        ...(childSession.outputText ? { outputText: childSession.outputText } : {}),
        ...(childSession.errorMessage ? { errorMessage: childSession.errorMessage } : {}),
        ...(childSession.statusDetail ? { statusDetail: childSession.statusDetail } : {}),
        startedAt: childSession.startedAt,
        ...(childSession.completedAt ? { completedAt: childSession.completedAt } : {}),
      },
    },
  };
}

function buildOpenCodeChildSessionLifecycleEvent(
  eventType: string,
  sseEvent: OpenCodeSseEvent,
  threadId: ThreadId,
  sessionState: OpenCodeSessionState,
  childSession: OpenCodeChildSessionState,
  lifecycleType: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | null {
  const fingerprint = JSON.stringify({
    lifecycleType,
    title: childSession.title,
    status: childSession.status,
    inputText: childSession.inputText,
    outputText: childSession.outputText,
    errorMessage: childSession.errorMessage,
    statusDetail: childSession.statusDetail,
    startedAt: childSession.startedAt,
    completedAt: childSession.completedAt,
  });
  if (childSession.lastSnapshotFingerprint === fingerprint) {
    return null;
  }
  childSession.lastSnapshotFingerprint = fingerprint;

  const detail = buildOpenCodeChildSessionDetail(childSession, lifecycleType);

  return {
    ...createBaseFields(eventType, sseEvent, threadId),
    ...(sessionState.activeTurnId ? { turnId: sessionState.activeTurnId } : {}),
    itemId: RuntimeItemId.makeUnsafe(`subagent:${childSession.childSessionId}`),
    type: lifecycleType,
    payload: {
      itemType: "collab_agent_tool_call",
      status: childSession.status,
      title: buildOpenCodeChildSessionTitle(childSession),
      ...(detail ? { detail } : {}),
      data: serializeOpenCodeChildSessionData(childSession),
    },
  };
}

function upsertOpenCodeChildSession(
  sessionState: OpenCodeSessionState,
  input: {
    readonly childSessionId: string;
    readonly parentSessionId: string;
    readonly title?: string | null;
  },
): OpenCodeChildSessionState {
  const existing = sessionState.childSessionsById.get(input.childSessionId);
  if (existing) {
    if (input.title) {
      existing.title = input.title;
    }
    return existing;
  }

  const childSession: OpenCodeChildSessionState = {
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    title: input.title ?? null,
    status: "inProgress",
    inputText: "",
    outputText: "",
    errorMessage: null,
    statusDetail: null,
    startedAt: nowIso(),
    completedAt: null,
    lastSnapshotFingerprint: null,
  };
  sessionState.childSessionsById.set(input.childSessionId, childSession);
  return childSession;
}

function openCodeChildSessionFromProperties(
  eventType: string,
  properties: Record<string, unknown>,
  sessionState: OpenCodeSessionState,
): OpenCodeChildSessionState | undefined {
  const explicitSessionId = getOpenCodeEventSessionId(eventType, properties);
  if (explicitSessionId) {
    return sessionState.childSessionsById.get(explicitSessionId);
  }

  const messageSessionId = (() => {
    const messageId = getOpenCodeMessageId(properties);
    return messageId ? sessionState.messageSessionIdById.get(messageId) : undefined;
  })();
  if (messageSessionId) {
    return sessionState.childSessionsById.get(messageSessionId);
  }

  if (eventType === "session.created") {
    const info = asRecord(properties.info);
    const parentSessionId = asTrimmedString(info?.parentID);
    const childSessionId = getOpenCodeChildSessionId(properties);
    if (parentSessionId === sessionState.sessionId && childSessionId) {
      return sessionState.childSessionsById.get(childSessionId);
    }
  }

  return undefined;
}

function getOpenCodeErrorMessage(properties: Record<string, unknown>): string | undefined {
  const directMessage = asString(properties.message)?.trim();
  if (directMessage) {
    return directMessage;
  }

  const directError = asString(properties.error)?.trim();
  if (directError) {
    return directError;
  }

  const errorRecord = asRecord(properties.error);
  const errorMessage = asString(errorRecord?.message)?.trim();
  if (errorMessage) {
    return errorMessage;
  }

  const errorName = asString(errorRecord?.name)?.trim();
  if (errorName) {
    return errorName;
  }

  return undefined;
}

function getOpenCodeMessageId(properties: Record<string, unknown>): string | undefined {
  const directMessageId = asTrimmedString(properties.messageID);
  if (directMessageId) {
    return directMessageId;
  }

  const part = asRecord(properties.part);
  const partMessageId = asTrimmedString(part?.messageID);
  if (partMessageId) {
    return partMessageId;
  }

  const info = asRecord(properties.info);
  const infoMessageId = asTrimmedString(info?.id);
  if (infoMessageId) {
    return infoMessageId;
  }

  return undefined;
}

function detectOpenCodeToolCommand(state: Record<string, unknown>): string | undefined {
  const input = asRecord(state.input);
  return (
    normalizeCommandValue(input?.command) ??
    normalizeCommandValue(input?.cmd) ??
    normalizeCommandValue(input?.args) ??
    asTrimmedString(state.raw)
  );
}

function detectOpenCodeToolItemType(
  toolName: string | undefined,
  command: string | undefined,
  attachments: ReadonlyArray<unknown> | undefined,
):
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call" {
  const normalizedToolName = toolName?.toLowerCase();
  if (command) {
    return "command_execution";
  }

  if (
    attachments?.length ||
    normalizedToolName?.includes("edit") ||
    normalizedToolName?.includes("write") ||
    normalizedToolName?.includes("patch") ||
    normalizedToolName?.includes("file")
  ) {
    return "file_change";
  }

  if (normalizedToolName?.includes("mcp")) {
    return "mcp_tool_call";
  }

  if (normalizedToolName?.includes("agent")) {
    return "collab_agent_tool_call";
  }

  return "dynamic_tool_call";
}

function buildOpenCodeToolLifecycleEvent(
  eventType: string,
  sseEvent: OpenCodeSseEvent,
  threadId: ThreadId,
  sessionState: OpenCodeSessionState,
  part: Record<string, unknown>,
  childSession?: OpenCodeChildSessionState,
): ProviderRuntimeEvent | null {
  const partId = asTrimmedString(part.id);
  const state = asRecord(part.state);
  const stateStatus = asTrimmedString(state?.status);
  if (!partId || !state || !stateStatus) {
    return null;
  }

  const toolName = asTrimmedString(part.tool);
  const title = asTrimmedString(state.title) ?? toolName;
  const detail =
    stateStatus === "completed"
      ? (asTrimmedString(state.output) ?? title)
      : stateStatus === "error"
        ? (asTrimmedString(state.error) ?? title)
        : (asTrimmedString(state.raw) ?? title);
  const attachments = asArray(state.attachments);
  const command = detectOpenCodeToolCommand(state);
  const itemType = detectOpenCodeToolItemType(toolName, command, attachments);
  const status =
    stateStatus === "completed" ? "completed" : stateStatus === "error" ? "failed" : "inProgress";
  const eventFingerprint = JSON.stringify({
    status: stateStatus,
    title,
    detail,
    command,
    attachments: attachments ?? [],
  });
  if (sessionState.toolFingerprintById.get(partId) === eventFingerprint) {
    return null;
  }
  sessionState.toolFingerprintById.set(partId, eventFingerprint);

  const payloadTitle =
    stateStatus === "error" && title ? `${title} failed` : (title ?? toolName ?? "Tool");
  const payloadData = {
    ...(toolName ? { tool: toolName } : {}),
    ...(childSession
      ? {
          childSessionId: childSession.childSessionId,
          parentSessionId: childSession.parentSessionId,
          ...(childSession.title ? { subagentTitle: childSession.title } : {}),
        }
      : {}),
    item: {
      ...(toolName ? { tool: toolName } : {}),
      ...(command ? { command } : {}),
      ...(asRecord(state.input) ? { input: asRecord(state.input) } : {}),
      result: {
        status: stateStatus,
        ...(command ? { command } : {}),
        ...(asTrimmedString(state.output) ? { output: asTrimmedString(state.output) } : {}),
        ...(asTrimmedString(state.error) ? { error: asTrimmedString(state.error) } : {}),
        ...(asRecord(state.metadata) ? { metadata: asRecord(state.metadata) } : {}),
        ...(attachments ? { attachments } : {}),
      },
    },
    ...(command ? { command } : {}),
    ...(attachments ? { files: attachments } : {}),
  };

  return {
    ...createBaseFields(eventType, sseEvent, threadId),
    ...(sessionState.activeTurnId ? { turnId: sessionState.activeTurnId } : {}),
    itemId: RuntimeItemId.makeUnsafe(partId),
    type: stateStatus === "completed" ? "item.completed" : "item.updated",
    payload: {
      itemType,
      status,
      title: payloadTitle,
      ...(detail ? { detail } : {}),
      data: payloadData,
    },
  };
}

function toCanonicalUserInputAnswers(
  questionIds: ReadonlyArray<string> | undefined,
  answers: unknown,
): ProviderUserInputAnswers {
  const answerList = asArray(answers);
  if (!answerList || !questionIds || questionIds.length === 0) {
    return {};
  }

  return Object.fromEntries(
    questionIds.flatMap((questionId, index) => {
      const answer = toCanonicalUserInputAnswer(answerList[index]);
      if (answer === undefined) {
        return [];
      }
      return [[questionId, answer] as const];
    }),
  );
}

function createBaseFields(
  eventType: string,
  sseEvent: OpenCodeSseEvent,
  threadId: ThreadId,
): Pick<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt" | "raw"> {
  return {
    eventId: EventId.makeUnsafe(makeEventId()),
    provider: PROVIDER,
    threadId,
    createdAt: nowIso(),
    raw: {
      source: "opencode.sse.global" as const,
      messageType: eventType,
      payload: sseEvent.payload as unknown,
    },
  };
}

function openCodePartStreamKind(
  partType: string | undefined,
): "assistant_text" | "reasoning_text" | null {
  if (partType === "reasoning") {
    return "reasoning_text";
  }

  if (partType === undefined || partType === "text") {
    return "assistant_text";
  }

  return null;
}

function resolveOpenCodeEventScope(
  eventType: string,
  properties: Record<string, unknown>,
  sessionState: OpenCodeSessionState,
):
  | { readonly scope: "parent"; readonly sessionId: string }
  | { readonly scope: "child"; readonly childSession: OpenCodeChildSessionState } {
  const childSession = openCodeChildSessionFromProperties(eventType, properties, sessionState);
  if (childSession) {
    return { scope: "child", childSession };
  }
  return { scope: "parent", sessionId: sessionState.sessionId };
}

function updateOpenCodeChildSessionText(
  childSession: OpenCodeChildSessionState,
  role: string,
  text: string,
) {
  const nextText = truncateChildSessionSnapshotText(text);
  if (role === "assistant") {
    childSession.outputText = nextText;
    if (nextText.length > 0 && childSession.status !== "failed") {
      childSession.status = "inProgress";
      childSession.completedAt = null;
    }
    return;
  }
  if (role === "user") {
    childSession.inputText = nextText;
  }
}

function updateOpenCodeChildSessionStatus(
  childSession: OpenCodeChildSessionState,
  input: {
    readonly status?: OpenCodeChildSessionState["status"];
    readonly statusDetail?: string | null;
    readonly errorMessage?: string | null;
    readonly completedAt?: string | null;
  },
) {
  if (input.status) {
    childSession.status = input.status;
    if (input.status === "inProgress") {
      childSession.completedAt = null;
      childSession.errorMessage = null;
    }
  }
  if (input.statusDetail !== undefined) {
    childSession.statusDetail = input.statusDetail;
  }
  if (input.errorMessage !== undefined) {
    childSession.errorMessage = input.errorMessage;
  }
  if (input.completedAt !== undefined) {
    childSession.completedAt = input.completedAt;
  }
}

/**
 * Map a single OpenCode SSE event into zero or more canonical runtime events.
 *
 * This simplified mapper covers the core event types. Unknown event types
 * are silently dropped — they will be mapped in a later phase.
 */
export function mapSseToRuntimeEvents(
  sseEvent: OpenCodeSseEvent,
  threadId: ThreadId,
  sessionState: OpenCodeSessionState,
): ReadonlyArray<ProviderRuntimeEvent> {
  const { type: eventType, properties } = sseEvent.payload;
  const eventScope = resolveOpenCodeEventScope(eventType, properties, sessionState);

  const completeActiveTurn = (input?: {
    readonly state?: "completed" | "failed" | "interrupted";
    readonly stopReason?: string | null;
    readonly usage?: unknown;
    readonly totalCostUsd?: number;
    readonly errorMessage?: string;
  }): ReadonlyArray<ProviderRuntimeEvent> => {
    const turnId = sessionState.activeTurnId;
    sessionState.activeTurnId = null;
    sessionState.lastStatusType = "idle";

    if (!turnId) {
      return input?.state === "failed" && input.errorMessage
        ? [
            {
              ...createBaseFields(eventType, sseEvent, threadId),
              type: "runtime.error",
              payload: {
                message: input.errorMessage,
                class: "provider_error",
              },
            },
          ]
        : [];
    }

    const wasInterrupted = sessionState.interruptedTurnId === turnId;
    if (wasInterrupted) {
      sessionState.interruptedTurnId = null;
    }

    const completionState = input?.state ?? (wasInterrupted ? "interrupted" : "completed");
    const stopReason = input?.stopReason ?? (wasInterrupted ? "aborted" : undefined);

    const events: ProviderRuntimeEvent[] = [];
    if (input?.state === "failed" && input.errorMessage) {
      events.push({
        ...createBaseFields(eventType, sseEvent, threadId),
        turnId,
        type: "runtime.error",
        payload: {
          message: input.errorMessage,
          class: "provider_error",
        },
      });
    }

    events.push({
      ...createBaseFields(eventType, sseEvent, threadId),
      turnId,
      type: "turn.completed",
      payload: {
        state: completionState,
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(input?.usage !== undefined ? { usage: input.usage } : {}),
        ...(input?.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
        ...(input?.errorMessage ? { errorMessage: input.errorMessage } : {}),
      },
    });

    return events;
  };

  switch (eventType) {
    // ── Session lifecycle ──────────────────────────────────────────
    case "session.created": {
      const childSessionCreatedEvent = buildOpenCodeChildSessionCreatedEvent(
        eventType,
        sseEvent,
        threadId,
        sessionState,
        properties,
      );
      if (childSessionCreatedEvent) {
        return [childSessionCreatedEvent];
      }

      const info = asRecord(properties.info);
      const providerThreadId = asString(info?.id)?.trim();
      const title = asString(info?.title)?.trim();
      const events: ProviderRuntimeEvent[] = [
        {
          ...createBaseFields(eventType, sseEvent, threadId),
          type: "thread.started",
          payload: providerThreadId ? { providerThreadId } : {},
        },
      ];

      if (title) {
        events.push({
          ...createBaseFields(eventType, sseEvent, threadId),
          type: "thread.metadata.updated",
          payload: {
            name: title,
          },
        });
      }

      return events;
    }

    case "session.updated": {
      const info = asRecord(properties.info);
      const title = asString(info?.title)?.trim();
      if (eventScope.scope === "child") {
        if (!title || title === eventScope.childSession.title) {
          return [];
        }
        eventScope.childSession.title = title;
        return [
          buildOpenCodeChildSessionLifecycleEvent(
            eventType,
            sseEvent,
            threadId,
            sessionState,
            eventScope.childSession,
            "item.updated",
          ),
        ].filter((event): event is ProviderRuntimeEvent => event !== null);
      }
      if (!title) {
        return [];
      }
      return [
        {
          ...createBaseFields(eventType, sseEvent, threadId),
          type: "thread.metadata.updated",
          payload: {
            name: title,
          },
        },
      ];
    }

    case "session.status": {
      const status = asRecord(properties.status);
      const statusType = asString(status?.type)?.trim();
      if (!statusType) {
        return [];
      }

      if (eventScope.scope === "child") {
        const detail = asString(status?.message)?.trim() ?? null;
        if (statusType === "busy" || statusType === "retry") {
          updateOpenCodeChildSessionStatus(eventScope.childSession, {
            status: "inProgress",
            statusDetail: detail,
            ...(statusType === "retry" ? { completedAt: null } : {}),
          });
          return [
            buildOpenCodeChildSessionLifecycleEvent(
              eventType,
              sseEvent,
              threadId,
              sessionState,
              eventScope.childSession,
              "item.updated",
            ),
          ].filter((event): event is ProviderRuntimeEvent => event !== null);
        }

        if (statusType === "idle") {
          if (
            eventScope.childSession.status === "completed" &&
            eventScope.childSession.completedAt !== null
          ) {
            return [];
          }
          updateOpenCodeChildSessionStatus(eventScope.childSession, {
            status: "completed",
            statusDetail: detail,
            completedAt: nowIso(),
          });
          return [
            buildOpenCodeChildSessionLifecycleEvent(
              eventType,
              sseEvent,
              threadId,
              sessionState,
              eventScope.childSession,
              "item.completed",
            ),
          ].filter((event): event is ProviderRuntimeEvent => event !== null);
        }

        return [];
      }

      if (statusType === "busy") {
        const events: ProviderRuntimeEvent[] = [
          {
            ...createBaseFields(eventType, sseEvent, threadId),
            type: "session.state.changed",
            payload: {
              state: "running",
            },
          },
        ];

        if (sessionState.activeTurnId && sessionState.lastStatusType !== "busy") {
          events.unshift({
            ...createBaseFields(eventType, sseEvent, threadId),
            turnId: sessionState.activeTurnId,
            type: "turn.started",
            payload: {},
          });
        }

        sessionState.lastStatusType = "busy";
        return events;
      }

      if (statusType === "retry") {
        sessionState.lastStatusType = "retry";
        const reason = asString(status?.message)?.trim();
        return [
          {
            ...createBaseFields(eventType, sseEvent, threadId),
            type: "session.state.changed",
            payload: {
              state: "waiting",
              ...(reason ? { reason } : {}),
              detail: status,
            },
          },
        ];
      }

      if (statusType === "idle") {
        return completeActiveTurn();
      }

      return [];
    }

    case "session.idle": {
      if (eventScope.scope === "child") {
        if (eventScope.childSession.status === "completed" && eventScope.childSession.completedAt) {
          return [];
        }
        updateOpenCodeChildSessionStatus(eventScope.childSession, {
          status: "completed",
          completedAt: nowIso(),
        });
        return [
          buildOpenCodeChildSessionLifecycleEvent(
            eventType,
            sseEvent,
            threadId,
            sessionState,
            eventScope.childSession,
            "item.completed",
          ),
        ].filter((event): event is ProviderRuntimeEvent => event !== null);
      }
      if (sessionState.lastStatusType === "idle") {
        return [];
      }
      return completeActiveTurn();
    }

    case "session.error": {
      const message = getOpenCodeErrorMessage(properties) ?? "OpenCode session error";
      if (eventScope.scope === "child") {
        if (
          eventScope.childSession.status === "failed" &&
          eventScope.childSession.errorMessage === message &&
          eventScope.childSession.completedAt
        ) {
          return [];
        }
        updateOpenCodeChildSessionStatus(eventScope.childSession, {
          status: "failed",
          errorMessage: message,
          statusDetail: message,
          completedAt: nowIso(),
        });
        return [
          buildOpenCodeChildSessionLifecycleEvent(
            eventType,
            sseEvent,
            threadId,
            sessionState,
            eventScope.childSession,
            "item.completed",
          ),
        ].filter((event): event is ProviderRuntimeEvent => event !== null);
      }
      return completeActiveTurn({
        state: "failed",
        errorMessage: message,
      });
    }

    // ── Message lifecycle (assistant response streaming) ───────────
    case "message.updated": {
      const info = asRecord(properties.info);
      const role = asString(info?.role)?.trim();
      const messageId = asTrimmedString(info?.id);
      if (messageId && role) {
        sessionState.messageRoleById.set(messageId, role);
      }
      if (messageId) {
        const eventSessionId =
          eventScope.scope === "child"
            ? eventScope.childSession.childSessionId
            : (getOpenCodeEventSessionId(eventType, properties) ?? sessionState.sessionId);
        sessionState.messageSessionIdById.set(messageId, eventSessionId);
      }
      if (eventScope.scope === "child") {
        const title =
          asString(info?.title)?.trim() ??
          asString(info?.agent)?.trim() ??
          asString(info?.name)?.trim();
        if (!title || title === eventScope.childSession.title) {
          return [];
        }
        eventScope.childSession.title = title;
        return [
          buildOpenCodeChildSessionLifecycleEvent(
            eventType,
            sseEvent,
            threadId,
            sessionState,
            eventScope.childSession,
            "item.updated",
          ),
        ].filter((event): event is ProviderRuntimeEvent => event !== null);
      }
      if (role !== "assistant") {
        return [];
      }

      const usage = normalizeOpenCodeUsage((info?.tokens as never) ?? null);
      const totalCostUsd = asNumber(info?.cost);
      const agentName = asString(info?.agent)?.trim() ?? sessionState.selectedAgent ?? undefined;
      const agentVariant =
        asString(info?.variant)?.trim() ?? sessionState.selectedVariant ?? undefined;
      const providerId =
        asString(info?.providerID)?.trim() ?? sessionState.selectedModelRef?.providerID;
      const modelId = asString(info?.modelID)?.trim() ?? sessionState.selectedModelRef?.modelID;
      const events: ProviderRuntimeEvent[] = [];

      if (sessionState.activeTurnId && sessionState.lastStatusType !== "busy") {
        sessionState.lastStatusType = "busy";
        events.push({
          ...createBaseFields(eventType, sseEvent, threadId),
          turnId: sessionState.activeTurnId,
          type: "turn.started",
          payload: {},
        });
      }

      if (usage) {
        events.push({
          ...createBaseFields(eventType, sseEvent, threadId),
          type: "thread.token-usage.updated",
          payload: {
            usage,
          },
        });
      }

      if (
        agentName ||
        agentVariant ||
        providerId ||
        modelId ||
        usage ||
        totalCostUsd !== undefined
      ) {
        events.push({
          ...createBaseFields(eventType, sseEvent, threadId),
          type: "thread.metadata.updated",
          payload: {
            metadata: {
              ...(agentName ? { agentName } : {}),
              ...(agentVariant ? { agentVariant } : {}),
              ...(providerId ? { providerId } : {}),
              ...(modelId ? { modelId } : {}),
              ...(usage ? { latestUsage: usage } : {}),
              ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
            },
          },
        });
      }

      return events;
    }

    // ── Part-level streaming (text deltas) ─────────────────────────
    case "message.part.updated": {
      const part = asRecord(properties.part);
      const partId = asString(part?.id)?.trim();
      const partType = asString(part?.type)?.trim();
      const messageId = getOpenCodeMessageId(properties);
      const messageRole = messageId ? sessionState.messageRoleById.get(messageId) : undefined;
      if (partId && partType) {
        sessionState.partTypes.set(partId, partType);
      }

      if (eventScope.scope === "child") {
        if (partId && asString(part?.text) !== undefined) {
          sessionState.partTextById.set(partId, asString(part?.text) ?? "");
        }

        if (part && partType === "tool") {
          const toolEvent = buildOpenCodeToolLifecycleEvent(
            eventType,
            sseEvent,
            threadId,
            sessionState,
            part,
            eventScope.childSession,
          );
          return toolEvent ? [toolEvent] : [];
        }

        const partText = asString(part?.text);
        const streamKind = openCodePartStreamKind(partType);
        if (!partId || !partText || !streamKind || !messageRole) {
          return [];
        }

        updateOpenCodeChildSessionText(eventScope.childSession, messageRole, partText);
        return [
          buildOpenCodeChildSessionLifecycleEvent(
            eventType,
            sseEvent,
            threadId,
            sessionState,
            eventScope.childSession,
            "item.updated",
          ),
        ].filter((event): event is ProviderRuntimeEvent => event !== null);
      }

      if (messageRole !== "assistant") {
        return [];
      }

      const events: ProviderRuntimeEvent[] = [];
      if (sessionState.activeTurnId && sessionState.lastStatusType !== "busy") {
        sessionState.lastStatusType = "busy";
        events.push({
          ...createBaseFields(eventType, sseEvent, threadId),
          turnId: sessionState.activeTurnId,
          type: "turn.started",
          payload: {},
        });
      }

      if (part && partType === "tool") {
        const toolEvent = buildOpenCodeToolLifecycleEvent(
          eventType,
          sseEvent,
          threadId,
          sessionState,
          part,
        );
        if (toolEvent) {
          events.push(toolEvent);
        }
        return events;
      }

      const partText = asString(part?.text);
      const streamKind = openCodePartStreamKind(partType);
      if (!partId || !streamKind || partText === undefined) {
        return events;
      }

      const previousText = sessionState.partTextById.get(partId) ?? "";
      sessionState.partTextById.set(partId, partText);

      if (!partText.startsWith(previousText)) {
        return events;
      }

      const delta = partText.slice(previousText.length);
      if (delta.length === 0) {
        return events;
      }

      events.push({
        ...createBaseFields(eventType, sseEvent, threadId),
        ...(sessionState.activeTurnId ? { turnId: sessionState.activeTurnId } : {}),
        itemId: RuntimeItemId.makeUnsafe(messageId ?? partId),
        type: "content.delta",
        payload: {
          streamKind,
          delta,
        },
      });

      return events;
    }

    case "message.part.delta": {
      const partId = asString(properties.partID)?.trim();
      const field = asString(properties.field)?.trim();
      const delta = asString(properties.delta);
      const messageId = getOpenCodeMessageId(properties);
      const messageRole = messageId ? sessionState.messageRoleById.get(messageId) : undefined;
      if (!delta || field !== "text") {
        return [];
      }

      if (messageRole !== "assistant") {
        if (eventScope.scope !== "child") {
          return [];
        }
      }

      const partType = partId ? sessionState.partTypes.get(partId) : undefined;
      const streamKind = openCodePartStreamKind(partType);
      if (!streamKind) {
        return [];
      }

      if (partId) {
        const previousText = sessionState.partTextById.get(partId) ?? "";
        const nextText = `${previousText}${delta}`;
        sessionState.partTextById.set(partId, nextText);
        if (eventScope.scope === "child" && messageRole) {
          updateOpenCodeChildSessionText(eventScope.childSession, messageRole, nextText);
          return [
            buildOpenCodeChildSessionLifecycleEvent(
              eventType,
              sseEvent,
              threadId,
              sessionState,
              eventScope.childSession,
              "item.updated",
            ),
          ].filter((event): event is ProviderRuntimeEvent => event !== null);
        }
      }

      return [
        {
          ...createBaseFields(eventType, sseEvent, threadId),
          ...(sessionState.activeTurnId ? { turnId: sessionState.activeTurnId } : {}),
          ...((messageId ?? partId)
            ? { itemId: RuntimeItemId.makeUnsafe(messageId ?? partId!) }
            : {}),
          type: "content.delta",
          payload: {
            streamKind,
            delta,
          },
        },
      ];
    }

    case "message.part.removed": {
      const partId = asString(properties.partID)?.trim();
      if (partId) {
        sessionState.partTypes.delete(partId);
        sessionState.partTextById.delete(partId);
        sessionState.toolFingerprintById.delete(partId);
      }
      if (eventScope.scope === "child") {
        return [];
      }
      return [];
    }

    case "todo.updated": {
      const todos = Array.isArray(properties.todos)
        ? (normalizeOpenCodeTodos(properties.todos as never) ?? [])
        : [];
      return [
        {
          ...createBaseFields(eventType, sseEvent, threadId),
          type: "thread.metadata.updated",
          payload: {
            metadata: {
              todos,
            },
          },
        },
      ];
    }

    case "question.asked": {
      const requestId = asString(properties.id)?.trim();
      const questions = requestId ? toUserInputQuestions(properties, requestId) : undefined;
      if (!requestId || !questions) {
        return [];
      }

      sessionState.pendingQuestionIds.set(
        requestId,
        questions.map((question) => question.id),
      );

      return [
        {
          ...createBaseFields(eventType, sseEvent, threadId),
          requestId: RuntimeRequestId.makeUnsafe(requestId),
          ...(sessionState.activeTurnId ? { turnId: sessionState.activeTurnId } : {}),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    case "question.replied": {
      const requestId = asString(properties.requestID)?.trim();
      if (!requestId) {
        return [];
      }

      const questionIds = sessionState.pendingQuestionIds.get(requestId);
      sessionState.pendingQuestionIds.delete(requestId);

      return [
        {
          ...createBaseFields(eventType, sseEvent, threadId),
          requestId: RuntimeRequestId.makeUnsafe(requestId),
          ...(sessionState.activeTurnId ? { turnId: sessionState.activeTurnId } : {}),
          type: "user-input.resolved",
          payload: {
            answers: toCanonicalUserInputAnswers(questionIds, properties.answers),
          },
        },
      ];
    }

    case "question.rejected": {
      const requestId = asString(properties.requestID)?.trim();
      if (!requestId) {
        return [];
      }

      sessionState.pendingQuestionIds.delete(requestId);

      return [
        {
          ...createBaseFields(eventType, sseEvent, threadId),
          requestId: RuntimeRequestId.makeUnsafe(requestId),
          ...(sessionState.activeTurnId ? { turnId: sessionState.activeTurnId } : {}),
          type: "user-input.resolved",
          payload: {
            answers: {},
          },
        },
      ];
    }

    // ── Error events ──────────────────────────────────────────────
    case "error": {
      const message = getOpenCodeErrorMessage(properties) ?? "OpenCode runtime error";
      return [
        {
          ...createBaseFields(eventType, sseEvent, threadId),
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
  readonly binaryPath?: string;
}

const makeOpenCodeAdapter = (options?: OpenCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
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

    const connectEventStream = (
      creds: ReturnType<typeof openCodeServerControl.getCredentials>,
      threadId: ThreadId,
    ) =>
      Effect.gen(function* () {
        const { OpenCodeClient } = yield* Effect.promise(
          () => import("../../opencode/OpenCodeClient.ts"),
        );
        const client = new OpenCodeClient(creds.url, creds.username, creds.password);
        yield* Effect.tryPromise({
          try: async () => {
            sseClient.connect(client.getBaseUrl(), client.getAuthHeader());
            await sseClient.waitUntilConnected();
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to connect to OpenCode event stream."),
              cause,
            }),
        });
      });

    // ── Ensure the OpenCode server is running ─────────────────────
    const ensureServerRunning = (providerOptions?: {
      readonly serverUrl?: string;
      readonly binaryPath?: string;
    }) =>
      Effect.gen(function* () {
        const status = yield* Effect.tryPromise({
          try: () => openCodeServerControl.refreshStatus(),
          catch: () => openCodeServerControl.getStatus(),
        }).pipe(Effect.orElseSucceed(() => openCodeServerControl.getStatus()));

        if (status.state === "running") {
          // Already running — just ensure SSE is connected.
          const creds = openCodeServerControl.getCredentials();
          yield* connectEventStream(creds, ThreadId.makeUnsafe("__startup__"));
          return;
        }

        // Start via the shared singleton, forwarding any user-provided overrides.
        yield* Effect.tryPromise({
          try: () =>
            openCodeServerControl.start(
              (() => {
                const serverUrl = providerOptions?.serverUrl ?? options?.serverUrl;
                const binaryPath = providerOptions?.binaryPath ?? options?.binaryPath;
                return {
                  ...(serverUrl != null ? { serverUrl } : {}),
                  ...(binaryPath != null ? { binaryPath } : {}),
                };
              })(),
            ),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("__startup__"),
              detail: toMessage(cause, "Failed to start OpenCode server."),
              cause,
            }),
        });

        // Connect SSE to the now-running server.
        const creds = openCodeServerControl.getCredentials();
        yield* connectEventStream(creds, ThreadId.makeUnsafe("__startup__"));
      });

    // ── SSE event listener ────────────────────────────────────────
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const services = yield* Effect.services<never>();
        const handler = (sseEvent: OpenCodeSseEvent) => {
          const target = resolveOpenCodeEventTarget(sseEvent, sessions);
          if (!target) {
            return;
          }

          const { threadId: targetThreadId, session: targetState } = target;

          const runtimeEvents = mapSseToRuntimeEvents(sseEvent, targetThreadId, targetState);
          if (runtimeEvents.length === 0) return;

          Queue.offerAll(runtimeEventQueue, runtimeEvents).pipe(Effect.runPromiseWith(services));
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
        const ocOpts = input.providerOptions?.opencode;
        yield* ensureServerRunning(
          ocOpts
            ? {
                ...(ocOpts.serverUrl ? { serverUrl: ocOpts.serverUrl } : {}),
                ...(ocOpts.binaryPath ? { binaryPath: ocOpts.binaryPath } : {}),
              }
            : undefined,
        );

        const creds = openCodeServerControl.getCredentials();
        const { OpenCodeClient } = yield* Effect.promise(
          () => import("../../opencode/OpenCodeClient.ts"),
        );
        const client = new OpenCodeClient(creds.url, creds.username, creds.password);
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
          childSessionsById: new Map(),
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
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const creds = openCodeServerControl.getCredentials();
        const { OpenCodeClient } = yield* Effect.promise(
          () => import("../../opencode/OpenCodeClient.ts"),
        );
        const client = new OpenCodeClient(creds.url, creds.username, creds.password);
        const message = input.input ?? "";
        const openCodeModelOptions = input.modelOptions?.opencode;
        const resolvedModel = yield* Effect.tryPromise({
          try: () => client.resolveModelRef(state.directory, input.model),
          catch: (cause) => toRequestError(input.threadId, "sendTurn", cause),
        });
        const turnId = TurnId.makeUnsafe(makeEventId());

        yield* Effect.tryPromise({
          try: () =>
            client.sendPromptAsync(state.sessionId, message, state.directory, {
              ...(resolvedModel ? { model: resolvedModel } : {}),
              ...(openCodeModelOptions?.agent ? { agent: openCodeModelOptions.agent } : {}),
              ...(openCodeModelOptions?.allowQuestions !== undefined
                ? { tools: { question: openCodeModelOptions.allowQuestions } }
                : {}),
              ...(openCodeModelOptions?.variant ? { variant: openCodeModelOptions.variant } : {}),
            }),
          catch: (cause) => toRequestError(input.threadId, "sendTurn", cause),
        });

        state.activeTurnId = turnId;
        state.interruptedTurnId = null;
        state.partTypes.clear();
        state.partTextById.clear();
        state.toolFingerprintById.clear();
        state.messageSessionIdById.clear();
        state.selectedAgent = openCodeModelOptions?.agent ?? null;
        state.selectedVariant = openCodeModelOptions?.variant ?? null;
        state.selectedModelRef = resolvedModel ?? null;

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
        try: async () => {
          const creds = openCodeServerControl.getCredentials();
          const { OpenCodeClient } = await import("../../opencode/OpenCodeClient.ts");
          const client = new OpenCodeClient(creds.url, creds.username, creds.password);
          state.interruptedTurnId = state.activeTurnId;
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
      Effect.logDebug("OpenCode adapter: respondToRequest is a no-op in simplified adapter", {
        threadId,
      });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const state = sessions.get(threadId);
        if (!state) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        const questionIds = state.pendingQuestionIds.get(requestId);
        const orderedQuestionIds =
          questionIds && questionIds.length > 0 ? questionIds : Object.keys(answers ?? {});
        const orderedAnswers = orderedQuestionIds.map((questionId) =>
          toOpenCodeQuestionAnswer(answers?.[questionId]),
        );

        const creds = openCodeServerControl.getCredentials();
        const { OpenCodeClient } = yield* Effect.promise(
          () => import("../../opencode/OpenCodeClient.ts"),
        );
        const client = new OpenCodeClient(creds.url, creds.username, creds.password);

        yield* Effect.tryPromise({
          try: () => client.replyQuestion(requestId, orderedAnswers, state.directory),
          catch: (cause) => toRequestError(threadId, "respondToUserInput", cause),
        });
      });

    const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        sessions.delete(threadId);
      });

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => {
        const now = nowIso();
        return Array.from(sessions.entries()).map(([threadId, state]) => ({
          provider: PROVIDER,
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
        const creds = openCodeServerControl.getCredentials();
        const { OpenCodeClient } = yield* Effect.promise(
          () => import("../../opencode/OpenCodeClient.ts"),
        );
        const client = new OpenCodeClient(creds.url, creds.username, creds.password);
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

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
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

export const OpenCodeAdapterLive = Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter());

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  return Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter(options));
}
