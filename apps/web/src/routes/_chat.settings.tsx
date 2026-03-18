import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { type ProviderKind, DEFAULT_GIT_TEXT_GENERATION_MODEL } from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

import {
  MAX_CUSTOM_MODEL_LENGTH,
  SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS,
  getAppModelOptions,
  useAppSettings,
} from "../appSettings";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { APP_VERSION } from "../branding";
import { SidebarInset } from "~/components/ui/sidebar";
import { serverApiUrl } from "~/lib/serverOrigin";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const DEFAULT_PROVIDER_OPTIONS = [
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
] as const satisfies ReadonlyArray<{ value: ProviderKind; label: string }>;

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
] as const;

const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "chat", label: "Chat" },
  { id: "sidebar", label: "Sidebar" },
  { id: "responses", label: "Responses" },
  { id: "keybindings", label: "Keys" },
  { id: "safety", label: "Safety" },
  { id: "about", label: "About" },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

// ── OpenCode provider catalog types (mirrors GET /api/opencode/providers) ──

interface OpenCodeProviderModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly family?: string;
  readonly status?: "alpha" | "beta" | "deprecated" | "active";
}

interface OpenCodeProvider {
  readonly id: string;
  readonly name: string;
  readonly models: Record<string, OpenCodeProviderModel>;
}

interface OpenCodeProviderListResponse {
  readonly all: readonly OpenCodeProvider[];
  readonly default: Record<string, string>;
  readonly connected: readonly string[];
}

async function fetchOpenCodeProviders(opts?: {
  serverUrl?: string;
  binaryPath?: string;
}): Promise<OpenCodeProviderListResponse> {
  const resp = await fetch(buildOpenCodeSettingsPath("/api/opencode/providers", opts), {
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch OpenCode providers (${resp.status})`);
  }
  return (await resp.json()) as OpenCodeProviderListResponse;
}

function buildOpenCodeSettingsPath(
  pathname: string,
  opts?: {
    serverUrl?: string;
    binaryPath?: string;
  },
): string {
  const params = new URLSearchParams();
  if (opts?.serverUrl) {
    params.set("serverUrl", opts.serverUrl);
  }
  if (opts?.binaryPath) {
    params.set("binaryPath", opts.binaryPath);
  }
  // Always use an absolute URL so the request reaches the T3 backend
  // directly — required in Electron where the backend runs on a dynamic port.
  const base = serverApiUrl(pathname);
  if (params.size === 0) {
    return base;
  }
  return `${base}?${params.toString()}`;
}

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "opencode":
      return settings.customOpenCodeModels;
    case "codex":
    default:
      return settings.customCodexModels;
  }
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "opencode":
      return defaults.customOpenCodeModels;
    case "codex":
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "opencode":
      return { customOpenCodeModels: models };
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

// ── OpenCode Server Status Panel ────────────────────────────────────

interface OpenCodeServerStatusResponse {
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly url?: string;
  readonly managedByT3?: boolean;
  readonly message?: string;
}

async function fetchOpenCodeServerStatus(opts?: {
  serverUrl?: string;
}): Promise<OpenCodeServerStatusResponse> {
  const resp = await fetch(buildOpenCodeSettingsPath("/api/opencode/server", opts), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) throw new Error(`Server status fetch failed (${resp.status})`);
  return (await resp.json()) as OpenCodeServerStatusResponse;
}

async function startOpenCodeServer(opts?: {
  serverUrl?: string;
  binaryPath?: string;
}): Promise<OpenCodeServerStatusResponse> {
  const hasBody = opts?.serverUrl || opts?.binaryPath;
  const resp = await fetch(serverApiUrl("/api/opencode/server/start"), {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    ...(hasBody
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(opts?.serverUrl ? { serverUrl: opts.serverUrl } : {}),
            ...(opts?.binaryPath ? { binaryPath: opts.binaryPath } : {}),
          }),
        }
      : {}),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Start failed (${resp.status})`);
  }
  return (await resp.json()) as OpenCodeServerStatusResponse;
}

async function stopOpenCodeServer(): Promise<OpenCodeServerStatusResponse> {
  const resp = await fetch(serverApiUrl("/api/opencode/server/stop"), {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Stop failed (${resp.status})`);
  }
  return (await resp.json()) as OpenCodeServerStatusResponse;
}

function OpenCodeServerStatusPanel() {
  const { settings } = useAppSettings();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["opencode", "server-status", settings.opencodeServerUrl ?? null],
    queryFn: () =>
      fetchOpenCodeServerStatus(
        settings.opencodeServerUrl ? { serverUrl: settings.opencodeServerUrl } : undefined,
      ),
    refetchInterval: (query) => (query.state.data?.state === "starting" ? 1_000 : false),
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const status = statusQuery.data;

  const handleStart = async () => {
    setActionError(null);
    setIsActing(true);
    try {
      await startOpenCodeServer(
        settings.opencodeServerUrl || settings.opencodeBinaryPath
          ? {
              ...(settings.opencodeServerUrl ? { serverUrl: settings.opencodeServerUrl } : {}),
              ...(settings.opencodeBinaryPath ? { binaryPath: settings.opencodeBinaryPath } : {}),
            }
          : undefined,
      );
      await statusQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start server.");
    } finally {
      setIsActing(false);
    }
  };

  const handleStop = async () => {
    setActionError(null);
    setIsActing(true);
    try {
      await stopOpenCodeServer();
      await statusQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to stop server.");
    } finally {
      setIsActing(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">Server status</p>
          {status?.state === "running" ? (
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
              {status.url ?? "running"}
            </p>
          ) : status?.state === "error" ? (
            <p className="mt-0.5 text-[11px] text-destructive">{status.message}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Status badge */}
          {statusQuery.isLoading ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Checking...
            </span>
          ) : status?.state === "running" ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              Running
            </span>
          ) : status?.state === "starting" ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              Starting...
            </span>
          ) : status?.state === "error" ? (
            <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
              Error
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Stopped
            </span>
          )}

          {/* Action buttons */}
          {status?.state !== "running" && status?.state !== "starting" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isActing}
              onClick={() => void handleStart()}
            >
              {isActing ? "Starting..." : "Start"}
            </Button>
          ) : null}
          {status?.state === "running" && status.managedByT3 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isActing}
              onClick={() => void handleStop()}
            >
              {isActing ? "Stopping..." : "Stop"}
            </Button>
          ) : null}
        </div>
      </div>

      {actionError ? <p className="mt-2 text-xs text-destructive">{actionError}</p> : null}
    </div>
  );
}

// ── OpenCode Model Picker ───────────────────────────────────────────

function OpenCodeModelPicker(props: {
  customModels: readonly string[];
  serverUrl?: string;
  binaryPath?: string;
  onAddModel: (slug: string) => void;
  onRemoveModel: (slug: string) => void;
  onResetModels: () => void;
}) {
  const [search, setSearch] = useState("");
  const providersQuery = useQuery({
    queryKey: ["opencode", "providers", props.serverUrl ?? null, props.binaryPath ?? null],
    queryFn: () =>
      fetchOpenCodeProviders(
        props.serverUrl || props.binaryPath
          ? {
              ...(props.serverUrl ? { serverUrl: props.serverUrl } : {}),
              ...(props.binaryPath ? { binaryPath: props.binaryPath } : {}),
            }
          : undefined,
      ),
    staleTime: 60_000,
    retry: 1,
  });

  // Build a flat lookup: qualifiedId -> { provider, model, isConnected }
  // so we can resolve selected models without re-scanning.
  const { modelIndex, searchResults } = useMemo(() => {
    if (!providersQuery.data)
      return {
        modelIndex: new Map<
          string,
          { providerName: string; isConnected: boolean; model: OpenCodeProviderModel }
        >(),
        searchResults: [] as Array<{
          provider: OpenCodeProvider;
          isConnected: boolean;
          models: OpenCodeProviderModel[];
        }>,
      };
    const { all, connected } = providersQuery.data;
    const connectedSet = new Set(connected);
    const idx = new Map<
      string,
      { providerName: string; isConnected: boolean; model: OpenCodeProviderModel }
    >();

    for (const provider of all) {
      const isConn = connectedSet.has(provider.id);
      for (const model of Object.values(provider.models)) {
        const qid = `${provider.id}/${model.id}`;
        idx.set(qid, { providerName: provider.name, isConnected: isConn, model });
      }
    }

    const normalizedSearch = search.trim().toLowerCase();
    let results: Array<{
      provider: OpenCodeProvider;
      isConnected: boolean;
      models: OpenCodeProviderModel[];
    }> = [];
    if (normalizedSearch) {
      results = all
        .filter((p) => Object.keys(p.models).length > 0)
        .map((provider) => {
          const models = Object.values(provider.models)
            .filter((m) => {
              if (m.status === "deprecated") return false;
              return (
                m.id.toLowerCase().includes(normalizedSearch) ||
                m.name.toLowerCase().includes(normalizedSearch) ||
                provider.name.toLowerCase().includes(normalizedSearch)
              );
            })
            .toSorted((a, b) => a.name.localeCompare(b.name));
          return { provider, isConnected: connectedSet.has(provider.id), models };
        })
        .filter((g) => g.models.length > 0)
        .toSorted((a, b) => {
          if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
          return a.provider.name.localeCompare(b.provider.name);
        });
    }

    return { modelIndex: idx, searchResults: results };
  }, [providersQuery.data, search]);

  const isLoading = providersQuery.isLoading;
  const isError = providersQuery.isError;
  const hasData = providersQuery.data != null;
  const isSearching = search.trim().length > 0;

  return (
    <div className="rounded-xl border border-border bg-background/50 p-4">
      <div className="mb-4">
        <h3 className="text-sm font-medium text-foreground">OpenCode</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Search to browse all models from your OpenCode server. Selected models appear below.
        </p>
      </div>

      <div className="space-y-4">
        {/* Search — only shown when data is available */}
        {hasData && !isLoading ? (
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models to add..."
            spellCheck={false}
          />
        ) : null}

        {/* Loading state */}
        {isLoading ? (
          <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
            Fetching models from OpenCode server...
          </div>
        ) : null}

        {/* Error state */}
        {isError ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-xs text-destructive">
              Could not reach the OpenCode server. Make sure{" "}
              <code className="font-mono">opencode serve</code> is running.
            </div>
            <Button size="xs" variant="outline" onClick={() => void providersQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}

        {/* Search results — only shown while typing */}
        {hasData && !isLoading && isSearching ? (
          <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-border bg-background p-2">
            {searchResults.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                No models match your search.
              </div>
            ) : (
              searchResults.map(({ provider, isConnected, models }) => (
                <div key={provider.id} className="space-y-1.5">
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-xs font-medium text-foreground">{provider.name}</span>
                    {isConnected ? (
                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        Connected
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        Not connected
                      </span>
                    )}
                  </div>
                  <div className="grid gap-1">
                    {models.map((model) => {
                      const qualifiedId = `${provider.id}/${model.id}`;
                      const isAdded = props.customModels.includes(qualifiedId);

                      return (
                        <button
                          key={qualifiedId}
                          type="button"
                          className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer ${
                            isAdded
                              ? "border-primary/40 bg-primary/5"
                              : "border-border hover:bg-accent"
                          }`}
                          onClick={() => {
                            if (isAdded) {
                              props.onRemoveModel(qualifiedId);
                            } else {
                              props.onAddModel(qualifiedId);
                            }
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-foreground">
                              {model.name}
                            </div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">
                              {model.id}
                            </div>
                          </div>
                          <div className="shrink-0">
                            {isAdded ? (
                              <span className="text-[10px] font-medium text-primary uppercase tracking-wide">
                                Added
                              </span>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {/* Selected models — always visible */}
        {hasData && !isLoading ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Selected models ({props.customModels.length})
              </span>
              {props.customModels.length > 0 ? (
                <Button size="xs" variant="outline" onClick={props.onResetModels}>
                  Clear all
                </Button>
              ) : null}
            </div>

            {props.customModels.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                No models selected. Use the search above to find and add models.
              </div>
            ) : (
              <div className="grid gap-1.5">
                {props.customModels.map((qualifiedId) => {
                  const entry = modelIndex.get(qualifiedId);
                  return (
                    <div
                      key={qualifiedId}
                      className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-foreground">
                          {entry ? entry.model.name : qualifiedId}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {entry ? `${entry.providerName} / ${entry.model.id}` : qualifiedId}
                        </div>
                      </div>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => props.onRemoveModel(qualifiedId)}
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Partial<Record<ProviderKind, string>>
  >({
    codex: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const opencodeServerUrl = settings.opencodeServerUrl;
  const opencodeBinaryPath = settings.opencodeBinaryPath;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const defaultModelOptionsByProvider = useMemo(
    () => ({
      codex: getAppModelOptions("codex", settings.customCodexModels, settings.defaultCodexModel),
      opencode: settings.customOpenCodeModels.map((slug) => ({
        slug,
        name: slug,
        isCustom: true,
      })),
    }),
    [settings.customCodexModels, settings.customOpenCodeModels, settings.defaultCodexModel],
  );

  const availableEditors = serverConfigQuery.data?.availableEditors;

  const gitTextGenerationModelOptions = getAppModelOptions(
    "codex",
    settings.customCodexModels,
    settings.textGenerationModel,
  );
  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find(
      (option) =>
        option.slug === (settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL),
    )?.name ?? settings.textGenerationModel;

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void api.shell
      .openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (
        provider === "codex" &&
        getModelOptions(provider).some((option) => option.slug === normalized)
      ) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const scrollToSection = useCallback((sectionId: (typeof SETTINGS_SECTIONS)[number]["id"]) => {
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-[var(--settings-content-max-width)] flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <div className="sticky top-0 z-10 -mx-1 rounded-xl border border-border/80 bg-background/95 px-3 py-3 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-background/80">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
                  Jump to
                </span>
                <span className="text-[11px] text-muted-foreground/60">
                  Quick section navigation
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {SETTINGS_SECTIONS.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => scrollToSection(section.id)}
                  >
                    {section.label}
                  </button>
                ))}
              </div>
            </div>

            <section
              id="appearance"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how T3 Code looks across the app.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                  {THEME_OPTIONS.map((option) => {
                    const selected = theme === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                          selected
                            ? "border-primary/60 bg-primary/8 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-accent"
                        }`}
                        onClick={() => setTheme(option.value)}
                      >
                        <span className="flex flex-col">
                          <span className="text-sm font-medium">{option.label}</span>
                          <span className="text-xs">{option.description}</span>
                        </span>
                        {selected ? (
                          <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                            Selected
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>

                <p className="text-xs text-muted-foreground">
                  Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
                </p>

                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Timestamp format</p>
                    <p className="text-xs text-muted-foreground">
                      System default follows your browser or OS time format. <code>12-hour</code>{" "}
                      and <code>24-hour</code> force the hour cycle.
                    </p>
                  </div>
                  <Select
                    value={settings.timestampFormat}
                    onValueChange={(value) => {
                      if (value !== "locale" && value !== "12-hour" && value !== "24-hour") return;
                      updateSettings({
                        timestampFormat: value,
                      });
                    }}
                  >
                    <SelectTrigger className="w-40" aria-label="Timestamp format">
                      <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end">
                      <SelectItem value="locale">{TIMESTAMP_FORMAT_LABELS.locale}</SelectItem>
                      <SelectItem value="12-hour">{TIMESTAMP_FORMAT_LABELS["12-hour"]}</SelectItem>
                      <SelectItem value="24-hour">{TIMESTAMP_FORMAT_LABELS["24-hour"]}</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>

                {settings.timestampFormat !== defaults.timestampFormat ? (
                  <div className="flex justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        updateSettings({
                          timestampFormat: defaults.timestampFormat,
                        })
                      }
                    >
                      Restore default
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>

            <section
              id="providers"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p>Binary source</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                      {codexBinaryPath || "PATH"}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="self-start"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
            </section>

            <section className="scroll-mt-24 rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">OpenCode Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new OpenCode sessions and let you connect to a custom
                  OpenCode server instance.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="opencode-server-url" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Server URL</span>
                  <Input
                    id="opencode-server-url"
                    value={opencodeServerUrl}
                    onChange={(event) => updateSettings({ opencodeServerUrl: event.target.value })}
                    placeholder="http://localhost:13337"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to auto-start a local OpenCode server.
                  </span>
                </label>

                <label htmlFor="opencode-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">OpenCode binary path</span>
                  <Input
                    id="opencode-binary-path"
                    value={opencodeBinaryPath}
                    onChange={(event) => updateSettings({ opencodeBinaryPath: event.target.value })}
                    placeholder="opencode"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>opencode</code> from your PATH.
                  </span>
                </label>

                <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p>Server URL</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                      {opencodeServerUrl || "auto"}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="self-start"
                    onClick={() =>
                      updateSettings({
                        opencodeServerUrl: defaults.opencodeServerUrl,
                        opencodeBinaryPath: defaults.opencodeBinaryPath,
                      })
                    }
                  >
                    Reset opencode overrides
                  </Button>
                </div>
              </div>

              {/* Server status + start/stop */}
              <OpenCodeServerStatusPanel />
            </section>

            <section
              id="models"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                {/* Codex: manual slug entry */}
                {MODEL_PROVIDER_SETTINGS.filter((ps) => ps.provider === "codex").map(
                  (providerSettings) => {
                    const provider = providerSettings.provider;
                    const customModels = getCustomModelsForProvider(settings, provider);
                    const customModelInput = customModelInputByProvider[provider] ?? "";
                    const customModelError = customModelErrorByProvider[provider] ?? null;
                    return (
                      <div
                        key={provider}
                        className="rounded-xl border border-border bg-background/50 p-4"
                      >
                        <div className="mb-4">
                          <h3 className="text-sm font-medium text-foreground">
                            {providerSettings.title}
                          </h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {providerSettings.description}
                          </p>
                        </div>

                        <div className="space-y-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                            <label
                              htmlFor={`custom-model-slug-${provider}`}
                              className="block flex-1 space-y-1"
                            >
                              <span className="text-xs font-medium text-foreground">
                                Custom model slug
                              </span>
                              <Input
                                id={`custom-model-slug-${provider}`}
                                value={customModelInput}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setCustomModelInputByProvider((existing) => ({
                                    ...existing,
                                    [provider]: value,
                                  }));
                                  if (customModelError) {
                                    setCustomModelErrorByProvider((existing) => ({
                                      ...existing,
                                      [provider]: null,
                                    }));
                                  }
                                }}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  addCustomModel(provider);
                                }}
                                placeholder={providerSettings.placeholder}
                                spellCheck={false}
                              />
                              <span className="text-xs text-muted-foreground">
                                Example: <code>{providerSettings.example}</code>
                              </span>
                            </label>

                            <Button
                              className="sm:mt-6"
                              type="button"
                              onClick={() => addCustomModel(provider)}
                            >
                              Add model
                            </Button>
                          </div>

                          {customModelError ? (
                            <p className="text-xs text-destructive">{customModelError}</p>
                          ) : null}

                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <p>Saved custom models: {customModels.length}</p>
                              {customModels.length > 0 ? (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={() =>
                                    updateSettings(
                                      patchCustomModels(provider, [
                                        ...getDefaultCustomModelsForProvider(defaults, provider),
                                      ]),
                                    )
                                  }
                                >
                                  Reset custom models
                                </Button>
                              ) : null}
                            </div>

                            {customModels.length > 0 ? (
                              <div className="space-y-2">
                                {customModels.map((slug) => (
                                  <div
                                    key={`${provider}:${slug}`}
                                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                  >
                                    <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                      {slug}
                                    </code>
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => removeCustomModel(provider, slug)}
                                    >
                                      Remove
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                                No custom models saved yet.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  },
                )}

                {/* OpenCode: model picker from live server */}
                <OpenCodeModelPicker
                  customModels={settings.customOpenCodeModels}
                  serverUrl={settings.opencodeServerUrl}
                  binaryPath={settings.opencodeBinaryPath}
                  onAddModel={(slug) => {
                    const current = settings.customOpenCodeModels;
                    if (!current.includes(slug)) {
                      updateSettings({
                        customOpenCodeModels: [...current, slug],
                      });
                    }
                  }}
                  onRemoveModel={(slug) => {
                    updateSettings({
                      customOpenCodeModels: settings.customOpenCodeModels.filter((m) => m !== slug),
                    });
                  }}
                  onResetModels={() => {
                    updateSettings({
                      customOpenCodeModels: [...defaults.customOpenCodeModels],
                    });
                  }}
                />
              </div>
            </section>

            <section
              id="chat"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Chat defaults</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose which provider and model should be preselected when you open or create a
                  chat without an existing locked session.
                </p>
              </div>

              <div className="space-y-4">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default provider</span>
                  <select
                    value={settings.defaultProvider}
                    onChange={(event) =>
                      updateSettings({
                        defaultProvider: event.target.value as ProviderKind,
                      })
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {DEFAULT_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Default Codex model</span>
                    <select
                      value={settings.defaultCodexModel}
                      onChange={(event) =>
                        updateSettings({
                          defaultCodexModel: event.target.value,
                        })
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {defaultModelOptionsByProvider.codex.map((option) => (
                        <option key={`codex:${option.slug}`} value={option.slug}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">
                      Default OpenCode model
                    </span>
                    <select
                      value={settings.defaultOpenCodeModel}
                      disabled={defaultModelOptionsByProvider.opencode.length === 0}
                      onChange={(event) =>
                        updateSettings({
                          defaultOpenCodeModel: event.target.value,
                        })
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {defaultModelOptionsByProvider.opencode.length === 0 ? (
                        <option value="">No saved OpenCode models</option>
                      ) : null}
                      {defaultModelOptionsByProvider.opencode.map((option) => (
                        <option key={`opencode:${option.slug}`} value={option.slug}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        defaultProvider: defaults.defaultProvider,
                        defaultCodexModel: defaults.defaultCodexModel,
                        defaultOpenCodeModel: defaults.defaultOpenCodeModel,
                      })
                    }
                  >
                    Restore chat defaults
                  </Button>
                </div>
              </div>
            </section>

            <section
              id="sidebar"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Sidebar</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how many project groups can stay expanded at the same time.
                </p>
              </div>

              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="mb-3">
                    <p className="text-sm font-medium text-foreground">Max open projects</p>
                    <p className="text-xs text-muted-foreground">
                      Active chats like <code>Working</code>, <code>Awaiting Input</code>, and{" "}
                      <code>Done</code>
                      stay visible even when a project is collapsed.
                    </p>
                  </div>
                  <div
                    className="flex flex-wrap gap-2"
                    role="radiogroup"
                    aria-label="Maximum open projects"
                  >
                    {SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS.map((limit) => {
                      const selected = settings.sidebarOpenProjectLimit === limit;
                      return (
                        <button
                          key={limit}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                            selected
                              ? "border-primary/60 bg-primary/8 text-foreground"
                              : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                          onClick={() => updateSettings({ sidebarOpenProjectLimit: limit })}
                        >
                          {limit} open {limit === 1 ? "project" : "projects"}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {settings.sidebarOpenProjectLimit !== defaults.sidebarOpenProjectLimit ? (
                  <div className="flex justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        updateSettings({
                          sidebarOpenProjectLimit: defaults.sidebarOpenProjectLimit,
                        })
                      }
                    >
                      Restore sidebar default
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>

            <section
              id="responses"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Git</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Configure the model used for generating commit messages, PR titles, and branch
                  names.
                </p>
              </div>

              <div className="flex flex-col gap-4 rounded-lg border border-border bg-background px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Text generation model</p>
                  <p className="text-xs text-muted-foreground">
                    Model used for auto-generated git content.
                  </p>
                </div>
                <Select
                  value={settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL}
                  onValueChange={(value) => {
                    if (value) {
                      updateSettings({
                        textGenerationModel: value,
                      });
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-full shrink-0 sm:w-48"
                    aria-label="Git text generation model"
                  >
                    <SelectValue>{selectedGitTextGenerationModelLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {gitTextGenerationModelOptions.map((option) => (
                      <SelectItem key={option.slug} value={option.slug}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              {settings.textGenerationModel !== defaults.textGenerationModel ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        textGenerationModel: defaults.textGenerationModel,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Threads</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose the default workspace mode for newly created draft threads.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Default to New worktree</p>
                  <p className="text-xs text-muted-foreground">
                    New threads start in New worktree mode instead of Local.
                  </p>
                </div>
                <Switch
                  checked={settings.defaultThreadEnvMode === "worktree"}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      defaultThreadEnvMode: checked ? "worktree" : "local",
                    })
                  }
                  aria-label="Default new threads to New worktree mode"
                />
              </div>

              {settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Use OpenCode chat colors</p>
                  <p className="text-xs text-muted-foreground">
                    Tint assistant markdown like OpenCode, including headings, links, inline code,
                    emphasis, and quotes.
                  </p>
                </div>
                <Switch
                  checked={settings.enableOpencodeChatColors}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableOpencodeChatColors: Boolean(checked),
                    })
                  }
                  aria-label="Use OpenCode chat colors"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ||
              settings.enableOpencodeChatColors !== defaults.enableOpencodeChatColors ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                        enableOpencodeChatColors: defaults.enableOpencodeChatColors,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section
              id="keybindings"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section
              id="safety"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>
            <section
              id="about"
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">About</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Application version and environment information.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Version</p>
                  <p className="text-xs text-muted-foreground">
                    Current version of the application.
                  </p>
                </div>
                <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
              </div>
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
