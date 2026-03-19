import { useCallback, useEffect } from "react";
import { Option, Schema } from "effect";
import { TrimmedNonEmptyString, type ProviderKind } from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { useLocalStorage } from "./hooks/useLocalStorage";

import { hydrateServerUiState, persistServerUiState } from "./serverUiState";
import { readNativeApi } from "./nativeApi";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;

export const SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS = [1, 2, 3] as const;
export type SidebarOpenProjectLimit = (typeof SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS)[number];

export const TIMESTAMP_FORMAT_OPTIONS = ["locale", "12-hour", "24-hour"] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMAT_OPTIONS)[number];
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  opencode: new Set(),
};

const AppSettingsSchema = Schema.Struct({
  defaultProvider: Schema.Literals(["codex", "opencode"]).pipe(
    Schema.withConstructorDefault(() => Option.some("codex")),
  ),
  defaultCodexModel: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)).pipe(
    Schema.withConstructorDefault(() => Option.some(getDefaultModel("codex"))),
  ),
  defaultOpenCodeModel: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  opencodeServerUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  opencodeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  defaultThreadEnvMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withConstructorDefault(() => Option.some("local")),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  enableOpencodeChatColors: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  sidebarOpenProjectLimit: Schema.Literals([1, 2, 3]).pipe(
    Schema.withConstructorDefault(() => Option.some(1)),
  ),
  timestampFormat: Schema.Literals(["locale", "12-hour", "24-hour"]).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customOpenCodeModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

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
  const customCodexModels = normalizeCustomModelSlugs(settings.customCodexModels, "codex");
  const customOpenCodeModels = normalizeCustomModelSlugs(settings.customOpenCodeModels, "opencode");
  const normalizedDefaultOpenCodeModel = normalizeModelSlug(
    settings.defaultOpenCodeModel,
    "opencode",
  );
  return {
    ...settings,
    customCodexModels,
    customOpenCodeModels,
    defaultCodexModel: resolveAppModelSelection(
      "codex",
      customCodexModels,
      settings.defaultCodexModel,
    ),
    defaultOpenCodeModel: resolveAppModelSelection(
      "opencode",
      customOpenCodeModels,
      normalizedDefaultOpenCodeModel &&
        customOpenCodeModels.includes(normalizedDefaultOpenCodeModel)
        ? normalizedDefaultOpenCodeModel
        : (customOpenCodeModels[0] ?? ""),
    ),
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] =
    provider === "opencode"
      ? []
      : getModelOptions(provider).map(({ slug, name }) => ({
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
  if (provider !== "opencode" && normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
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
  if (provider === "opencode") {
    if (normalizedSelectedModel) {
      return options.find((option) => option.slug === normalizedSelectedModel)?.slug ?? "";
    }
    return options[0]?.slug ?? "";
  }
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

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
