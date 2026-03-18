import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const OpenCodeModelOptions = Schema.Struct({
  agent: Schema.optional(TrimmedNonEmptyString),
  variant: Schema.optional(TrimmedNonEmptyString),
  allowQuestions: Schema.optional(Schema.Boolean),
});
export type OpenCodeModelOptions = typeof OpenCodeModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  opencode: Schema.optional(OpenCodeModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

type ModelOption = {
  readonly slug: string;
  readonly name: string;
};

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
  ],
  opencode: [
    { slug: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { slug: "claude-opus-4-20250918", name: "Claude Opus 4" },
    { slug: "o3", name: "o3" },
    { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { slug: "gpt-4.1", name: "GPT-4.1" },
  ],
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = ModelOptionsByProvider[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
  opencode: "claude-sonnet-4-20250514",
} as const satisfies Record<ProviderKind, ModelSlug>;

export const DEFAULT_GIT_TEXT_GENERATION_MODEL = "gpt-5.4-mini" as const;

export const MODEL_SLUG_ALIASES_BY_PROVIDER = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  opencode: {
    sonnet: "claude-sonnet-4-20250514",
    opus: "claude-opus-4-20250918",
    o3: "o3",
    gemini: "gemini-2.5-pro",
  },
} as const satisfies Record<ProviderKind, Record<string, ModelSlug>>;

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  opencode: CODEX_REASONING_EFFORT_OPTIONS,
} as const satisfies Record<ProviderKind, readonly CodexReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  opencode: null,
} as const satisfies Record<ProviderKind, CodexReasoningEffort | null>;
