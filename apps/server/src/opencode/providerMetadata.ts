import type {
  ThreadProviderMetadata,
  ThreadProviderMetadataTodo,
  ThreadProviderMetadataUsage,
} from "@t3tools/contracts";

import type {
  OpenCodeMessage,
  OpenCodeTodo,
  OpenCodeTokenData,
  OpenCodeModelRef,
} from "./OpenCodeClient.ts";

function asNonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeOpenCodeUsage(
  tokens: OpenCodeTokenData | null | undefined,
): ThreadProviderMetadataUsage | undefined {
  if (!tokens) return undefined;
  const input = Math.max(0, tokens.input ?? 0);
  const output = Math.max(0, tokens.output ?? 0);
  const reasoning = Math.max(0, tokens.reasoning ?? 0);
  const cacheRead = Math.max(0, tokens.cache?.read ?? 0);
  const cacheWrite = Math.max(0, tokens.cache?.write ?? 0);
  const total = input + output + reasoning + cacheRead + cacheWrite;
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total,
  };
}

export function normalizeOpenCodeTodos(
  todos: ReadonlyArray<OpenCodeTodo> | null | undefined,
): ReadonlyArray<ThreadProviderMetadataTodo> | undefined {
  if (!todos || todos.length === 0) return undefined;
  return todos
    .map((todo) => ({
      content: todo.content,
      status: todo.status,
      priority: todo.priority,
    }))
    .filter((todo) => todo.content.trim().length > 0);
}

export function buildOpenCodeThreadProviderMetadata(input: {
  readonly messages: ReadonlyArray<OpenCodeMessage>;
  readonly todos?: ReadonlyArray<OpenCodeTodo> | null | undefined;
  readonly fallbackAgentName?: string | null | undefined;
  readonly fallbackVariant?: string | null | undefined;
  readonly fallbackModelRef?: OpenCodeModelRef | null | undefined;
}): ThreadProviderMetadata | undefined {
  const lastAssistant = [...input.messages]
    .toReversed()
    .find((message) => message.info.role === "assistant");

  const latestUsage = normalizeOpenCodeUsage(lastAssistant?.info.tokens);
  const todos = normalizeOpenCodeTodos(input.todos);
  const agentName =
    asNonEmptyString(lastAssistant?.info.agent) ?? asNonEmptyString(input.fallbackAgentName);
  const agentVariant =
    asNonEmptyString(lastAssistant?.info.variant) ?? asNonEmptyString(input.fallbackVariant);
  const providerId =
    asNonEmptyString(lastAssistant?.info.providerID) ??
    asNonEmptyString(input.fallbackModelRef?.providerID);
  const modelId =
    asNonEmptyString(lastAssistant?.info.modelID) ??
    asNonEmptyString(input.fallbackModelRef?.modelID);
  const totalCostUsd = input.messages.reduce(
    (sum, message) => sum + (message.info.role === "assistant" ? (message.info.cost ?? 0) : 0),
    0,
  );

  const metadata: ThreadProviderMetadata = {
    ...(agentName ? { agentName } : {}),
    ...(agentVariant ? { agentVariant } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(latestUsage ? { latestUsage } : {}),
    ...(Number.isFinite(totalCostUsd) && totalCostUsd > 0 ? { totalCostUsd } : {}),
    ...(todos && todos.length > 0 ? { todos } : {}),
  };

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
