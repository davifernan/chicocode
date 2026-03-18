import { useCallback, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import { type ProviderKind } from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

import { persistServerUiState } from "./serverUiState";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS = [1, 2, 3] as const;
export type SidebarOpenProjectLimit = (typeof SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS)[number];
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
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customOpenCodeModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

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

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function readLegacyAppSettingsValue(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLegacyAppSettingsValue(value: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (value === null) {
      window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, value);
  } catch {
    // Best-effort persistence only.
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    return normalizeAppSettings(Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(value));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = readLegacyAppSettingsValue();
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

export function readPersistedAppSettingsValue(): string | null {
  return readLegacyAppSettingsValue();
}

export function hydrateAppSettingsFromSerialized(value: string | null): void {
  if (value === cachedRawSettings) {
    return;
  }

  writeLegacyAppSettingsValue(value);
  cachedRawSettings = value;
  cachedSnapshot = parsePersistedSettings(value);
  emitChange();
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  if (raw !== cachedRawSettings) {
    writeLegacyAppSettingsValue(raw);
    persistServerUiState("appSettings", raw);
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeAppSettings(
      Schema.decodeSync(AppSettingsSchema)({
        ...getAppSettingsSnapshot(),
        ...patch,
      }),
    );
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
