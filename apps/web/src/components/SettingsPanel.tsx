/**
 * SettingsPanel - Two-column settings layout (left nav + right content).
 *
 * Self-contained: manages all settings state internally.
 * No dialog wrapper, no page wrapper — callers provide the outer container.
 *
 * Used by:
 *   SettingsModal  — wraps in a Dialog popup
 *   _chat.settings — wraps in a SidebarInset page (direct URL fallback)
 *
 * @module SettingsPanel
 */
import { useCallback, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  CpuIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  PanelLeftIcon,
  ServerIcon,
  ShieldIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { type ProviderKind, DEFAULT_GIT_TEXT_GENERATION_MODEL } from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

import {
  MAX_CUSTOM_MODEL_LENGTH,
  SIDEBAR_OPEN_PROJECT_LIMIT_OPTIONS,
  getAppModelOptions,
  useAppSettings,
} from "../appSettings";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { APP_VERSION } from "../branding";
import { serverApiUrl } from "~/lib/serverOrigin";
import { RemoteHostSettingsForm } from "./RemoteHostSettingsForm";
import { cn } from "~/lib/utils";

// ── Nav sections ──────────────────────────────────────────────────────

export const SETTINGS_NAV = [
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme and display preferences.",
    icon: PaletteIcon,
  },
  {
    id: "providers",
    label: "Providers",
    description: "Codex and OpenCode server configuration.",
    icon: CpuIcon,
  },
  {
    id: "models",
    label: "Models",
    description: "Default provider, model defaults, and custom model slugs.",
    icon: SparklesIcon,
  },
  {
    id: "sidebar-settings",
    label: "Sidebar",
    description: "Control how many project groups stay expanded.",
    icon: PanelLeftIcon,
  },
  {
    id: "responses",
    label: "Responses",
    description: "Streaming, thread defaults, and Git generation.",
    icon: ZapIcon,
  },
  {
    id: "keybindings",
    label: "Keybindings",
    description: "Edit the keybindings configuration file.",
    icon: KeyboardIcon,
  },
  {
    id: "safety",
    label: "Safety",
    description: "Guardrails for destructive actions.",
    icon: ShieldIcon,
  },
  {
    id: "remote-host",
    label: "Remote Host",
    description: "Connect to a remote T3 server via SSH tunnel.",
    icon: ServerIcon,
  },
  {
    id: "about",
    label: "About",
    description: "Application version and environment.",
    icon: InfoIcon,
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_NAV)[number]["id"];

// ── Constants ─────────────────────────────────────────────────────────

const THEME_OPTIONS = [
  { value: "system", label: "System", description: "Match your OS appearance setting." },
  { value: "light", label: "Light", description: "Always use the light theme." },
  { value: "dark", label: "Dark", description: "Always use the dark theme." },
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

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

// ── OpenCode catalog types ────────────────────────────────────────────

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

function buildOpenCodePath(
  pathname: string,
  opts?: { serverUrl?: string; binaryPath?: string },
): string {
  const params = new URLSearchParams();
  if (opts?.serverUrl) params.set("serverUrl", opts.serverUrl);
  if (opts?.binaryPath) params.set("binaryPath", opts.binaryPath);
  const base = serverApiUrl(pathname);
  return params.size === 0 ? base : `${base}?${params.toString()}`;
}

async function fetchOpenCodeProviders(opts?: {
  serverUrl?: string;
  binaryPath?: string;
}): Promise<OpenCodeProviderListResponse> {
  const resp = await fetch(buildOpenCodePath("/api/opencode/providers", opts), {
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) throw new Error(`Failed to fetch OpenCode providers (${resp.status})`);
  return (await resp.json()) as OpenCodeProviderListResponse;
}

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  return provider === "opencode" ? settings.customOpenCodeModels : settings.customCodexModels;
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  return provider === "opencode" ? defaults.customOpenCodeModels : defaults.customCodexModels;
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  return provider === "opencode" ? { customOpenCodeModels: models } : { customCodexModels: models };
}

// ── OpenCode Server Status Panel ──────────────────────────────────────

interface OpenCodeServerStatusResponse {
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly url?: string;
  readonly managedByT3?: boolean;
  readonly message?: string;
}

async function fetchOpenCodeServerStatus(opts?: {
  serverUrl?: string;
}): Promise<OpenCodeServerStatusResponse> {
  const resp = await fetch(buildOpenCodePath("/api/opencode/server", opts), {
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
    refetchInterval: (q) => (q.state.data?.state === "starting" ? 1_000 : false),
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

// ── OpenCode Model Picker ─────────────────────────────────────────────

function OpenCodeModelPicker(props: {
  customModels: readonly string[];
  serverUrl?: string;
  binaryPath?: string;
  onAddModel: (slug: string) => void;
  onRemoveModel: (slug: string) => void;
  onResetModels: () => void;
  modelsExpanded: boolean;
  onToggleExpanded: () => void;
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
        idx.set(`${provider.id}/${model.id}`, {
          providerName: provider.name,
          isConnected: isConn,
          model,
        });
      }
    }

    const q = search.trim().toLowerCase();
    const results = q
      ? all
          .filter((p) => Object.keys(p.models).length > 0)
          .map((provider) => ({
            provider,
            isConnected: connectedSet.has(provider.id),
            models: Object.values(provider.models)
              .filter(
                (m) =>
                  m.status !== "deprecated" &&
                  (m.id.toLowerCase().includes(q) ||
                    m.name.toLowerCase().includes(q) ||
                    provider.name.toLowerCase().includes(q)),
              )
              .toSorted((a, b) => a.name.localeCompare(b.name)),
          }))
          .filter((g) => g.models.length > 0)
          .toSorted((a, b) => {
            if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
            return a.provider.name.localeCompare(b.provider.name);
          })
      : [];

    return { modelIndex: idx, searchResults: results };
  }, [providersQuery.data, search]);

  const isLoading = providersQuery.isLoading;
  const isError = providersQuery.isError;
  const hasData = providersQuery.data != null;
  const isSearching = search.trim().length > 0;

  return (
    <div
      id="opencode-model-picker"
      className="rounded-xl border border-border bg-background/50 p-4"
    >
      <div className="mb-4">
        <h3 className="text-sm font-medium text-foreground">OpenCode</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Search to browse all models from your OpenCode server. Selected models appear below.
        </p>
      </div>
      <div className="space-y-4">
        {hasData && !isLoading ? (
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models to add..."
            spellCheck={false}
          />
        ) : null}
        {isLoading ? (
          <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
            Fetching models from OpenCode server...
          </div>
        ) : null}
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
                      const qid = `${provider.id}/${model.id}`;
                      const isAdded = props.customModels.includes(qid);
                      return (
                        <button
                          key={qid}
                          type="button"
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                            isAdded
                              ? "border-primary/40 bg-primary/5"
                              : "border-border hover:bg-accent"
                          }`}
                          onClick={() =>
                            isAdded ? props.onRemoveModel(qid) : props.onAddModel(qid)
                          }
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-foreground">
                              {model.name}
                            </div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">
                              {model.id}
                            </div>
                          </div>
                          {isAdded ? (
                            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-primary">
                              Added
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}
        {hasData && !isLoading ? (
          <div className="space-y-1">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={props.onToggleExpanded}
            >
              <span>Selected models ({props.customModels.length})</span>
              <div className="flex items-center gap-2">
                {props.customModels.length > 0 && props.modelsExpanded ? (
                  <span
                    className="text-[10px] text-muted-foreground/60 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onResetModels();
                    }}
                  >
                    Clear all
                  </span>
                ) : null}
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 transition-transform duration-150",
                    props.modelsExpanded ? "rotate-180" : "rotate-0",
                  )}
                />
              </div>
            </button>
            {props.modelsExpanded ? (
              props.customModels.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-xs text-muted-foreground">
                  No models selected. Use the search above to find and add models.
                </div>
              ) : (
                <div className="grid gap-1.5 pt-1">
                  {props.customModels.map((qid) => {
                    const entry = modelIndex.get(qid);
                    return (
                      <div
                        key={qid}
                        className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-foreground">
                            {entry ? entry.model.name : qid}
                          </div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground">
                            {entry ? `${entry.providerName} / ${entry.model.id}` : qid}
                          </div>
                        </div>
                        <Button size="xs" variant="ghost" onClick={() => props.onRemoveModel(qid)}>
                          Remove
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── SettingsPanel ─────────────────────────────────────────────────────

interface SettingsPanelProps {
  defaultSection?: SettingsSectionId | undefined;
}

export function SettingsPanel({ defaultSection = "appearance" }: SettingsPanelProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());

  const [activeSection, setActiveSection] = useState<SettingsSectionId>(defaultSection);

  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Partial<Record<ProviderKind, string>>
  >({ codex: "" });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  // Collapsible state for saved custom model lists
  const [codexModelsExpanded, setCodexModelsExpanded] = useState(false);
  const [opencodeModelsExpanded, setOpencodeModelsExpanded] = useState(false);

  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors;

  const defaultModelOptionsByProvider = useMemo(
    () => ({
      codex: getAppModelOptions("codex", settings.customCodexModels, settings.defaultCodexModel),
      opencode: settings.customOpenCodeModels.map((slug) => ({ slug, name: slug, isCustom: true })),
    }),
    [settings.customCodexModels, settings.customOpenCodeModels, settings.defaultCodexModel],
  );

  // Git text-generation model options — from the active provider's pool.
  const gitTextGenerationModelOptions = useMemo(() => {
    if (settings.defaultProvider === "opencode") {
      return settings.customOpenCodeModels.map((slug) => ({ slug, name: slug, isCustom: true }));
    }
    return getAppModelOptions("codex", settings.customCodexModels, settings.textGenerationModel);
  }, [
    settings.defaultProvider,
    settings.customCodexModels,
    settings.customOpenCodeModels,
    settings.textGenerationModel,
  ]);

  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find(
      (o) => o.slug === (settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL),
    )?.name ??
    settings.textGenerationModel ??
    gitTextGenerationModelOptions[0]?.name ??
    "Select model";

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
      .catch((err) => {
        setOpenKeybindingsError(
          err instanceof Error ? err.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => setIsOpeningKeybindings(false));
  }, [availableEditors, keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const input = customModelInputByProvider[provider];
      const existing = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(input, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((p) => ({ ...p, [provider]: "Enter a model slug." }));
        return;
      }
      if (provider === "codex" && getModelOptions(provider).some((o) => o.slug === normalized)) {
        setCustomModelErrorByProvider((p) => ({
          ...p,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((p) => ({
          ...p,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (existing.includes(normalized)) {
        setCustomModelErrorByProvider((p) => ({
          ...p,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }
      updateSettings(patchCustomModels(provider, [...existing, normalized]));
      setCustomModelInputByProvider((p) => ({ ...p, [provider]: "" }));
      setCustomModelErrorByProvider((p) => ({ ...p, [provider]: null }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const existing = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          existing.filter((m) => m !== slug),
        ),
      );
      setCustomModelErrorByProvider((p) => ({ ...p, [provider]: null }));
    },
    [settings, updateSettings],
  );

  const activeMeta = SETTINGS_NAV.find((s) => s.id === activeSection)!;

  // ── Section renderer ────────────────────────────────────────────────

  function renderContent() {
    switch (activeSection) {
      case "appearance":
        return (
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
                  System default follows your browser or OS time format. <code>12-hour</code> and{" "}
                  <code>24-hour</code> force the hour cycle.
                </p>
              </div>
              <Select
                value={settings.timestampFormat}
                onValueChange={(value) => {
                  if (value !== "locale" && value !== "12-hour" && value !== "24-hour") return;
                  updateSettings({ timestampFormat: value });
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
                  onClick={() => updateSettings({ timestampFormat: defaults.timestampFormat })}
                >
                  Restore default
                </Button>
              </div>
            ) : null}
          </div>
        );

      case "providers":
        return (
          <div className="space-y-6">
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Codex App Server
              </h3>
              <p className="text-xs text-muted-foreground">
                These overrides apply to new sessions and let you use a non-default Codex install.
              </p>
              <label htmlFor="codex-binary-path" className="block space-y-1">
                <span className="text-xs font-medium text-foreground">Codex binary path</span>
                <Input
                  id="codex-binary-path"
                  value={settings.codexBinaryPath}
                  onChange={(e) => updateSettings({ codexBinaryPath: e.target.value })}
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
                  value={settings.codexHomePath}
                  onChange={(e) => updateSettings({ codexHomePath: e.target.value })}
                  placeholder="/Users/you/.codex"
                  spellCheck={false}
                />
                <span className="text-xs text-muted-foreground">
                  Optional custom Codex home/config directory.
                </span>
              </label>
              <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                <div className="min-w-0 flex-1">
                  <p>Binary source</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                    {settings.codexBinaryPath || "PATH"}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
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

            <div className="border-t border-border" />

            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                OpenCode Server
              </h3>
              <p className="text-xs text-muted-foreground">
                These overrides apply to new OpenCode sessions and let you connect to a custom
                OpenCode server instance.
              </p>
              <label htmlFor="opencode-server-url" className="block space-y-1">
                <span className="text-xs font-medium text-foreground">Server URL</span>
                <Input
                  id="opencode-server-url"
                  value={settings.opencodeServerUrl}
                  onChange={(e) => updateSettings({ opencodeServerUrl: e.target.value })}
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
                  value={settings.opencodeBinaryPath}
                  onChange={(e) => updateSettings({ opencodeBinaryPath: e.target.value })}
                  placeholder="opencode"
                  spellCheck={false}
                />
                <span className="text-xs text-muted-foreground">
                  Leave blank to use <code>opencode</code> from your PATH.
                </span>
              </label>
              <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                <div className="min-w-0 flex-1">
                  <p>Server URL</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                    {settings.opencodeServerUrl || "auto"}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
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
              <OpenCodeServerStatusPanel />
            </div>
          </div>
        );

      case "models": {
        const isCodex = settings.defaultProvider === "codex";
        const activeDefaultValue = isCodex
          ? settings.defaultCodexModel
          : settings.defaultOpenCodeModel;
        const activeDefaultOptions = isCodex
          ? defaultModelOptionsByProvider.codex
          : defaultModelOptionsByProvider.opencode;

        return (
          <div className="space-y-6">
            {/* ── Defaults (formerly "Chat") ─────────────────────── */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Defaults
              </h3>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default provider</span>
                  <select
                    value={settings.defaultProvider}
                    onChange={(e) =>
                      updateSettings({ defaultProvider: e.target.value as ProviderKind })
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {DEFAULT_PROVIDER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default model</span>
                  <select
                    value={activeDefaultValue}
                    disabled={activeDefaultOptions.length === 0}
                    onChange={(e) =>
                      updateSettings(
                        isCodex
                          ? { defaultCodexModel: e.target.value }
                          : { defaultOpenCodeModel: e.target.value },
                      )
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    {activeDefaultOptions.length === 0 ? (
                      <option value="">No saved models — add some below</option>
                    ) : null}
                    {activeDefaultOptions.map((o) => (
                      <option key={o.slug} value={o.slug}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {settings.defaultProvider !== defaults.defaultProvider ||
              settings.defaultCodexModel !== defaults.defaultCodexModel ||
              settings.defaultOpenCodeModel !== defaults.defaultOpenCodeModel ? (
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
                    Restore defaults
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="border-t border-border" />

            {/* ── Custom Codex slugs ─────────────────────────────── */}
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
                            onChange={(e) => {
                              setCustomModelInputByProvider((p) => ({
                                ...p,
                                [provider]: e.target.value,
                              }));
                              if (customModelError) {
                                setCustomModelErrorByProvider((p) => ({
                                  ...p,
                                  [provider]: null,
                                }));
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
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

                      {/* Collapsible saved models list */}
                      <div className="space-y-1">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setCodexModelsExpanded((v) => !v)}
                        >
                          <span>Saved custom models ({customModels.length})</span>
                          <div className="flex items-center gap-2">
                            {customModels.length > 0 && codexModelsExpanded ? (
                              <span
                                className="text-[10px] text-muted-foreground/60 hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateSettings(
                                    patchCustomModels(provider, [
                                      ...getDefaultCustomModelsForProvider(defaults, provider),
                                    ]),
                                  );
                                }}
                              >
                                Reset
                              </span>
                            ) : null}
                            <ChevronDownIcon
                              className={cn(
                                "size-3.5 transition-transform duration-150",
                                codexModelsExpanded ? "rotate-180" : "rotate-0",
                              )}
                            />
                          </div>
                        </button>
                        {codexModelsExpanded ? (
                          customModels.length > 0 ? (
                            <div className="space-y-1.5 pt-1">
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
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              },
            )}

            {/* ── OpenCode model picker ──────────────────────────── */}
            <OpenCodeModelPicker
              customModels={settings.customOpenCodeModels}
              serverUrl={settings.opencodeServerUrl}
              binaryPath={settings.opencodeBinaryPath}
              onAddModel={(slug) => {
                const current = settings.customOpenCodeModels;
                if (!current.includes(slug))
                  updateSettings({ customOpenCodeModels: [...current, slug] });
              }}
              onRemoveModel={(slug) =>
                updateSettings({
                  customOpenCodeModels: settings.customOpenCodeModels.filter((m) => m !== slug),
                })
              }
              onResetModels={() =>
                updateSettings({ customOpenCodeModels: [...defaults.customOpenCodeModels] })
              }
              modelsExpanded={opencodeModelsExpanded}
              onToggleExpanded={() => setOpencodeModelsExpanded((v) => !v)}
            />
          </div>
        );
      }

      case "sidebar-settings":
        return (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="mb-3">
                <p className="text-sm font-medium text-foreground">Max open projects</p>
                <p className="text-xs text-muted-foreground">
                  Active chats like <code>Working</code>, <code>Awaiting Input</code>, and{" "}
                  <code>Done</code> stay visible even when a project is collapsed.
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
                    updateSettings({ sidebarOpenProjectLimit: defaults.sidebarOpenProjectLimit })
                  }
                >
                  Restore sidebar default
                </Button>
              </div>
            ) : null}
          </div>
        );

      case "responses":
        return (
          <div className="space-y-6">
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Git
              </h3>
              <div className="flex flex-col gap-4 rounded-lg border border-border bg-background px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Text generation model</p>
                  <p className="text-xs text-muted-foreground">
                    Model used for commit messages, PR titles, and branch names.
                  </p>
                </div>
                <Select
                  value={
                    gitTextGenerationModelOptions.find(
                      (o) =>
                        o.slug ===
                        (settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL),
                    )?.slug ??
                    gitTextGenerationModelOptions[0]?.slug ??
                    ""
                  }
                  onValueChange={(value) => {
                    if (value) updateSettings({ textGenerationModel: value });
                  }}
                >
                  <SelectTrigger
                    className="w-full shrink-0 sm:w-48"
                    aria-label="Git text generation model"
                    disabled={gitTextGenerationModelOptions.length === 0}
                  >
                    <SelectValue>
                      {gitTextGenerationModelOptions.length === 0
                        ? "No models saved"
                        : selectedGitTextGenerationModelLabel}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {gitTextGenerationModelOptions.map((o) => (
                      <SelectItem key={o.slug} value={o.slug}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {gitTextGenerationModelOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No models saved for the active provider.{" "}
                  <button
                    type="button"
                    className="font-medium text-primary underline-offset-2 hover:underline"
                    onClick={() => {
                      setActiveSection("models");
                      // After the section re-renders, scroll the OpenCode picker into view.
                      setTimeout(() => {
                        document
                          .getElementById("opencode-model-picker")
                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }, 80);
                    }}
                  >
                    Add models in Models
                  </button>
                </p>
              ) : null}
              {settings.textGenerationModel !== defaults.textGenerationModel ? (
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({ textGenerationModel: defaults.textGenerationModel })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="border-t border-border" />

            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Threads
              </h3>
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
                    updateSettings({ defaultThreadEnvMode: checked ? "worktree" : "local" })
                  }
                  aria-label="Default new threads to New worktree mode"
                />
              </div>
              {settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({ defaultThreadEnvMode: defaults.defaultThreadEnvMode })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="border-t border-border" />

            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Assistant
              </h3>
              <div className="space-y-2">
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
                      updateSettings({ enableAssistantStreaming: Boolean(checked) })
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
                      updateSettings({ enableOpencodeChatColors: Boolean(checked) })
                    }
                    aria-label="Use OpenCode chat colors"
                  />
                </div>
              </div>
              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ||
              settings.enableOpencodeChatColors !== defaults.enableOpencodeChatColors ? (
                <div className="flex justify-end">
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
                    Restore defaults
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="border-t border-border" />

            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Fork behavior
              </h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Jump to forked thread</p>
                    <p className="text-xs text-muted-foreground">
                      Automatically navigate to the new chat after forking a message.
                    </p>
                  </div>
                  <Switch
                    checked={settings.navigateToForkedThread}
                    onCheckedChange={(checked) =>
                      updateSettings({ navigateToForkedThread: Boolean(checked) })
                    }
                    aria-label="Jump to forked thread"
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Pre-fill fork prompt</p>
                    <p className="text-xs text-muted-foreground">
                      Fill the fork input with the original message text so you can edit it.
                    </p>
                  </div>
                  <Switch
                    checked={settings.forkPreFillContent}
                    onCheckedChange={(checked) =>
                      updateSettings({ forkPreFillContent: Boolean(checked) })
                    }
                    aria-label="Pre-fill fork prompt"
                  />
                </div>
              </div>
              {settings.navigateToForkedThread !== defaults.navigateToForkedThread ||
              settings.forkPreFillContent !== defaults.forkPreFillContent ? (
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        navigateToForkedThread: defaults.navigateToForkedThread,
                        forkPreFillContent: defaults.forkPreFillContent,
                      })
                    }
                  >
                    Restore defaults
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        );

      case "keybindings":
        return (
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
        );

      case "safety":
        return (
          <div className="space-y-4">
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
                  updateSettings({ confirmThreadDelete: Boolean(checked) })
                }
                aria-label="Confirm thread deletion"
              />
            </div>
            {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
              <div className="flex justify-end">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    updateSettings({ confirmThreadDelete: defaults.confirmThreadDelete })
                  }
                >
                  Restore default
                </Button>
              </div>
            ) : null}
          </div>
        );

      case "remote-host":
        return <RemoteHostSettingsForm />;

      case "about":
        return (
          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Version</p>
              <p className="text-xs text-muted-foreground">Current version of the application.</p>
            </div>
            <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
          </div>
        );
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0">
      {/* Left nav */}
      <nav
        className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2"
        aria-label="Settings navigation"
      >
        {SETTINGS_NAV.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                isActive
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              onClick={() => setActiveSection(section.id)}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{section.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Right content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl p-8">
          <div className="mb-6">
            <h2 className="text-base font-semibold text-foreground">{activeMeta.label}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{activeMeta.description}</p>
          </div>
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
