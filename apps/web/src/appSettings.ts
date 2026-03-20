import { useCallback, useEffect } from "react";
import { Option, Schema } from "effect";
import { TrimmedNonEmptyString, type ProviderKind } from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { EnvMode } from "./components/BranchToolbar.logic";
import { hydrateServerUiState, persistServerUiState } from "./serverUiState";
import { readNativeApi } from "./nativeApi";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;

export const SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS = [1, 2, 3] as const;
export type SidebarOpenProjectLimit = (typeof SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS)[number];

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  opencode: new Set(getModelOptions("opencode").map((option) => option.slug)),
  claudeAgent: new Set(getModelOptions("claudeAgent").map((option) => option.slug)),
};

const withDefaults =
  <
    S extends Schema.Top & Schema.WithoutConstructorDefault,
    D extends S["~type.make.in"] & S["Encoded"],
  >(
    fallback: () => D,
  ) =>
  (schema: S) =>
    schema.pipe(
      Schema.withConstructorDefault(() => Option.some(fallback())),
      Schema.withDecodingDefault(() => fallback()),
    );

export const AppSettingsSchema = Schema.Struct({
  defaultProvider: Schema.Literals(["codex", "opencode", "claudeAgent"]).pipe(
    withDefaults(() => "codex" as ProviderKind),
  ),
  defaultCodexModel: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)).pipe(
    withDefaults(() => getDefaultModel("codex")),
  ),
  defaultOpenCodeModel: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)).pipe(
    withDefaults(() => ""),
  ),
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  opencodeServerUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  opencodeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  defaultThreadEnvMode: EnvMode.pipe(withDefaults(() => "local" as const satisfies EnvMode)),
  confirmThreadDelete: Schema.Boolean.pipe(withDefaults(() => true)),
  enableAssistantStreaming: Schema.Boolean.pipe(withDefaults(() => false)),
  timestampFormat: TimestampFormat.pipe(withDefaults(() => DEFAULT_TIMESTAMP_FORMAT)),
  sidebarOpenProjectLimit: Schema.Literals([1, 2, 3]).pipe(
    withDefaults(() => 1 as SidebarOpenProjectLimit),
  ),
  enableOpencodeChatColors: Schema.Boolean.pipe(withDefaults(() => false)),
  navigateToForkedThread: Schema.Boolean.pipe(withDefaults(() => false)),
  forkPreFillContent: Schema.Boolean.pipe(withDefaults(() => true)),
  customCodexModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customOpenCodeModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customClaudeModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

export function readPersistedAppSettingsValue(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function hydrateAppSettingsFromSerialized(value: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (value === null) {
      window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, value);
    }
  } catch {
    // Best-effort persistence only.
  }

  window.dispatchEvent(
    new CustomEvent("t3code:local_storage_change", {
      detail: { key: APP_SETTINGS_STORAGE_KEY },
    }),
  );
}

// ── Server-backed persistence ─────────────────────────────────────────

/**
 * Module-level guard: startup hydration from server runs exactly once per
 * page load regardless of how many useAppSettings() callers are mounted.
 */
let _serverHydrationStarted = false;

/**
 * Kick off a one-time load of app settings from the server DB.
 * Falls back to the existing localStorage value if the server has nothing.
 *
 * Call from the first useAppSettings() mount.
 */
function startServerHydration(): void {
  if (_serverHydrationStarted) return;
  _serverHydrationStarted = true;

  void hydrateServerUiState({
    key: "appSettings",
    readLegacyValue: readPersistedAppSettingsValue,
    onHydrate: hydrateAppSettingsFromSerialized,
  });
}

/**
 * Immediately write the current settings to the server DB.
 * Returns a promise that resolves when the write completes.
 *
 * Used by the manual "Sync" button in SettingsModal.
 */
export async function forceSyncAppSettingsToServer(): Promise<void> {
  const api = readNativeApi();
  if (!api) throw new Error("Server API not available. Is the T3 server running?");

  const valueJson = readPersistedAppSettingsValue();
  if (valueJson === null) {
    throw new Error("No settings found in local storage.");
  }

  await api.server.upsertUiState({ key: "appSettings", valueJson });
}

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customOpenCodeModels: normalizeCustomModelSlugs(settings.customOpenCodeModels, "opencode"),
    customClaudeModels: normalizeCustomModelSlugs(settings.customClaudeModels, "claudeAgent"),
  };
}
export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function useAppSettings() {
  const [settings, setSettings] = useLocalStorage(
    APP_SETTINGS_STORAGE_KEY,
    DEFAULT_APP_SETTINGS,
    AppSettingsSchema,
  );

  // Load settings from the server DB once on first mount.
  // This restores settings that survived a server restart or were saved from
  // another browser/machine via the Sync button.
  useEffect(() => {
    startServerHydration();
  }, []);

  // Keep server UI state in sync whenever settings change.
  useEffect(() => {
    try {
      const raw = JSON.stringify(settings);
      persistServerUiState("appSettings", raw);
    } catch {
      // Best-effort only.
    }
  }, [settings]);

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => normalizeAppSettings({ ...prev, ...patch }));
    },
    [setSettings],
  );

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_APP_SETTINGS);
  }, [setSettings]);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
