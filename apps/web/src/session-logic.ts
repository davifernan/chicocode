import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type MessageId,
  type ProviderKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type TurnId,
} from "@t3tools/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderKind | "cursor";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "opencode", label: "OpenCode", available: true },
  { value: "claudeAgent", label: "Claude Code", available: true },
  { value: "cursor", label: "Cursor", available: false },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  childSessionId?: string;
  subagentCard?: SubagentCardSnapshot;
}

export interface SubagentCardSnapshot {
  childSessionId: string;
  parentSessionId?: string;
  title: string;
  status: "running" | "completed" | "failed";
  inputText?: string;
  outputText?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}

export interface SubagentTimelineEntryData extends SubagentCardSnapshot {
  internals: WorkLogEntry[];
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    }
  | {
      id: string;
      kind: "subagent";
      createdAt: string;
      subagent: SubagentTimelineEntryData;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<
  OrchestrationLatestTurn,
  "turnId" | "requestedAt" | "startedAt" | "completedAt"
> & {
  assistantMessageId?: OrchestrationLatestTurn["assistantMessageId"];
};
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

function isLatestTurnActive(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.turnId) return false;
  if (session?.orchestrationStatus !== "running") return false;
  return session.activeTurnId === latestTurn.turnId;
}

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus !== "running") return true;
  if (!session.activeTurnId) return false;
  if (session.activeTurnId !== latestTurn.turnId) return true;
  return false;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const activeLatestTurn = isLatestTurnActive(latestTurn, session) ? latestTurn : null;
  if (activeLatestTurn) {
    return activeLatestTurn.startedAt ?? activeLatestTurn.requestedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

export function deriveCompletedTurnSummaryByAssistantMessageId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): Map<MessageId, string> {
  const orderedActivities = [...activities].toSorted(compareActivitiesByOrder);
  const startedAtByTurnId = new Map<TurnId, string>();
  const fallbackStartedAtByTurnId = new Map<TurnId, string>();
  const completedAtByTurnId = new Map<TurnId, string>();
  const assistantMessageIdByTurnId = new Map<TurnId, MessageId>();
  const hasToolActivityByTurnId = new Map<TurnId, boolean>();

  for (const activity of orderedActivities) {
    if (!activity.turnId) continue;

    if (!fallbackStartedAtByTurnId.has(activity.turnId)) {
      fallbackStartedAtByTurnId.set(activity.turnId, activity.createdAt);
    }
    if (activity.kind === "turn.started" && !startedAtByTurnId.has(activity.turnId)) {
      startedAtByTurnId.set(activity.turnId, activity.createdAt);
    }
    if (activity.kind === "turn.completed") {
      completedAtByTurnId.set(activity.turnId, activity.createdAt);
    }
    if (activity.tone === "tool") {
      hasToolActivityByTurnId.set(activity.turnId, true);
    }
  }

  for (const summary of turnDiffSummaries) {
    completedAtByTurnId.set(summary.turnId, summary.completedAt);
    if (summary.assistantMessageId) {
      assistantMessageIdByTurnId.set(summary.turnId, summary.assistantMessageId);
    }
  }

  if (latestTurn?.assistantMessageId && isLatestTurnSettled(latestTurn, session)) {
    assistantMessageIdByTurnId.set(latestTurn.turnId, latestTurn.assistantMessageId);
    if (latestTurn.completedAt) {
      completedAtByTurnId.set(latestTurn.turnId, latestTurn.completedAt);
    }
  }

  const result = new Map<MessageId, string>();
  for (const [turnId, assistantMessageId] of assistantMessageIdByTurnId) {
    if (!hasToolActivityByTurnId.get(turnId)) {
      continue;
    }
    const startedAt = startedAtByTurnId.get(turnId) ?? fallbackStartedAtByTurnId.get(turnId);
    const completedAt = completedAtByTurnId.get(turnId);
    if (!startedAt || !completedAt) {
      continue;
    }
    const elapsed = formatElapsed(startedAt, completedAt);
    if (!elapsed) {
      continue;
    }
    result.set(assistantMessageId, `Worked for ${elapsed}`);
  }

  return result;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      detail?.includes("Unknown pending permission request")
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return {
        id: matchingTurnPlan.id,
        createdAt: matchingTurnPlan.createdAt,
        updatedAt: matchingTurnPlan.updatedAt,
        turnId: matchingTurnPlan.turnId,
        planMarkdown: matchingTurnPlan.planMarkdown,
      };
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return {
    id: latestPlan.id,
    createdAt: latestPlan.createdAt,
    updatedAt: latestPlan.updatedAt,
    turnId: latestPlan.turnId,
    planMarkdown: latestPlan.planMarkdown,
  };
}

export function hasActionableProposedPlan(plan: LatestProposedPlanState | null): boolean {
  return plan != null;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  return ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter(
      (activity) =>
        activity.kind !== "tool.started" ||
        extractWorkLogItemType(asRecord(activity.payload)) === "collab_agent_tool_call",
    )
    .filter((activity) => activity.kind !== "task.started" && activity.kind !== "task.completed")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .map((activity) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const command = extractToolCommand(payload);
      const changedFiles = extractChangedFiles(payload);
      const title = extractToolTitle(payload);
      const childSessionId = extractChildSessionId(payload);
      const subagentCard = extractSubagentCardSnapshot(payload, activity.createdAt);
      const entry: WorkLogEntry = {
        id: activity.id,
        createdAt: activity.createdAt,
        label: activity.summary,
        tone: activity.tone === "approval" ? "info" : activity.tone,
      };
      const itemType = extractWorkLogItemType(payload);
      const requestKind = extractWorkLogRequestKind(payload);
      if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
        const detail = stripTrailingExitCode(payload.detail).output;
        if (detail) {
          entry.detail = detail;
        }
      }
      if (command) {
        entry.command = command;
      }
      if (changedFiles.length > 0) {
        entry.changedFiles = changedFiles;
      }
      if (title) {
        entry.toolTitle = title;
      }
      if (itemType) {
        entry.itemType = itemType;
      }
      if (requestKind) {
        entry.requestKind = requestKind;
      }
      if (childSessionId) {
        entry.childSessionId = childSessionId;
      }
      if (subagentCard) {
        entry.subagentCard = subagentCard;
      }
      return entry;
    });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function normalizeSubagentStatus(value: unknown): SubagentCardSnapshot["status"] {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

function extractChildSessionId(payload: Record<string, unknown> | null): string | undefined {
  const data = asRecord(payload?.data);
  const explicitChildSessionId = asTrimmedString(data?.childSessionId);
  if (explicitChildSessionId) {
    return explicitChildSessionId;
  }
  if (extractWorkLogItemType(payload) === "collab_agent_tool_call") {
    return asTrimmedString(data?.sessionId) ?? undefined;
  }
  return undefined;
}

function extractSubagentCardSnapshot(
  payload: Record<string, unknown> | null,
  createdAt: string,
): SubagentCardSnapshot | undefined {
  if (extractWorkLogItemType(payload) !== "collab_agent_tool_call") {
    return undefined;
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  const childSessionId = extractChildSessionId(payload);
  if (!childSessionId) {
    return undefined;
  }

  const title =
    asTrimmedString(data?.title) ??
    asTrimmedString(result?.title) ??
    asTrimmedString(payload?.title) ??
    "Sub-agent";
  const parentSessionId = asTrimmedString(data?.parentSessionId);
  const inputText = asTrimmedString(data?.inputText);
  const outputText = asTrimmedString(data?.outputText);
  const errorMessage = asTrimmedString(data?.errorMessage);
  const startedAt =
    asTrimmedString(data?.startedAt) ?? asTrimmedString(result?.startedAt) ?? createdAt;
  const completedAt = asTrimmedString(data?.completedAt) ?? asTrimmedString(result?.completedAt);

  return {
    childSessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    title,
    status: normalizeSubagentStatus(payload?.status ?? data?.status ?? result?.status),
    ...(inputText ? { inputText } : {}),
    ...(outputText ? { outputText } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    startedAt,
    ...(completedAt ? { completedAt } : {}),
  };
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

interface SubagentBridgeWindow {
  childSessionId: string;
  inputText?: string;
  outputText?: string;
  errorMessage?: string;
  startIndex: number;
  endIndex: number;
}

function normalizeBridgeText(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizeBridgeLabel(value: string | undefined): string | null {
  const normalized = normalizeBridgeText(value);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\s+(?:started|complete|completed)\s*$/i, "").trim() || null;
}

function deriveSubagentBridgeWindows(
  workEntries: ReadonlyArray<WorkLogEntry>,
): SubagentBridgeWindow[] {
  const windowsByChildSessionId = new Map<string, SubagentBridgeWindow>();

  for (let index = 0; index < workEntries.length; index += 1) {
    const entry = workEntries[index];
    const snapshot = entry?.subagentCard;
    if (!snapshot) {
      continue;
    }

    const existing = windowsByChildSessionId.get(snapshot.childSessionId);
    if (existing) {
      existing.startIndex = Math.min(existing.startIndex, index);
      existing.endIndex = Math.max(existing.endIndex, index);
      if (snapshot.inputText) {
        existing.inputText = snapshot.inputText;
      }
      if (snapshot.outputText) {
        existing.outputText = snapshot.outputText;
      }
      if (snapshot.errorMessage) {
        existing.errorMessage = snapshot.errorMessage;
      }
      continue;
    }

    windowsByChildSessionId.set(snapshot.childSessionId, {
      childSessionId: snapshot.childSessionId,
      ...(snapshot.inputText ? { inputText: snapshot.inputText } : {}),
      ...(snapshot.outputText ? { outputText: snapshot.outputText } : {}),
      ...(snapshot.errorMessage ? { errorMessage: snapshot.errorMessage } : {}),
      startIndex: index,
      endIndex: index,
    });
  }

  return [...windowsByChildSessionId.values()];
}

function isGenericTaskBridgeEntry(entry: WorkLogEntry): boolean {
  if (entry.command || entry.detail || (entry.changedFiles?.length ?? 0) > 0) {
    return false;
  }
  const label = normalizeBridgeLabel(entry.toolTitle ?? entry.label);
  return label === "task";
}

function matchesSubagentInputEcho(entry: WorkLogEntry, window: SubagentBridgeWindow): boolean {
  const inputText = normalizeBridgeText(window.inputText);
  if (!inputText) {
    return false;
  }

  return [entry.label, entry.detail]
    .map((value) => normalizeBridgeText(value))
    .some((value) => value === inputText);
}

function matchesSubagentResultEcho(entry: WorkLogEntry): boolean {
  const detailText = normalizeBridgeText([entry.label, entry.detail].filter(Boolean).join(" "));
  if (!detailText) {
    return false;
  }
  return detailText.includes("task_id:") || detailText.includes("<task_result>");
}

function shouldSuppressDuplicateSubagentBridgeEntry(
  entry: WorkLogEntry,
  index: number,
  windows: ReadonlyArray<SubagentBridgeWindow>,
): boolean {
  if (entry.childSessionId || entry.subagentCard) {
    return false;
  }

  for (const window of windows) {
    const nearStart = index >= window.startIndex - 3 && index <= window.startIndex + 1;
    const nearEnd = index >= window.endIndex - 1 && index <= window.endIndex + 3;

    if (nearStart && matchesSubagentInputEcho(entry, window)) {
      return true;
    }
    if (nearEnd && matchesSubagentResultEcho(entry)) {
      return true;
    }
    if (
      isGenericTaskBridgeEntry(entry) &&
      ((nearStart && Boolean(window.inputText)) ||
        (nearEnd && Boolean(window.outputText || window.errorMessage)))
    ) {
      return true;
    }
  }

  return false;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const subagentByChildSessionId = new Map<
    string,
    {
      id: string;
      createdAt: string;
      subagent: SubagentTimelineEntryData;
    }
  >();
  const workRows: TimelineEntry[] = [];
  const subagentBridgeWindows = deriveSubagentBridgeWindows(workEntries);

  for (let index = 0; index < workEntries.length; index += 1) {
    const entry = workEntries[index];
    if (!entry) {
      continue;
    }
    if (shouldSuppressDuplicateSubagentBridgeEntry(entry, index, subagentBridgeWindows)) {
      continue;
    }

    const childSessionId = entry.subagentCard?.childSessionId ?? entry.childSessionId;
    if (!childSessionId) {
      workRows.push({
        id: entry.id,
        kind: "work",
        createdAt: entry.createdAt,
        entry,
      });
      continue;
    }

    const existing = subagentByChildSessionId.get(childSessionId);
    const aggregate =
      existing ??
      (() => {
        const snapshot = entry.subagentCard;
        const next = {
          id: `subagent:${childSessionId}`,
          createdAt: snapshot?.startedAt ?? entry.createdAt,
          subagent: {
            childSessionId,
            title: snapshot?.title ?? entry.toolTitle ?? "Sub-agent",
            status: snapshot?.status ?? "running",
            startedAt: snapshot?.startedAt ?? entry.createdAt,
            ...(snapshot?.parentSessionId ? { parentSessionId: snapshot.parentSessionId } : {}),
            ...(snapshot?.inputText ? { inputText: snapshot.inputText } : {}),
            ...(snapshot?.outputText ? { outputText: snapshot.outputText } : {}),
            ...(snapshot?.errorMessage ? { errorMessage: snapshot.errorMessage } : {}),
            ...(snapshot?.completedAt ? { completedAt: snapshot.completedAt } : {}),
            internals: [],
          } satisfies SubagentTimelineEntryData,
        };
        subagentByChildSessionId.set(childSessionId, next);
        return next;
      })();

    if (entry.subagentCard) {
      aggregate.createdAt =
        aggregate.createdAt.localeCompare(entry.subagentCard.startedAt) <= 0
          ? aggregate.createdAt
          : entry.subagentCard.startedAt;
      aggregate.subagent.title = entry.subagentCard.title;
      aggregate.subagent.status = entry.subagentCard.status;
      aggregate.subagent.startedAt = entry.subagentCard.startedAt;
      if (entry.subagentCard.parentSessionId) {
        aggregate.subagent.parentSessionId = entry.subagentCard.parentSessionId;
      }
      if (entry.subagentCard.inputText) {
        aggregate.subagent.inputText = entry.subagentCard.inputText;
      }
      if (entry.subagentCard.outputText) {
        aggregate.subagent.outputText = entry.subagentCard.outputText;
      }
      if (entry.subagentCard.errorMessage) {
        aggregate.subagent.errorMessage = entry.subagentCard.errorMessage;
      }
      if (entry.subagentCard.completedAt) {
        aggregate.subagent.completedAt = entry.subagentCard.completedAt;
      }
      continue;
    }

    aggregate.subagent.internals.push(entry);
  }

  const subagentRows: TimelineEntry[] = [...subagentByChildSessionId.values()].map((entry) => ({
    id: entry.id,
    kind: "subagent",
    createdAt: entry.createdAt,
    subagent: entry.subagent,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows, ...subagentRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
