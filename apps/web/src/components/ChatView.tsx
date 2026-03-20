import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  type EditorId,
  type KeybindingCommand,
  type CodexReasoningEffort,
  type MessageId,
  type ProjectId,
  type ProjectEntry,
  type ProjectScript,
  type ModelSlug,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ResolvedKeybindingsConfig,
  type ProviderApprovalDecision,
  type ServerProviderStatus,
  type ProviderKind,
  type ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import {
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  normalizeModelSlug,
  resolveModelSlugForProvider,
} from "@t3tools/shared/model";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { gitBranchesQueryOptions, gitCreateWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { isElectron } from "../env";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "../composer-logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  isLatestTurnSettled,
} from "../session-logic";
import { isScrollContainerNearBottom } from "../chat-scroll";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  selectPendingUserInputOption,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useStore } from "../store";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import { truncateTitle } from "../truncateTitle";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type ThreadProviderMetadata,
  type TurnDiffSummary,
} from "../types";
import { basenameOfPath } from "../vscode-icons";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import BranchToolbar from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import {
  ArrowDownIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  XIcon,
} from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
import { cn, randomUUID } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "~/projectScripts";
import { SidebarTrigger } from "./ui/sidebar";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { resolveAppModelSelection, useAppSettings } from "../appSettings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverApiUrl } from "~/lib/serverOrigin";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { shouldUseCompactComposerFooter } from "./composerFooterLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { ChatViewMessagesSkeleton } from "./ChatViewSkeleton";
import { ComposerQueueDock, type QueuedMessage } from "./chat/ComposerQueueDock";
import { ChatHeader, type RightPanelMode } from "./chat/ChatHeader";
import { DevLogsPanel } from "./chat/DevLogsPanel";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { AVAILABLE_PROVIDER_OPTIONS, ProviderModelPicker } from "./chat/ProviderModelPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import { CodexTraitsPicker } from "./chat/CodexTraitsPicker";
import { CompactComposerControlsMenu } from "./chat/CompactComposerControlsMenu";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./chat/ComposerPlanFollowUpBanner";
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import {
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildTemporaryWorktreeBranchName,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  deriveComposerSendState,
  getCustomModelOptionsByProvider,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  PullRequestDialogState,
  readFileAsDataUrl,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  SendPhase,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { type ActiveProjectMessage, PopoutBroadcaster } from "../lib/devLogsPopoutChannel";

interface OpenCodeComposerProviderModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly limit?: {
    readonly context: number;
  };
  readonly variants?: Record<string, Record<string, unknown>>;
}

interface OpenCodeComposerProvider {
  readonly id: string;
  readonly name: string;
  readonly models: Record<string, OpenCodeComposerProviderModel>;
}

interface OpenCodeComposerProviderListResponse {
  readonly all: readonly OpenCodeComposerProvider[];
  readonly default: Record<string, string>;
  readonly connected: readonly string[];
}

interface OpenCodeComposerAgent {
  readonly name: string;
  readonly description?: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden?: boolean;
  readonly variant?: string;
  readonly model?: {
    readonly providerID: string;
    readonly modelID: string;
  };
}

function buildOpenCodeProxyPath(
  pathname: string,
  options?: {
    cwd?: string | null;
    serverUrl?: string | null;
    binaryPath?: string | null;
  },
): string {
  const params = new URLSearchParams();
  if (options?.cwd) {
    params.set("cwd", options.cwd);
  }
  if (options?.serverUrl) {
    params.set("serverUrl", options.serverUrl);
  }
  if (options?.binaryPath) {
    params.set("binaryPath", options.binaryPath);
  }
  // Always use an absolute URL so the request reaches the T3 backend
  // directly — required in Electron where the backend runs on a dynamic port.
  const base = serverApiUrl(pathname);
  if (params.size === 0) {
    return base;
  }
  return `${base}?${params.toString()}`;
}

async function fetchOpenCodeComposerProviders(options?: {
  cwd?: string | null;
  serverUrl?: string | null;
  binaryPath?: string | null;
}): Promise<OpenCodeComposerProviderListResponse> {
  const resp = await fetch(buildOpenCodeProxyPath("/api/opencode/providers", options), {
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(detail || `Failed to fetch OpenCode providers (${resp.status})`);
  }
  return (await resp.json()) as OpenCodeComposerProviderListResponse;
}

async function fetchOpenCodeComposerAgents(options?: {
  cwd?: string | null;
  serverUrl?: string | null;
  binaryPath?: string | null;
}): Promise<OpenCodeComposerAgent[]> {
  const resp = await fetch(buildOpenCodeProxyPath("/api/opencode/agents", options), {
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(detail || `Failed to fetch OpenCode agents (${resp.status})`);
  }
  return (await resp.json()) as OpenCodeComposerAgent[];
}

function formatOpenCodeAgentLabel(name: string): string {
  return name
    .split(/[-_]/g)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatUsdCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.1 ? 3 : 2,
    maximumFractionDigits: value < 0.1 ? 3 : 2,
  }).format(value);
}

function OpenCodeThreadStatusStrip(props: {
  metadata: ThreadProviderMetadata;
  providers: OpenCodeComposerProviderListResponse | undefined;
}) {
  const usage = props.metadata.latestUsage;
  const provider =
    props.metadata.providerId !== undefined
      ? props.providers?.all.find((entry) => entry.id === props.metadata.providerId)
      : undefined;
  const model =
    provider && props.metadata.modelId !== undefined
      ? provider.models[props.metadata.modelId]
      : undefined;
  const contextLimit = model?.limit?.context;
  const usagePercent =
    usage && contextLimit ? Math.round((usage.total / contextLimit) * 100) : null;
  const todos = props.metadata.todos ?? [];

  return (
    <div className="border-b border-border/65 bg-muted/15 px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {usage ? (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {usage.total.toLocaleString()} tokens
            {usagePercent !== null ? ` • ${usagePercent}% context` : ""}
          </Badge>
        ) : null}
        {typeof props.metadata.totalCostUsd === "number" ? (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            Cost: {formatUsdCompact(props.metadata.totalCostUsd)}
          </Badge>
        ) : null}
        {todos.length > 0 ? (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {todos.filter((todo) => todo.status === "completed").length}/{todos.length} todos
          </Badge>
        ) : null}
      </div>
      {todos.length > 0 ? (
        <div className="mt-2 grid gap-1">
          {todos.slice(0, 4).map((todo) => (
            <div
              key={`${todo.content}:${todo.status}:${todo.priority}`}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              {todo.status === "completed" ? (
                <CheckIcon className="size-3 text-emerald-500" />
              ) : todo.status === "cancelled" ? (
                <XIcon className="size-3 text-muted-foreground/60" />
              ) : (
                <span
                  className={cn(
                    "inline-block size-2 rounded-full",
                    todo.status === "in_progress" ? "bg-blue-500" : "bg-muted-foreground/40",
                  )}
                />
              )}
              <span
                className={cn(
                  "truncate",
                  todo.status === "completed" ? "text-muted-foreground/70 line-through" : "",
                )}
              >
                {todo.content}
              </span>
            </div>
          ))}
          {todos.length > 4 ? (
            <span className="pl-5 text-[11px] text-muted-foreground/75">
              +{todos.length - 4} more
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

interface ChatViewProps {
  threadId: ThreadId;
}

export default function ChatView({ threadId }: ChatViewProps) {
  // Narrow to just the active thread so domain-events for other threads
  // don't trigger a ChatView re-render.
  const serverThread = useStore((store) => store.threads.find((t) => t.id === threadId) ?? null);
  const projects = useStore((store) => store.projects);
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const hydrateStoreThreadMessages = useStore((store) => store.hydrateThreadMessages);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadBranch = useStore((store) => store.setThreadBranch);
  const devServerByProjectId = useStore((store) => store.devServerByProjectId);
  const devServerLogsByProjectId = useStore((store) => store.devServerLogsByProjectId);
  const { settings } = useAppSettings();
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
      }),
    [composerImages.length, composerTerminalContexts, prompt],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftProvider = useComposerDraftStore((store) => store.setProvider);
  const setComposerDraftModel = useComposerDraftStore((store) => store.setModel);
  const setComposerDraftOpenCodeAgent = useComposerDraftStore((store) => store.setOpenCodeAgent);
  const setComposerDraftOpenCodeVariant = useComposerDraftStore(
    (store) => store.setOpenCodeVariant,
  );
  const setComposerDraftOpenCodeAllowQuestions = useComposerDraftStore(
    (store) => store.setOpenCodeAllowQuestions,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const setComposerDraftEffort = useComposerDraftStore((store) => store.setEffort);
  const setComposerDraftCodexFastMode = useComposerDraftStore((store) => store.setCodexFastMode);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const promptRef = useRef(prompt);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  // Messages queued while the LLM is actively running a turn.
  // Auto-drained FIFO once the turn completes.
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  // Set to true when the user explicitly interrupts a running turn.
  // The auto-send effect checks this: instead of sending, it restores queue
  // content back to the composer so the user has to manually confirm.
  const wasInterruptedRef = useRef(false);

  // Latched "ever hydrated" flag — starts false, latched to true the first
  // time messagesHydrated is seen as true for this thread. Stays true for the
  // lifetime of this ChatView mount (reset on thread switch via key={threadId}).
  // Prevents the messages skeleton from flashing back during snapshot syncs
  // that temporarily reset messagesHydrated=false while a turn is in progress.
  const messagesEverHydratedRef = useRef(false);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  const [sendStartedAt, setSendStartedAt] = useState<string | null>(null);
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [devLogsOpen, setDevLogsOpen] = useState(false);
  const [devLogsPanelWidth, setDevLogsPanelWidth] = useState(() =>
    parseInt(localStorage.getItem("t3code:dev-logs-width") ?? "384", 10),
  );
  const devLogsPanelWidthRef = useRef(devLogsPanelWidth);
  const popoutWindowRef = useRef<Window | null>(null);
  const popoutChannelRef = useRef<PopoutBroadcaster | null>(null);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [scrollPillMounted, setScrollPillMounted] = useState(false);
  const suppressScrollPillRef = useRef(false);
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
    setMessagesScrollElement(element);
  }, []);

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [composerTerminalContexts, removeComposerDraftTerminalContext, setPrompt, threadId],
  );

  const fallbackDraftProject = projects.find((project) => project.id === draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.model ?? DEFAULT_MODEL_BY_PROVIDER.codex,
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.model, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;

  // Latch: once messagesHydrated is true for this thread, keep it true for
  // the lifetime of this ChatView mount so snapshot syncs can't flash the skeleton.
  if (activeThread?.messagesHydrated) {
    messagesEverHydratedRef.current = true;
  }

  const activeOpenCodeThreadMetadata =
    activeThread &&
    (activeThread.provider === "opencode" || activeThread.session?.provider === "opencode")
      ? (activeThread.providerMetadata ?? null)
      : null;
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.diff === "1";
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProject = projects.find((p) => p.id === activeThread?.projectId);

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
      setComposerHighlightedItemId(null);
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
      if (storedDraftThread) {
        setDraftThreadContext(storedDraftThread.threadId, input);
        setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, input);
        if (storedDraftThread.threadId !== threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return;
      }

      const activeDraftThread = getDraftThread(threadId);
      if (!isServerThread && activeDraftThread?.projectId === activeProject.id) {
        setDraftThreadContext(threadId, input);
        setProjectDraftThreadId(activeProject.id, threadId, input);
        return;
      }

      clearProjectDraftThreadId(activeProject.id);
      const nextThreadId = newThreadId();
      setProjectDraftThreadId(activeProject.id, nextThreadId, {
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!activeThread?.id) return;
    markThreadVisited(activeThread.id);
  }, [activeThread?.id, markThreadVisited]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThread.lastVisitedAt ? Date.parse(activeThread.lastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(activeThread.id);
  }, [
    activeThread?.id,
    activeThread?.lastVisitedAt,
    activeLatestTurn?.completedAt,
    latestTurnSettled,
    markThreadVisited,
  ]);

  // ── On-demand OpenCode mirror refresh ──────────────────────────────
  // Discovered OpenCode threads render the local server-side mirror first.
  // Opening a thread only queues a stale-while-revalidate refresh.
  const loadingThreadMessagesIdRef = useRef<string | null>(null);
  const loadingExternalMessagesIdRef = useRef<string | null>(null);
  const activeOpenCodeThreadId =
    activeThread?.provider === "opencode" && activeThread?.source === "discovered"
      ? activeThread.id
      : null;

  useEffect(() => {
    const api = readNativeApi();
    if (!api || !activeThreadId) return;
    if (activeThread?.messagesHydrated) return;
    if (loadingThreadMessagesIdRef.current === activeThreadId) return;

    let cancelled = false;
    const targetThreadId = activeThreadId;
    loadingThreadMessagesIdRef.current = targetThreadId;

    api.orchestration
      .getThreadMessages({ threadId: targetThreadId })
      .then((result) => {
        if (cancelled) return;
        hydrateStoreThreadMessages(result);
      })
      .catch((err) => {
        console.error("[ChatView] getThreadMessages failed", err);
      })
      .finally(() => {
        if (loadingThreadMessagesIdRef.current === targetThreadId) {
          loadingThreadMessagesIdRef.current = null;
        }
      });

    return () => {
      cancelled = true;
      // Clear the dedup guard immediately on cleanup. Without this, React
      // StrictMode's intentional double-invocation (mount→cleanup→remount)
      // causes the second effect run to hit the dedup guard and bail out,
      // permanently preventing message loading until deps change again.
      if (loadingThreadMessagesIdRef.current === targetThreadId) {
        loadingThreadMessagesIdRef.current = null;
      }
    };
  }, [activeThread?.messagesHydrated, activeThreadId, hydrateStoreThreadMessages]);

  useEffect(() => {
    if (!activeOpenCodeThreadId) return;
    if (loadingExternalMessagesIdRef.current === activeOpenCodeThreadId) return;

    const targetThreadId = activeOpenCodeThreadId;
    loadingExternalMessagesIdRef.current = targetThreadId;
    fetch(
      serverApiUrl(`/api/opencode/threads/${encodeURIComponent(targetThreadId)}/load-messages`),
      {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      },
    )
      .then((resp) => {
        if (!resp.ok) {
          console.warn("Failed to load OpenCode messages:", resp.status);
        }
      })
      .catch((err) => {
        console.warn("Failed to load OpenCode messages:", err);
      })
      .finally(() => {
        if (loadingExternalMessagesIdRef.current === targetThreadId) {
          loadingExternalMessagesIdRef.current = null;
        }
      });
  }, [activeOpenCodeThreadId]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.provider;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messageCount > 0 ||
      activeThread.session !== null),
  );
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const selectedProvider: ProviderKind =
    lockedProvider ?? selectedProviderByThreadId ?? settings.defaultProvider;
  const effectiveInteractionMode: ProviderInteractionMode =
    selectedProvider === "opencode" ? DEFAULT_INTERACTION_MODE : interactionMode;
  const settingsDefaultModelByProvider = useMemo(
    () => ({
      codex: resolveAppModelSelection(
        "codex",
        settings.customCodexModels,
        settings.defaultCodexModel,
      ),
      opencode: resolveAppModelSelection(
        "opencode",
        settings.customOpenCodeModels,
        settings.defaultOpenCodeModel,
      ),
    }),
    [
      settings.customCodexModels,
      settings.customOpenCodeModels,
      settings.defaultCodexModel,
      settings.defaultOpenCodeModel,
    ],
  );
  const composerScopeCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const baseThreadModel = useMemo(() => {
    if (selectedProvider === "opencode") {
      return activeThread?.model ?? activeProject?.model ?? settingsDefaultModelByProvider.opencode;
    }
    return resolveModelSlugForProvider(
      selectedProvider,
      activeThread?.model ?? activeProject?.model ?? settingsDefaultModelByProvider.codex,
    );
  }, [
    activeProject?.model,
    activeThread?.model,
    selectedProvider,
    settingsDefaultModelByProvider.codex,
    settingsDefaultModelByProvider.opencode,
  ]);
  const customModelsForSelectedProvider =
    selectedProvider === "opencode" ? settings.customOpenCodeModels : settings.customCodexModels;
  const selectedModel = useMemo(() => {
    const draftModel = composerDraft.model;
    if (!draftModel) {
      return baseThreadModel;
    }
    return resolveAppModelSelection(selectedProvider, customModelsForSelectedProvider, draftModel);
  }, [baseThreadModel, composerDraft.model, customModelsForSelectedProvider, selectedProvider]);
  const openCodeProvidersQuery = useQuery({
    queryKey: [
      "opencode",
      "composer",
      "providers",
      composerScopeCwd,
      settings.opencodeServerUrl ?? null,
      settings.opencodeBinaryPath ?? null,
    ],
    queryFn: () =>
      fetchOpenCodeComposerProviders({
        cwd: composerScopeCwd,
        serverUrl: settings.opencodeServerUrl,
        binaryPath: settings.opencodeBinaryPath,
      }),
    enabled: selectedProvider === "opencode",
    staleTime: 60_000,
    retry: 1,
  });
  const openCodeAgentsQuery = useQuery({
    queryKey: [
      "opencode",
      "composer",
      "agents",
      composerScopeCwd,
      settings.opencodeServerUrl ?? null,
      settings.opencodeBinaryPath ?? null,
    ],
    queryFn: () =>
      fetchOpenCodeComposerAgents({
        cwd: composerScopeCwd,
        serverUrl: settings.opencodeServerUrl,
        binaryPath: settings.opencodeBinaryPath,
      }),
    enabled: selectedProvider === "opencode",
    staleTime: 60_000,
    retry: 1,
  });
  const visibleOpenCodeAgents = useMemo(
    () =>
      (openCodeAgentsQuery.data ?? []).filter(
        (agent) => agent.hidden !== true && agent.name.length > 0 && agent.mode !== "subagent",
      ),
    [openCodeAgentsQuery.data],
  );
  const openCodeAgentsErrorMessage =
    openCodeAgentsQuery.error instanceof Error
      ? openCodeAgentsQuery.error.message
      : openCodeAgentsQuery.isError
        ? "OpenCode agents are unavailable"
        : null;
  const defaultOpenCodeAgent = visibleOpenCodeAgents[0]?.name ?? null;
  const selectedOpenCodeAgent =
    selectedProvider === "opencode" ? (composerDraft.opencodeAgent ?? defaultOpenCodeAgent) : null;
  const selectedOpenCodeModelVariants = useMemo(() => {
    if (selectedProvider !== "opencode") {
      return [] as string[];
    }
    for (const provider of openCodeProvidersQuery.data?.all ?? []) {
      const model = provider.models[selectedModel];
      if (!model?.variants) {
        continue;
      }
      return Object.keys(model.variants).filter((variant) => variant !== "default");
    }
    return [] as string[];
  }, [openCodeProvidersQuery.data?.all, selectedModel, selectedProvider]);
  const selectedOpenCodeVariant =
    selectedProvider === "opencode" &&
    composerDraft.opencodeVariant &&
    selectedOpenCodeModelVariants.includes(composerDraft.opencodeVariant)
      ? composerDraft.opencodeVariant
      : null;
  const selectedOpenCodeAllowQuestions =
    selectedProvider === "opencode" ? (composerDraft.opencodeAllowQuestions ?? true) : true;
  const reasoningOptions = getReasoningEffortOptions(selectedProvider);
  const supportsReasoningEffort = reasoningOptions.length > 0;
  const selectedEffort = composerDraft.effort ?? getDefaultReasoningEffort(selectedProvider);
  const selectedCodexFastModeEnabled =
    selectedProvider === "codex" ? composerDraft.codexFastMode : false;
  const selectedModelOptionsForDispatch = useMemo(() => {
    if (selectedProvider === "codex") {
      const codexOptions = {
        ...(supportsReasoningEffort && selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        ...(selectedCodexFastModeEnabled ? { fastMode: true } : {}),
      };
      return Object.keys(codexOptions).length > 0 ? { codex: codexOptions } : undefined;
    }
    if (selectedProvider === "opencode") {
      const openCodeOptions = {
        ...(selectedOpenCodeAgent ? { agent: selectedOpenCodeAgent } : {}),
        ...(selectedOpenCodeVariant ? { variant: selectedOpenCodeVariant } : {}),
        allowQuestions: selectedOpenCodeAllowQuestions,
      };
      return Object.keys(openCodeOptions).length > 0 ? { opencode: openCodeOptions } : undefined;
    }
    return undefined;
  }, [
    selectedCodexFastModeEnabled,
    selectedEffort,
    selectedOpenCodeAgent,
    selectedOpenCodeAllowQuestions,
    selectedOpenCodeVariant,
    selectedProvider,
    supportsReasoningEffort,
  ]);
  const providerOptionsForDispatch = useMemo(() => {
    const hasCodexOverrides = Boolean(settings.codexBinaryPath || settings.codexHomePath);
    const hasOpenCodeOverrides = Boolean(settings.opencodeServerUrl || settings.opencodeBinaryPath);
    if (!hasCodexOverrides && !hasOpenCodeOverrides) {
      return undefined;
    }
    return {
      ...(hasCodexOverrides
        ? {
            codex: {
              ...(settings.codexBinaryPath ? { binaryPath: settings.codexBinaryPath } : {}),
              ...(settings.codexHomePath ? { homePath: settings.codexHomePath } : {}),
            },
          }
        : {}),
      ...(hasOpenCodeOverrides
        ? {
            opencode: {
              ...(settings.opencodeServerUrl ? { serverUrl: settings.opencodeServerUrl } : {}),
              ...(settings.opencodeBinaryPath ? { binaryPath: settings.opencodeBinaryPath } : {}),
            },
          }
        : {}),
    };
  }, [
    settings.codexBinaryPath,
    settings.codexHomePath,
    settings.opencodeServerUrl,
    settings.opencodeBinaryPath,
  ]);
  const selectedModelForPicker = selectedModel;
  const modelOptionsByProvider = useMemo(
    () => getCustomModelOptionsByProvider(settings),
    [settings],
  );
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.filter(
        (option) => lockedProvider === null || option.value === lockedProvider,
      ).flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
        })),
      ),
    [lockedProvider, modelOptionsByProvider],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isSendBusy = sendPhase !== "idle";
  const isPreparingWorktree = sendPhase === "preparing-worktree";
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    sendStartedAt,
  );
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    activeProposedPlan !== null;
  const activePendingApproval = pendingApprovals[0] ?? null;
  const isComposerApprovalState = activePendingApproval !== null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], workLogEntries),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const gitCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitCwd));
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }

    if (composerTrigger.kind === "slash-command") {
      const slashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal chat mode",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const query = composerTrigger.query.trim().toLowerCase();
      if (!query) {
        return [...slashCommandItems];
      }
      return slashCommandItems.filter(
        (item) => item.command.includes(query) || item.label.slice(1).includes(query),
      );
    }

    return searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) return true;
        return (
          searchSlug.includes(query) || searchName.includes(query) || searchProvider.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name }) => ({
        id: `model:${provider}:${slug}`,
        type: "model",
        provider,
        model: slug,
        label: name,
        description: `${providerLabel} · ${slug}`,
      }));
  }, [composerTrigger, searchableModelOptions, workspaceEntries]);
  const composerMenuOpen = Boolean(composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const providerStatuses = serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES;
  const activeProvider = activeThread?.session?.provider ?? "codex";
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === activeProvider) ?? null,
    [activeProvider, providerStatuses],
  );
  useEffect(() => {
    if (activeThread?.provider !== "opencode") return;
    void serverConfigQuery.refetch();
  }, [activeThread?.id, activeThread?.provider, serverConfigQuery]);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProjectCwd) return {};
    return projectScriptRuntimeEnv({
      project: {
        cwd: activeProjectCwd,
      },
      worktreePath: activeThreadWorktreePath,
    });
  }, [activeProjectCwd, activeThreadWorktreePath]);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = branchesQuery.data?.isRepo ?? true;
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const onToggleDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, navigate, threadId]);

  // rightPanelMode: derived from URL diff param + local devLogsOpen state
  const rightPanelMode: RightPanelMode | null = diffOpen ? "diff" : devLogsOpen ? "dev-logs" : null;

  const onRightPanelModeChange = useCallback(
    (mode: RightPanelMode | null) => {
      if (mode === "diff" || mode === null) {
        // Toggling diff: use URL nav
        const openDiff = mode === "diff";
        void navigate({
          to: "/$threadId",
          params: { threadId },
          replace: true,
          search: (previous) => {
            const rest = stripDiffSearchParams(previous);
            return openDiff ? { ...rest, diff: "1" } : { ...rest, diff: undefined };
          },
        });
        // Close dev logs if opening diff
        if (openDiff) setDevLogsOpen(false);
      }
      if (mode === "dev-logs") {
        setDevLogsOpen(true);
        // Close diff if opening dev logs
        void navigate({
          to: "/$threadId",
          params: { threadId },
          replace: true,
          search: (previous) => {
            const rest = stripDiffSearchParams(previous);
            return { ...rest, diff: undefined };
          },
        });
      }
      if (mode === null) {
        setDevLogsOpen(false);
      }
    },
    [navigate, threadId],
  );

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = devLogsPanelWidthRef.current;

    const onMouseMove = (moveEvent: MouseEvent) => {
      // Dragging left (negative delta) grows the panel
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(240, Math.min(800, startWidth + delta));
      setDevLogsPanelWidth(newWidth);
      devLogsPanelWidthRef.current = newWidth;
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      localStorage.setItem("t3code:dev-logs-width", String(devLogsPanelWidthRef.current));
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // Always-fresh ref to the active-project broadcast payload.
  // Avoids stale closures inside the broadcaster's sync-request handler.
  const buildActiveProjectMsg = useCallback(() => {
    if (!activeProject) return null;
    const activeDevServer = devServerByProjectId[activeProject.id];
    return {
      type: "active-project" as const,
      projectId: activeProject.id,
      projectName: activeProject.name,
      devServerRunning: activeDevServer?.status === "running",
      serverUrl: activeDevServer?.url,
      packageManager: activeDevServer?.packageManager,
    } satisfies ActiveProjectMessage;
  }, [activeProject, devServerByProjectId]);

  const buildActiveProjectMsgRef = useRef(buildActiveProjectMsg);
  useEffect(() => {
    buildActiveProjectMsgRef.current = buildActiveProjectMsg;
  }, [buildActiveProjectMsg]);

  // Lazily initialise the broadcaster and register the sync-request handler.
  // Called before every popout open so the handler is always wired up.
  const ensureBroadcaster = useCallback(() => {
    if (popoutChannelRef.current) return popoutChannelRef.current;
    const broadcaster = new PopoutBroadcaster();
    // Use a ref so the handler always calls the freshest buildActiveProjectMsg
    // even if it was recreated since the broadcaster was created.
    broadcaster.onSyncRequest(() => {
      const msg = buildActiveProjectMsgRef.current();
      if (msg) broadcaster.send(msg);
    });
    popoutChannelRef.current = broadcaster;
    return broadcaster;
  }, []);

  const handlePopout = useCallback(async () => {
    // Always init the broadcaster first so broadcasts are ready even before
    // the window is fully loaded (the popout sends "request-sync" on mount).
    ensureBroadcaster();

    if (isElectron && window.desktopBridge) {
      // Main process creates / focuses the window directly — no window.open().
      // This prevents the renderer's window.open() from ever touching the main window.
      await window.desktopBridge.openOrFocusDevLogsPopout();
      return;
    }

    // Browser (non-Electron) fallback — window.open() is fine here.
    if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
      popoutWindowRef.current.focus();
      return;
    }
    const win = window.open(
      "/dev-logs-popout",
      "t3code-dev-logs-popout",
      "width=960,height=720,menubar=no,toolbar=no,location=no,resizable=yes,scrollbars=yes",
    );
    popoutWindowRef.current = win;
  }, [ensureBroadcaster]);

  const handleDevServerRestart = useCallback(async () => {
    if (!activeProject) return;
    const api = readNativeApi();
    if (!api) return;
    await api.devServer.restart({ projectId: activeProject.id, cwd: activeProject.cwd });
  }, [activeProject]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messageCount > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      // Read threads imperatively to avoid a broad subscription on the whole array.
      if (useStore.getState().threads.some((thread) => thread.id === targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    composerEditorRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeThread) {
        return;
      }
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = insertComposerDraftTerminalContext(
        activeThread.id,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      promptRef.current = insertion.prompt;
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [activeThread, composerCursor, composerTerminalContexts, insertComposerDraftTerminalContext],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!activeThreadId) return;
      storeSetTerminalHeight(activeThreadId, height);
    },
    [activeThreadId, storeSetTerminalHeight],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, terminalState.terminalOpen]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeSetActiveTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeSetActiveTerminal],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeCloseTerminal, terminalState.terminalIds.length],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
        allowLocalDraftThread?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (!isServerThread && !options?.allowLocalDraftThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: Parameters<typeof api.terminal.open>[0] = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      isServerThread,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const toggleRuntimeMode = useCallback(() => {
    void handleRuntimeModeChange(
      runtimeMode === "full-access" ? "approval-required" : "full-access",
    );
  }, [handleRuntimeModeChange, runtimeMode]);
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        const turnKey = activePlan?.turnId ?? activeProposedPlan?.turnId ?? null;
        if (turnKey) {
          planSidebarDismissedForTurnRef.current = turnKey;
        }
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [activePlan?.turnId, activeProposedPlan?.turnId]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      model?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (input.model !== undefined && input.model !== serverThread.model) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          model: input.model,
        });
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThread],
  );

  useEffect(() => {
    try {
      if (Object.keys(lastInvokedScriptByProjectId).length === 0) {
        localStorage.removeItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
        return;
      }
      localStorage.setItem(
        LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
        JSON.stringify(lastInvokedScriptByProjectId),
      );
    } catch {
      // Ignore storage write failures (private mode, quota exceeded, etc.)
    }
  }, [lastInvokedScriptByProjectId]);

  // Mount scroll pill when showScrollToBottom becomes true; stay mounted
  // during exit animation until onAnimationEnd unmounts it.
  useEffect(() => {
    if (showScrollToBottom) {
      setScrollPillMounted(true);
    }
  }, [showScrollToBottom]);

  // Auto-scroll on new messages
  const messageCount = timelineMessages.length;
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    lastKnownScrollTopRef.current = scrollContainer.scrollTop;
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
  }, []);
  const clearScrollPillSuppression = useCallback(() => {
    if (!suppressScrollPillRef.current) return;
    suppressScrollPillRef.current = false;

    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    setShowScrollToBottom(!isScrollContainerNearBottom(scrollContainer));
  }, []);
  const onJumpToLatest = useCallback(() => {
    suppressScrollPillRef.current = true;
    setShowScrollToBottom(false);
    scrollMessagesToBottom("smooth");
  }, [scrollMessagesToBottom]);
  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingAutoScrollFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const scheduleStickToBottom = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) return;
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      scrollMessagesToBottom();
    });
  }, [scrollMessagesToBottom]);
  const onMessagesClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = messagesScrollRef.current;
        if (!anchor || !activeScrollContainer) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
        lastKnownScrollTopRef.current = activeScrollContainer.scrollTop;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom();
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);
  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const currentScrollTop = scrollContainer.scrollTop;
    const isNearBottom = isScrollContainerNearBottom(scrollContainer);

    if (suppressScrollPillRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (isNearBottom) {
        suppressScrollPillRef.current = false;
      } else if (
        scrolledUp &&
        (pendingUserScrollUpIntentRef.current || isPointerScrollActiveRef.current)
      ) {
        suppressScrollPillRef.current = false;
      }
    }

    if (!shouldAutoScrollRef.current && isNearBottom) {
      shouldAutoScrollRef.current = true;
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && pendingUserScrollUpIntentRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && isPointerScrollActiveRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    } else if (shouldAutoScrollRef.current && !isNearBottom) {
      // Catch-all for keyboard/assistive scroll interactions.
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    }

    setShowScrollToBottom(!shouldAutoScrollRef.current);
    lastKnownScrollTopRef.current = currentScrollTop;
    setShowScrollToBottom(suppressScrollPillRef.current ? false : !isNearBottom);
  }, []);
  const onMessagesWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      clearScrollPillSuppression();
      if (event.deltaY < 0) {
        pendingUserScrollUpIntentRef.current = true;
      }
    },
    [clearScrollPillSuppression],
  );
  const onMessagesPointerDown = useCallback(
    (_event: React.PointerEvent<HTMLDivElement>) => {
      clearScrollPillSuppression();
      isPointerScrollActiveRef.current = true;
    },
    [clearScrollPillSuppression],
  );
  const onMessagesPointerUp = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesPointerCancel = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      clearScrollPillSuppression();
      const touch = event.touches[0];
      if (!touch) return;
      lastTouchClientYRef.current = touch.clientY;
    },
    [clearScrollPillSuppression],
  );
  const onMessagesTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    const previousTouchY = lastTouchClientYRef.current;
    if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
      pendingUserScrollUpIntentRef.current = true;
    }
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchEnd = useCallback((_event: React.TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  }, []);
  useEffect(() => {
    return () => {
      cancelPendingStickToBottom();
      cancelPendingInteractionAnchorAdjustment();
    };
  }, [cancelPendingInteractionAnchorAdjustment, cancelPendingStickToBottom]);
  useLayoutEffect(() => {
    if (!activeThread?.id) return;
    shouldAutoScrollRef.current = true;
    scheduleStickToBottom();
    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, 96);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeThread?.id, scheduleStickToBottom]);
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    setIsComposerFooterCompact(
      shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      }),
    );
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextCompact = shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));

      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, composerFooterHasWideActions, scheduleStickToBottom]);
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom]);
  useEffect(() => {
    if (phase !== "running") return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [phase, scheduleStickToBottom, timelineEntries]);

  useEffect(() => {
    setExpandedWorkGroups({});
    setPullRequestDialogState(null);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      setPlanSidebarOpen(true);
    } else {
      setPlanSidebarOpen(false);
    }
    planSidebarDismissedForTurnRef.current = null;
  }, [activeThread?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (!activeThread.messagesHydrated || activeThread.messageCount === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeThread?.id,
    activeThread?.messageCount,
    activeThread?.messages,
    activeThread?.messagesHydrated,
    handoffAttachmentPreviews,
    optimisticUserMessages,
  ]);

  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setSendPhase("idle");
    setSendStartedAt(null);
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(threadId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : "local";

  const beginSendPhase = useCallback((nextPhase: Exclude<SendPhase, "idle">) => {
    setSendStartedAt((current) => current ?? new Date().toISOString());
    setSendPhase(nextPhase);
  }, []);

  const resetSendPhase = useCallback(() => {
    setSendPhase("idle");
    setSendStartedAt(null);
  }, []);

  useEffect(() => {
    if (sendPhase === "idle") {
      return;
    }
    if (
      phase === "running" ||
      activePendingApproval !== null ||
      activePendingUserInput !== null ||
      activeThread?.error
    ) {
      resetSendPhase();
    }
  }, [
    activePendingApproval,
    activePendingUserInput,
    activeThread?.error,
    phase,
    resetSendPhase,
    sendPhase,
  ]);

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleDiff,
    toggleTerminalVisibility,
  ]);

  // Broadcast active project info to the popout window whenever it changes
  useEffect(() => {
    const broadcaster = ensureBroadcaster();
    const msg = buildActiveProjectMsg();
    if (!msg) return;
    broadcaster.send(msg);
  }, [buildActiveProjectMsg, ensureBroadcaster]);

  useEffect(() => {
    if (!isElectron || !window.desktopBridge) return;
    const targetUrl =
      activeProject && devServerByProjectId[activeProject.id]?.status === "running"
        ? (devServerByProjectId[activeProject.id]?.url ?? null)
        : null;
    void window.desktopBridge.updateDevServerPreviewUrl(targetUrl);
  }, [activeProject, devServerByProjectId]);

  // Cleanup broadcaster on unmount.
  // Also null the ref so ensureBroadcaster() creates a fresh instance if
  // the component remounts (HMR, StrictMode double-mount) and would otherwise
  // reuse the already-closed BroadcastChannel → InvalidStateError.
  useEffect(
    () => () => {
      popoutChannelRef.current?.close();
      popoutChannelRef.current = null;
    },
    [],
  );

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [activeThread, isConnecting, isRevertingCheckpoint, isSendBusy, phase, setThreadError],
  );

  const onSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readNativeApi();
    if (!api || !activeThread || isSendBusy || isConnecting || sendInFlightRef.current) return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      await handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (!activeProject) return;

    // If the LLM is actively running a turn and this is an existing server thread,
    // queue the message instead of sending it immediately. It will auto-send FIFO
    // once the current turn completes. We do NOT queue: first messages, local draft
    // threads (no thread ID yet), plan follow-ups, slash commands, or approval flows
    // (those are already handled above).
    const isFollowUpOnRunningTurn =
      phase === "running" &&
      !isSendBusy &&
      !isConnecting &&
      isServerThread &&
      !showPlanFollowUpPrompt;
    if (isFollowUpOnRunningTurn) {
      // Compute text + preview at queue-time (same as the real send would do).
      const queueText = appendTerminalContextsToPrompt(promptForSend, [
        ...sendableComposerTerminalContexts,
      ]);
      const preview =
        trimmed
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? "";
      setQueuedMessages((existing) => [
        ...existing,
        {
          id: newMessageId(),
          text: queueText,
          preview,
        },
      ]);
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messageCount === 0;
    const baseBranchForWorktree =
      isFirstMessage && envMode === "worktree" && !activeThread.worktreePath
        ? activeThread.branch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && envMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThread.branch) {
      setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return;
    }

    sendInFlightRef.current = true;
    beginSendPhase(baseBranchForWorktree ? "preparing-worktree" : "sending-turn");

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const messageTextForSend = appendTerminalContextsToPrompt(
      promptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: messageTextForSend,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    // Sending a message should always bring the latest user turn into view.
    shouldAutoScrollRef.current = true;
    forceStickToBottom();

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    promptRef.current = "";
    clearComposerDraftContent(threadIdForSend);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);

    let createdServerThreadForLocalDraft = false;
    let turnStartSucceeded = false;
    let nextThreadBranch = activeThread.branch;
    let nextThreadWorktreePath = activeThread.worktreePath;
    await (async () => {
      // On first message: lock in branch + create worktree if needed.
      if (baseBranchForWorktree) {
        beginSendPhase("preparing-worktree");
        const newBranch = buildTemporaryWorktreeBranchName();
        const result = await createWorktreeMutation.mutateAsync({
          cwd: activeProject.cwd,
          branch: baseBranchForWorktree,
          newBranch,
        });
        nextThreadBranch = result.worktree.branch;
        nextThreadWorktreePath = result.worktree.path;
        if (isServerThread) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          });
          // Keep local thread state in sync immediately so terminal drawer opens
          // with the worktree cwd/env instead of briefly using the project root.
          setStoreThreadBranch(threadIdForSend, result.worktree.branch, result.worktree.path);
        }
      }

      let firstComposerImageName: string | null = null;
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let titleSeed = trimmed;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else if (composerTerminalContextsSnapshot.length > 0) {
          titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
        } else {
          titleSeed = "New thread";
        }
      }
      const title = truncateTitle(titleSeed);
      let threadCreateModel: ModelSlug =
        selectedModel || (activeProject.model as ModelSlug) || DEFAULT_MODEL_BY_PROVIDER.codex;

      if (isLocalDraftThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          projectId: activeProject.id,
          title,
          model: threadCreateModel,
          provider: selectedProvider,
          runtimeMode,
          interactionMode: effectiveInteractionMode,
          branch: nextThreadBranch,
          worktreePath: nextThreadWorktreePath,
          createdAt: activeThread.createdAt,
        });
        createdServerThreadForLocalDraft = true;
      }

      let setupScript: ProjectScript | null = null;
      if (baseBranchForWorktree) {
        setupScript = setupProjectScript(activeProject.scripts);
      }
      if (setupScript) {
        let shouldRunSetupScript = false;
        if (isServerThread) {
          shouldRunSetupScript = true;
        } else {
          if (createdServerThreadForLocalDraft) {
            shouldRunSetupScript = true;
          }
        }
        if (shouldRunSetupScript) {
          const setupScriptOptions: Parameters<typeof runProjectScript>[1] = {
            worktreePath: nextThreadWorktreePath,
            rememberAsLastInvoked: false,
            allowLocalDraftThread: createdServerThreadForLocalDraft,
          };
          if (nextThreadWorktreePath) {
            setupScriptOptions.cwd = nextThreadWorktreePath;
          }
          await runProjectScript(setupScript, setupScriptOptions);
        }
      }

      // Auto-title from first message
      if (isFirstMessage && isServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModel ? { model: selectedModel } : {}),
          runtimeMode,
          interactionMode: effectiveInteractionMode,
        });
      }

      beginSendPhase("sending-turn");
      const turnAttachments = await turnAttachmentsPromise;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
          attachments: turnAttachments,
        },
        model: selectedModel || undefined,
        ...(selectedModelOptionsForDispatch
          ? { modelOptions: selectedModelOptionsForDispatch }
          : {}),
        ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
        provider: selectedProvider,
        assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
        runtimeMode,
        interactionMode: effectiveInteractionMode,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
      // Eagerly sync state after turn start so the UI reflects "running" immediately,
      // without waiting for the domain event push which may be throttled or dropped
      // by the sequence guard if a snapshot fetch races ahead of it.
      api.orchestration
        .getSnapshot()
        .then((snapshot) => {
          syncServerReadModel(snapshot);
        })
        .catch(() => undefined);
    })().catch(async (err: unknown) => {
      if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        setPrompt(promptForSend);
        setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      resetSendPhase();
    }
  };

  /**
   * Sends the first item from the queue (called automatically when the LLM
   * finishes a turn and the queue is non-empty).
   *
   * Intentionally does NOT call beginSendPhase / resetSendPhase.
   * sendPhase is for user-initiated sends from the composer — if we set it here,
   * it can get stuck as "sending-turn" when the Turn completes faster than the
   * resetSendPhase effect's phase === "running" check fires. Instead, isWorking
   * naturally reflects the server phase once the command is dispatched.
   *
   * sendInFlightRef.current is enough to prevent concurrent sends.
   */
  const sendQueuedMessage = useCallback(
    async (item: QueuedMessage) => {
      const api = readNativeApi();
      if (!api || !activeThread || !activeProject || !isServerThread) return;
      if (sendInFlightRef.current) return;

      sendInFlightRef.current = true;

      const messageCreatedAt = new Date().toISOString();
      const optimisticMessage: ChatMessage = {
        id: item.id as MessageId,
        role: "user",
        text: item.text,
        createdAt: messageCreatedAt,
        streaming: false,
      };

      setOptimisticUserMessages((existing) => [...existing, optimisticMessage]);
      shouldAutoScrollRef.current = true;
      forceStickToBottom();

      try {
        await persistThreadSettingsForNextTurn({
          threadId: activeThread.id,
          createdAt: messageCreatedAt,
          ...(selectedModel ? { model: selectedModel } : {}),
          runtimeMode,
          interactionMode: effectiveInteractionMode,
        });

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: activeThread.id,
          message: {
            messageId: item.id as MessageId,
            role: "user",
            text: item.text || IMAGE_ONLY_BOOTSTRAP_PROMPT,
            attachments: [],
          },
          model: selectedModel || undefined,
          ...(selectedModelOptionsForDispatch
            ? { modelOptions: selectedModelOptionsForDispatch }
            : {}),
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          provider: selectedProvider,
          assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
          runtimeMode,
          interactionMode: effectiveInteractionMode,
          createdAt: messageCreatedAt,
        });

        // Eagerly sync so the UI reflects "running" immediately.
        api.orchestration
          .getSnapshot()
          .then((snapshot) => {
            syncServerReadModel(snapshot);
          })
          .catch(() => undefined);
      } catch (err) {
        // Roll back the optimistic message on failure.
        setOptimisticUserMessages((existing) => existing.filter((msg) => msg.id !== item.id));
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to send queued message.",
        );
      } finally {
        sendInFlightRef.current = false;
      }
    },
    [
      activeProject,
      activeThread,
      effectiveInteractionMode,
      forceStickToBottom,
      isServerThread,
      persistThreadSettingsForNextTurn,
      providerOptionsForDispatch,
      runtimeMode,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedProvider,
      setThreadError,
      settings.enableAssistantStreaming,
      syncServerReadModel,
    ],
  );

  // Auto-send: drain the queue FIFO once the current LLM turn completes.
  // Guards: don't fire while a send is already in flight, while approvals /
  // user-inputs are blocking, or while the thread still has an error.
  //
  // Special case — manual interrupt:
  //   If the user explicitly aborted the turn (wasInterruptedRef), the queue
  //   content is restored back to the composer instead of auto-sending.
  //   All messages are joined with double-newlines so the user can review,
  //   edit, and press Enter themselves to confirm.
  useEffect(() => {
    if (queuedMessages.length === 0) return;
    if (isWorking) return;
    if (pendingApprovals.length > 0) return;
    if (pendingUserInputs.length > 0) return;
    if (activeThread?.error) return;

    if (wasInterruptedRef.current) {
      // Restore all queued messages to the composer, joined by double newlines.
      wasInterruptedRef.current = false;
      const restoredText = queuedMessages.map((m) => m.text).join("\n\n");
      setQueuedMessages([]);
      setPrompt(restoredText);
      setComposerCursor(restoredText.length);
      // Focus the composer so the user can immediately review and press Enter.
      window.requestAnimationFrame(() => focusComposer());
      return;
    }

    const [first] = queuedMessages;
    if (!first) return;

    // Dequeue before sending so clicking "remove" on the next item during
    // the send doesn't accidentally remove the one being sent.
    setQueuedMessages((existing) => existing.slice(1));
    void sendQueuedMessage(first);
  }, [
    activeThread?.error,
    focusComposer,
    isWorking,
    pendingApprovals.length,
    pendingUserInputs.length,
    queuedMessages,
    sendQueuedMessage,
    setPrompt,
  ]);

  // Clear queue when the user navigates to a different thread.
  useEffect(() => {
    setQueuedMessages([]);
  }, [threadId]);

  const onInterrupt = async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    // If there are queued messages, flag the interrupt so the auto-send effect
    // restores them to the composer instead of firing them automatically.
    if (queuedMessages.length > 0) {
      wasInterruptedRef.current = true;
    }
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setStoreThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: selectPendingUserInputOption(optionLabel),
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readNativeApi();
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();

      sendInFlightRef.current = true;
      beginSendPhase("sending-turn");
      setThreadError(threadIdForSend, null);
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: trimmed,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
      shouldAutoScrollRef.current = true;
      forceStickToBottom();

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModel ? { model: selectedModel } : {}),
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: trimmed,
            attachments: [],
          },
          provider: selectedProvider,
          model: selectedModel || undefined,
          ...(selectedModelOptionsForDispatch
            ? { modelOptions: selectedModelOptionsForDispatch }
            : {}),
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
          runtimeMode,
          interactionMode: nextInteractionMode,
          createdAt: messageCreatedAt,
        });
        // Eagerly sync state after turn start (same rationale as in onSubmit).
        api.orchestration
          .getSnapshot()
          .then((snapshot) => {
            syncServerReadModel(snapshot);
          })
          .catch(() => undefined);
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default") {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
        sendInFlightRef.current = false;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetSendPhase();
      }
    },
    [
      activeThread,
      beginSendPhase,
      forceStickToBottom,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      resetSendPhase,
      runtimeMode,
      selectedModel,
      selectedModelOptionsForDispatch,
      providerOptionsForDispatch,
      selectedProvider,
      setComposerDraftInteractionMode,
      setThreadError,
      settings.enableAssistantStreaming,
      syncServerReadModel,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const nextThreadTitle = truncateTitle(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModel: ModelSlug =
      selectedModel ||
      (activeThread.model as ModelSlug) ||
      (activeProject.model as ModelSlug) ||
      DEFAULT_MODEL_BY_PROVIDER.codex;

    sendInFlightRef.current = true;
    beginSendPhase("sending-turn");
    const finish = () => {
      sendInFlightRef.current = false;
      resetSendPhase();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        model: nextThreadModel,
        provider: selectedProvider,
        runtimeMode,
        interactionMode: "default",
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: implementationPrompt,
            attachments: [],
          },
          provider: selectedProvider,
          model: selectedModel || undefined,
          ...(selectedModelOptionsForDispatch
            ? { modelOptions: selectedModelOptionsForDispatch }
            : {}),
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
          runtimeMode,
          interactionMode: "default",
          createdAt,
        });
      })
      .then(() => api.orchestration.getSnapshot())
      .then((snapshot) => {
        syncServerReadModel(snapshot);
        // Signal that the plan sidebar should open on the new thread.
        planSidebarOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        await api.orchestration
          .getSnapshot()
          .then((snapshot) => {
            syncServerReadModel(snapshot);
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThread,
    beginSendPhase,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetSendPhase,
    runtimeMode,
    selectedModel,
    selectedModelOptionsForDispatch,
    providerOptionsForDispatch,
    selectedProvider,
    settings.enableAssistantStreaming,
    syncServerReadModel,
  ]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: ModelSlug) => {
      if (!activeThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const customModels =
        provider === "opencode" ? settings.customOpenCodeModels : settings.customCodexModels;
      setComposerDraftProvider(activeThread.id, provider);
      setComposerDraftModel(
        activeThread.id,
        resolveAppModelSelection(provider, customModels, model),
      );
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModel,
      setComposerDraftProvider,
      settings.customOpenCodeModels,
      settings.customCodexModels,
    ],
  );
  const onOpenCodeAgentSelect = useCallback(
    (agentName: string) => {
      if (!activeThread) {
        return;
      }
      const nextAgent = visibleOpenCodeAgents.find((agent) => agent.name === agentName);
      if (!nextAgent) {
        scheduleComposerFocus();
        return;
      }
      setComposerDraftProvider(activeThread.id, "opencode");
      setComposerDraftOpenCodeAgent(activeThread.id, nextAgent.name);
      setComposerDraftOpenCodeVariant(activeThread.id, nextAgent.variant ?? null);
      scheduleComposerFocus();
    },
    [
      activeThread,
      scheduleComposerFocus,
      setComposerDraftOpenCodeAgent,
      setComposerDraftOpenCodeVariant,
      setComposerDraftProvider,
      visibleOpenCodeAgents,
    ],
  );
  const onOpenCodeVariantSelect = useCallback(
    (variant: string | null) => {
      setComposerDraftOpenCodeVariant(threadId, variant);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setComposerDraftOpenCodeVariant, threadId],
  );
  const onOpenCodeAllowQuestionsChange = useCallback(
    (allowQuestions: boolean) => {
      setComposerDraftProvider(threadId, "opencode");
      setComposerDraftOpenCodeAllowQuestions(threadId, allowQuestions);
      scheduleComposerFocus();
    },
    [
      scheduleComposerFocus,
      setComposerDraftOpenCodeAllowQuestions,
      setComposerDraftProvider,
      threadId,
    ],
  );
  const onEffortSelect = useCallback(
    (effort: CodexReasoningEffort) => {
      setComposerDraftEffort(threadId, effort);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setComposerDraftEffort, threadId],
  );
  const onCodexFastModeChange = useCallback(
    (enabled: boolean) => {
      setComposerDraftCodexFastMode(threadId, enabled);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setComposerDraftCodexFastMode, threadId],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { envMode: mode });
      }
      scheduleComposerFocus();
    },
    [isLocalDraftThread, scheduleComposerFocus, setDraftThreadContext, threadId],
  );

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingUserInput.requestId]?.[activePendingQuestion.id],
              next.text,
            ),
          },
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return true;
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, setPrompt],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `@${item.path} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const replacement = "/model ";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      onProviderModelSelect(item.provider, item.model);
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
    },
    [
      applyPromptReplacement,
      handleInteractionModeChange,
      onProviderModelSelect,
      resolveActiveComposerTrigger,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    composerTriggerKind === "path" &&
    ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
      setComposerDraftTerminalContexts,
      threadId,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }

    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      void onSend();
      return true;
    }
    return false;
  };
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath }
            : { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
    },
    [navigate, threadId],
  );
  const onRevertUserMessage = (messageId: MessageId) => {
    const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCount(targetTurnCount);
  };

  const onForkMessage = useCallback(
    (messageId: MessageId, prompt: string, navigateToFork: boolean, forkModel: string) => {
      const api = readNativeApi();
      if (!api || !activeThread || !activeProject) return;
      if (activeThread.provider !== "opencode") return;

      const messages = activeThread.messages;
      const messageIndex = messages.findIndex((m) => m.id === messageId);
      const message = messages[messageIndex];

      const toOcId = (id: MessageId): string => {
        const s = String(id);
        return s.startsWith("oc:") ? s.slice(3) : s;
      };

      // USER message → fork excludes this message onward; prompt replaces it.
      // ASSISTANT message → include the response; cut at the next message (or clone all).
      let cutoffOcMessageId: string | undefined;
      if (message?.role === "assistant") {
        const nextMessage = messages[messageIndex + 1];
        cutoffOcMessageId = nextMessage ? toOcId(nextMessage.id) : undefined;
      } else {
        cutoffOcMessageId = toOcId(messageId);
      }

      void (async () => {
        try {
          // The server resolves the live session id from threadId automatically.
          // We pass externalSessionId only as a hint when no live session exists yet.
          const { forkedSessionId, title: forkedTitle } = await api.opencode.forkSession({
            threadId: activeThread.id,
            messageId: cutoffOcMessageId,
            directory: activeThread.worktreePath ?? activeProject.cwd,
          });

          const newThread = newThreadId();
          const newMsgId = newMessageId();
          const createdAt = new Date().toISOString();

          await api.orchestration.dispatchCommand({
            type: "thread.create",
            commandId: newCommandId(),
            threadId: newThread,
            projectId: activeProject.id,
            title: forkedTitle || `${activeThread.title ?? "Thread"} (fork)`,
            model: forkModel || activeThread.model || selectedModel || "",
            provider: "opencode",
            source: "imported",
            externalSessionId: forkedSessionId,
            runtimeMode: activeThread.runtimeMode ?? runtimeMode,
            interactionMode: activeThread.interactionMode ?? interactionMode,
            branch: null,
            worktreePath: null,
            createdAt,
          });

          await api.orchestration.dispatchCommand({
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId: newThread,
            message: { messageId: newMsgId, role: "user", text: prompt, attachments: [] },
            provider: "opencode",
            model: forkModel || activeThread.model || selectedModel || undefined,
            assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
            runtimeMode: activeThread.runtimeMode ?? runtimeMode,
            interactionMode: activeThread.interactionMode ?? interactionMode,
            createdAt,
          });

          const snapshot = await api.orchestration.getSnapshot();
          syncServerReadModel(snapshot);

          if (navigateToFork) {
            await navigate({ to: "/$threadId", params: { threadId: newThread } });
          }
        } catch (err) {
          console.error("[fork] Failed to fork message:", err);
        }
      })();
    },
    [
      activeThread,
      activeProject,
      selectedModel,
      runtimeMode,
      interactionMode,
      settings.enableAssistantStreaming,
      navigate,
      syncServerReadModel,
    ],
  );

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
          </header>
        )}
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Top bar */}
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
      >
        <ChatHeader
          activeThreadId={activeThread.id}
          activeThreadTitle={activeThread.title}
          activeProjectName={activeProject?.name}
          activeProjectId={activeProject?.id as import("@t3tools/contracts").ProjectId | undefined}
          activeProjectCwd={activeProject?.cwd}
          isGitRepo={isGitRepo}
          openInCwd={activeThread.worktreePath ?? activeProject?.cwd ?? null}
          activeProjectScripts={activeProject?.scripts}
          preferredScriptId={
            activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
          }
          keybindings={keybindings}
          availableEditors={availableEditors}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          gitCwd={gitCwd}
          rightPanelMode={rightPanelMode}
          devServerInfo={activeProject ? devServerByProjectId[activeProject.id] : undefined}
          onRunProjectScript={(script) => {
            void runProjectScript(script);
          }}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
          onRightPanelModeChange={onRightPanelModeChange}
        />
      </header>

      {/* Error banner */}
      <ProviderHealthBanner status={activeProviderStatus} />
      <ThreadErrorBanner
        error={activeThread.error}
        onDismiss={() => setThreadError(activeThread.id, null)}
      />
      {/* Main content area with optional plan sidebar */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Messages Wrapper */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Messages */}
            <div
              ref={setMessagesScrollContainerRef}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
              onScroll={onMessagesScroll}
              onClickCapture={onMessagesClickCapture}
              onWheel={onMessagesWheel}
              onPointerDown={onMessagesPointerDown}
              onPointerUp={onMessagesPointerUp}
              onPointerCancel={onMessagesPointerCancel}
              onTouchStart={onMessagesTouchStart}
              onTouchMove={onMessagesTouchMove}
              onTouchEnd={onMessagesTouchEnd}
              onTouchCancel={onMessagesTouchEnd}
            >
              {/* Show a skeleton while message history is being fetched for threads that
                  have existing messages. Uses messagesEverHydratedRef (not the raw
                  messagesHydrated flag) to avoid the skeleton flashing back during
                  snapshot syncs that temporarily reset the flag while a turn runs. */}
              {!messagesEverHydratedRef.current && activeThread.messageCount > 0 ? (
                <ChatViewMessagesSkeleton />
              ) : (
                <MessagesTimeline
                  key={activeThread.id}
                  hasMessages={timelineEntries.length > 0}
                  isWorking={isWorking}
                  activeTurnInProgress={isWorking || !latestTurnSettled}
                  activeTurnStartedAt={activeWorkStartedAt}
                  scrollContainer={messagesScrollElement}
                  timelineEntries={timelineEntries}
                  completionDividerBeforeEntryId={null}
                  completionSummary={null}
                  turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                  expandedWorkGroups={expandedWorkGroups}
                  onToggleWorkGroup={onToggleWorkGroup}
                  onOpenTurnDiff={onOpenTurnDiff}
                  revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                  onRevertUserMessage={onRevertUserMessage}
                  isRevertingCheckpoint={isRevertingCheckpoint}
                  onImageExpand={onExpandTimelineImage}
                  markdownCwd={gitCwd ?? undefined}
                  resolvedTheme={resolvedTheme}
                  timestampFormat={timestampFormat}
                  workspaceRoot={activeProject?.cwd ?? undefined}
                  isOpenCodeThread={activeThread.provider === "opencode"}
                  forkPreFillContent={settings.forkPreFillContent}
                  forkDefaultNavigate={settings.navigateToForkedThread}
                  forkModelOptions={modelOptionsByProvider[selectedProvider]}
                  forkDefaultModel={selectedModel}
                  onForkMessage={onForkMessage}
                />
              )}
            </div>
          </div>

          {/* Jump to latest control */}
          {scrollPillMounted && (
            <div className="px-3 pt-1.5 sm:px-5 sm:pt-2">
              <div className="mx-auto flex w-full max-w-[var(--chat-content-max-width)] justify-center">
                <button
                  type="button"
                  onClick={onJumpToLatest}
                  onAnimationEnd={() => {
                    if (!showScrollToBottom) {
                      setScrollPillMounted(false);
                    }
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground",
                    showScrollToBottom ? "animate-jump-to-latest-in" : "animate-jump-to-latest-out",
                  )}
                >
                  <ArrowDownIcon className="size-3.5" />
                  Jump to latest
                </button>
              </div>
            </div>
          )}

          {/* Input bar — queue dock (if any) sits directly above the composer card,
              inside the same padding wrapper so they share horizontal alignment
              and border/radius stitching. */}
          <div className={cn("px-3 pt-1.5 sm:px-5 sm:pt-2", isGitRepo ? "pb-1" : "pb-3 sm:pb-4")}>
            <form
              ref={composerFormRef}
              onSubmit={onSend}
              className="mx-auto w-full min-w-0 max-w-[var(--chat-content-max-width)]"
              data-chat-composer-form="true"
            >
              {/* Queue dock — rendered inside the form so it shares the same max-width
                  and sits flush against the composer card (no gap, matched radii). */}
              {queuedMessages.length > 0 && (
                <ComposerQueueDock
                  items={queuedMessages}
                  isSending={isSendBusy}
                  onRemove={(id) =>
                    setQueuedMessages((existing) => existing.filter((m) => m.id !== id))
                  }
                />
              )}

              <div
                className={cn(
                  "group border bg-card transition-colors duration-200 focus-within:border-ring/45",
                  isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
                  // When the queue dock is attached above, remove top radius so the two
                  // elements merge into a single visual panel.
                  queuedMessages.length > 0 ? "rounded-b-[20px] rounded-t-none" : "rounded-[20px]",
                )}
                onDragEnter={onComposerDragEnter}
                onDragOver={onComposerDragOver}
                onDragLeave={onComposerDragLeave}
                onDrop={onComposerDrop}
              >
                {activePendingApproval ? (
                  <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                    <ComposerPendingApprovalPanel
                      approval={activePendingApproval}
                      pendingCount={pendingApprovals.length}
                    />
                  </div>
                ) : pendingUserInputs.length > 0 ? (
                  <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                    <ComposerPendingUserInputPanel
                      pendingUserInputs={pendingUserInputs}
                      respondingRequestIds={respondingRequestIds}
                      answers={activePendingDraftAnswers}
                      questionIndex={activePendingQuestionIndex}
                      onSelectOption={onSelectActivePendingUserInputOption}
                      onAdvance={onAdvanceActivePendingUserInput}
                    />
                  </div>
                ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                  <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                    <ComposerPlanFollowUpBanner
                      key={activeProposedPlan.id}
                      planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                    />
                  </div>
                ) : null}

                {activeOpenCodeThreadMetadata ? (
                  <OpenCodeThreadStatusStrip
                    metadata={activeOpenCodeThreadMetadata}
                    providers={openCodeProvidersQuery.data}
                  />
                ) : null}

                {/* Textarea area */}
                <div
                  className={cn(
                    "relative px-3 pb-2 sm:px-4",
                    hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
                  )}
                >
                  {composerMenuOpen && !isComposerApprovalState && (
                    <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                      <ComposerCommandMenu
                        items={composerMenuItems}
                        resolvedTheme={resolvedTheme}
                        isLoading={isComposerMenuLoading}
                        triggerKind={composerTriggerKind}
                        activeItemId={activeComposerMenuItem?.id ?? null}
                        onHighlightedItemChange={onComposerMenuItemHighlighted}
                        onSelect={onSelectComposerItem}
                      />
                    </div>
                  )}

                  {!isComposerApprovalState && pendingUserInputs.length === 0 && (
                    <>
                      {composerImages.length > 0 && (
                        <div className="mb-3 flex flex-wrap gap-2">
                          {composerImages.map((image) => (
                            <div
                              key={image.id}
                              className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                            >
                              {image.previewUrl ? (
                                <button
                                  type="button"
                                  className="h-full w-full cursor-zoom-in"
                                  aria-label={`Preview ${image.name}`}
                                  onClick={() => {
                                    const preview = buildExpandedImagePreview(
                                      composerImages,
                                      image.id,
                                    );
                                    if (!preview) return;
                                    setExpandedImage(preview);
                                  }}
                                >
                                  <img
                                    src={image.previewUrl}
                                    alt={image.name}
                                    className="h-full w-full object-cover"
                                  />
                                </button>
                              ) : (
                                <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                                  {image.name}
                                </div>
                              )}
                              {nonPersistedComposerImageIdSet.has(image.id) && (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <span
                                        role="img"
                                        aria-label="Draft attachment may not persist"
                                        className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                      >
                                        <CircleAlertIcon className="size-3" />
                                      </span>
                                    }
                                  />
                                  <TooltipPopup
                                    side="top"
                                    className="max-w-64 whitespace-normal leading-tight"
                                  >
                                    Draft attachment could not be saved locally and may be lost on
                                    navigation.
                                  </TooltipPopup>
                                </Tooltip>
                              )}
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                                onClick={() => removeComposerImage(image.id)}
                                aria-label={`Remove ${image.name}`}
                              >
                                <XIcon />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  <ComposerPromptEditor
                    ref={composerEditorRef}
                    value={
                      isComposerApprovalState
                        ? ""
                        : activePendingProgress
                          ? activePendingProgress.customAnswer
                          : prompt
                    }
                    cursor={composerCursor}
                    terminalContexts={
                      !isComposerApprovalState && pendingUserInputs.length === 0
                        ? composerTerminalContexts
                        : []
                    }
                    onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                    onChange={onPromptChange}
                    onCommandKeyDown={onComposerCommandKey}
                    onPaste={onComposerPaste}
                    placeholder={
                      isComposerApprovalState
                        ? (activePendingApproval?.detail ??
                          "Resolve this approval request to continue")
                        : activePendingProgress
                          ? "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : phase === "disconnected"
                              ? "Ask for follow-up changes or attach images"
                              : "Ask anything, @tag files/folders, or use / to show available commands"
                    }
                    disabled={isConnecting || isComposerApprovalState}
                  />
                </div>

                {/* Bottom toolbar */}
                {activePendingApproval ? (
                  <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                    <ComposerPendingApprovalActions
                      requestId={activePendingApproval.requestId}
                      isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                      onRespondToApproval={onRespondToApproval}
                    />
                  </div>
                ) : (
                  <div
                    data-chat-composer-footer="true"
                    className={cn(
                      "flex items-center justify-between px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                      isComposerFooterCompact
                        ? "gap-1.5"
                        : "flex-wrap gap-2 sm:flex-nowrap sm:gap-0",
                    )}
                  >
                    <div
                      className={cn(
                        "flex min-w-0 flex-1 items-center",
                        isComposerFooterCompact
                          ? "gap-1 overflow-hidden"
                          : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                      )}
                    >
                      {/* Provider/model picker */}
                      <ProviderModelPicker
                        compact={isComposerFooterCompact}
                        provider={selectedProvider}
                        model={selectedModelForPickerWithCustomFallback}
                        lockedProvider={lockedProvider}
                        modelOptionsByProvider={modelOptionsByProvider}
                        onProviderModelChange={onProviderModelSelect}
                      />

                      {isComposerFooterCompact ? (
                        <>
                          {selectedProvider === "opencode" ? (
                            <OpenCodeAgentPicker
                              agents={visibleOpenCodeAgents}
                              selectedAgent={selectedOpenCodeAgent}
                              onAgentChange={onOpenCodeAgentSelect}
                              compact
                              isLoading={openCodeAgentsQuery.isLoading}
                              errorMessage={openCodeAgentsErrorMessage}
                            />
                          ) : null}
                          <CompactComposerControlsMenu
                            activePlan={Boolean(
                              activePlan || activeProposedPlan || planSidebarOpen,
                            )}
                            interactionMode={effectiveInteractionMode}
                            planSidebarOpen={planSidebarOpen}
                            runtimeMode={runtimeMode}
                            selectedEffort={selectedEffort}
                            selectedProvider={selectedProvider}
                            selectedCodexFastModeEnabled={selectedCodexFastModeEnabled}
                            reasoningOptions={reasoningOptions}
                            onEffortSelect={onEffortSelect}
                            onCodexFastModeChange={onCodexFastModeChange}
                            onToggleInteractionMode={toggleInteractionMode}
                            onTogglePlanSidebar={togglePlanSidebar}
                            onToggleRuntimeMode={toggleRuntimeMode}
                          />
                        </>
                      ) : (
                        <>
                          {selectedProvider === "codex" && selectedEffort != null ? (
                            <>
                              <Separator
                                orientation="vertical"
                                className="mx-0.5 hidden h-4 sm:block"
                              />
                              <CodexTraitsPicker
                                effort={selectedEffort}
                                fastModeEnabled={selectedCodexFastModeEnabled}
                                options={reasoningOptions}
                                onEffortChange={onEffortSelect}
                                onFastModeChange={onCodexFastModeChange}
                              />
                            </>
                          ) : null}

                          {selectedProvider === "opencode" ? (
                            <>
                              <Separator
                                orientation="vertical"
                                className="mx-0.5 hidden h-4 sm:block"
                              />
                              <OpenCodeAgentPicker
                                agents={visibleOpenCodeAgents}
                                selectedAgent={selectedOpenCodeAgent}
                                onAgentChange={onOpenCodeAgentSelect}
                                isLoading={openCodeAgentsQuery.isLoading}
                                errorMessage={openCodeAgentsErrorMessage}
                              />
                            </>
                          ) : null}

                          {selectedProvider === "opencode" &&
                          selectedOpenCodeModelVariants.length > 0 ? (
                            <>
                              <Separator
                                orientation="vertical"
                                className="mx-0.5 hidden h-4 sm:block"
                              />
                              <OpenCodeVariantPicker
                                selectedVariant={selectedOpenCodeVariant}
                                variants={selectedOpenCodeModelVariants}
                                onVariantChange={onOpenCodeVariantSelect}
                              />
                            </>
                          ) : null}

                          {selectedProvider === "opencode" ? (
                            <>
                              <Separator
                                orientation="vertical"
                                className="mx-0.5 hidden h-4 sm:block"
                              />
                              <OpenCodeQuestionsPicker
                                allowQuestions={selectedOpenCodeAllowQuestions}
                                onAllowQuestionsChange={onOpenCodeAllowQuestionsChange}
                              />
                            </>
                          ) : null}

                          {selectedProvider !== "opencode" ? (
                            <>
                              <Separator
                                orientation="vertical"
                                className="mx-0.5 hidden h-4 sm:block"
                              />

                              <Button
                                variant="ghost"
                                className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                                size="sm"
                                type="button"
                                onClick={toggleInteractionMode}
                                title={
                                  interactionMode === "plan"
                                    ? "Plan mode — click to return to normal chat mode"
                                    : "Default mode — click to enter plan mode"
                                }
                              >
                                <BotIcon />
                                <span className="sr-only sm:not-sr-only">
                                  {interactionMode === "plan" ? "Mode: Plan" : "Mode: Chat"}
                                </span>
                              </Button>
                            </>
                          ) : null}

                          <Separator
                            orientation="vertical"
                            className="mx-0.5 hidden h-4 sm:block"
                          />

                          <Button
                            variant="ghost"
                            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                            size="sm"
                            type="button"
                            onClick={() =>
                              void handleRuntimeModeChange(
                                runtimeMode === "full-access" ? "approval-required" : "full-access",
                              )
                            }
                            title={
                              runtimeMode === "full-access"
                                ? "Full access — click to require approvals"
                                : "Approval required — click for full access"
                            }
                          >
                            {runtimeMode === "full-access" ? <LockOpenIcon /> : <LockIcon />}
                            <span className="sr-only sm:not-sr-only">
                              {runtimeMode === "full-access" ? "Full access" : "Supervised"}
                            </span>
                          </Button>

                          {activePlan || activeProposedPlan || planSidebarOpen ? (
                            <>
                              <Separator
                                orientation="vertical"
                                className="mx-0.5 hidden h-4 sm:block"
                              />
                              <Button
                                variant="ghost"
                                className={cn(
                                  "shrink-0 whitespace-nowrap px-2 sm:px-3",
                                  planSidebarOpen
                                    ? "text-blue-400 hover:text-blue-300"
                                    : "text-muted-foreground/70 hover:text-foreground/80",
                                )}
                                size="sm"
                                type="button"
                                onClick={togglePlanSidebar}
                                title={planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
                              >
                                <ListTodoIcon />
                                <span className="sr-only sm:not-sr-only">Plan</span>
                              </Button>
                            </>
                          ) : null}
                        </>
                      )}
                    </div>

                    {/* Right side: send / stop button */}
                    <div
                      data-chat-composer-actions="right"
                      className="flex shrink-0 items-center gap-2"
                    >
                      {isPreparingWorktree ? (
                        <span className="text-muted-foreground/70 text-xs">
                          Preparing worktree...
                        </span>
                      ) : null}
                      {activePendingProgress ? (
                        <div className="flex items-center gap-2">
                          {activePendingProgress.questionIndex > 0 ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-full"
                              onClick={onPreviousActivePendingUserInputQuestion}
                              disabled={activePendingIsResponding}
                            >
                              Previous
                            </Button>
                          ) : null}
                          <Button
                            type="submit"
                            size="sm"
                            className="rounded-full px-4"
                            disabled={
                              activePendingIsResponding ||
                              (activePendingProgress.isLastQuestion
                                ? !activePendingResolvedAnswers
                                : !activePendingProgress.canAdvance)
                            }
                          >
                            {activePendingIsResponding
                              ? "Submitting..."
                              : activePendingProgress.isLastQuestion
                                ? "Submit answers"
                                : "Next question"}
                          </Button>
                        </div>
                      ) : phase === "running" ? (
                        <div className="flex items-center gap-1.5">
                          {/* Queue button — appears when user has typed content while LLM is running.
                              Submits the form which routes into the queue path in onSend. */}
                          {composerSendState.hasSendableContent && (
                            <button
                              type="submit"
                              className="flex size-8 cursor-pointer items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-all duration-150 hover:bg-accent hover:text-accent-foreground hover:scale-105 sm:h-8 sm:w-8"
                              aria-label="Add to queue"
                            >
                              <ClockIcon className="size-3.5" />
                            </button>
                          )}
                          {/* Stop button */}
                          <button
                            type="button"
                            className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105 sm:h-8 sm:w-8"
                            onClick={() => void onInterrupt()}
                            aria-label="Stop generation"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <rect x="2" y="2" width="8" height="8" rx="1.5" />
                            </svg>
                          </button>
                        </div>
                      ) : pendingUserInputs.length === 0 ? (
                        showPlanFollowUpPrompt ? (
                          prompt.trim().length > 0 ? (
                            <Button
                              type="submit"
                              size="sm"
                              className="h-9 rounded-full px-4 sm:h-8"
                              disabled={isSendBusy || isConnecting}
                            >
                              {isConnecting || isSendBusy ? "Sending..." : "Refine"}
                            </Button>
                          ) : (
                            <div className="flex items-center">
                              <Button
                                type="submit"
                                size="sm"
                                className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                                disabled={isSendBusy || isConnecting}
                              >
                                {isConnecting || isSendBusy ? "Sending..." : "Implement"}
                              </Button>
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <Button
                                      size="sm"
                                      variant="default"
                                      className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                                      aria-label="Implementation actions"
                                      disabled={isSendBusy || isConnecting}
                                    />
                                  }
                                >
                                  <ChevronDownIcon className="size-3.5" />
                                </MenuTrigger>
                                <MenuPopup align="end" side="top">
                                  <MenuItem
                                    disabled={isSendBusy || isConnecting}
                                    onClick={() => void onImplementPlanInNewThread()}
                                  >
                                    Implement in a new thread
                                  </MenuItem>
                                </MenuPopup>
                              </Menu>
                            </div>
                          )
                        ) : (
                          <button
                            type="submit"
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
                            disabled={
                              isSendBusy || isConnecting || !composerSendState.hasSendableContent
                            }
                            aria-label={
                              isConnecting
                                ? "Connecting"
                                : isPreparingWorktree
                                  ? "Preparing worktree"
                                  : isSendBusy
                                    ? "Sending"
                                    : "Send message"
                            }
                          >
                            {isConnecting || isSendBusy ? (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 14 14"
                                fill="none"
                                className="animate-spin"
                                aria-hidden="true"
                              >
                                <circle
                                  cx="7"
                                  cy="7"
                                  r="5.5"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeDasharray="20 12"
                                />
                              </svg>
                            ) : (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 14 14"
                                fill="none"
                                aria-hidden="true"
                              >
                                <path
                                  d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </form>
          </div>

          {isGitRepo && (
            <BranchToolbar
              threadId={activeThread.id}
              provider={selectedProvider}
              onEnvModeChange={onEnvModeChange}
              envLocked={envLocked}
              onComposerFocusRequest={scheduleComposerFocus}
              {...(canCheckoutPullRequestIntoThread
                ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                : {})}
            />
          )}
          {pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              cwd={activeProject?.cwd ?? null}
              initialReference={pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  closePullRequestDialog();
                }
              }}
              onPrepared={handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
        {/* end chat column */}

        {/* Plan sidebar */}
        {planSidebarOpen ? (
          <PlanSidebar
            activePlan={activePlan}
            activeProposedPlan={activeProposedPlan}
            markdownCwd={gitCwd ?? undefined}
            workspaceRoot={activeProject?.cwd ?? undefined}
            timestampFormat={timestampFormat}
            onClose={() => {
              setPlanSidebarOpen(false);
              // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
              const turnKey = activePlan?.turnId ?? activeProposedPlan?.turnId ?? null;
              if (turnKey) {
                planSidebarDismissedForTurnRef.current = turnKey;
              }
            }}
          />
        ) : null}

        {/* Dev logs panel — resizable */}
        {devLogsOpen && activeProject ? (
          <div className="flex min-h-0 shrink-0" style={{ width: devLogsPanelWidth }}>
            {/* Drag handle on the left edge — drag left to expand */}
            <div
              className="w-1 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-primary/40 active:bg-primary/60"
              onMouseDown={handleResizeMouseDown}
            />
            <DevLogsPanel
              logs={devServerLogsByProjectId[activeProject.id] ?? []}
              status={devServerByProjectId[activeProject.id]?.status}
              error={devServerByProjectId[activeProject.id]?.error}
              recoveryHint={devServerByProjectId[activeProject.id]?.recoveryHint}
              conflictingPid={devServerByProjectId[activeProject.id]?.conflictingPid}
              serverUrl={devServerByProjectId[activeProject.id]?.url}
              packageManager={devServerByProjectId[activeProject.id]?.packageManager}
              projectName={activeProject.name}
              onPopout={() => void handlePopout()}
              onRestart={handleDevServerRestart}
              className="min-w-0 flex-1 border-l border-border"
            />
          </div>
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {(() => {
        if (!terminalState.terminalOpen || !activeProject) {
          return null;
        }
        return (
          <ThreadTerminalDrawer
            key={activeThread.id}
            threadId={activeThread.id}
            cwd={gitCwd ?? activeProject.cwd}
            runtimeEnv={threadTerminalRuntimeEnv}
            height={terminalState.terminalHeight}
            terminalIds={terminalState.terminalIds}
            activeTerminalId={terminalState.activeTerminalId}
            terminalGroups={terminalState.terminalGroups}
            activeTerminalGroupId={terminalState.activeTerminalGroupId}
            focusRequestId={terminalFocusRequestId}
            onSplitTerminal={splitTerminal}
            onNewTerminal={createNewTerminal}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            onActiveTerminalChange={activateTerminal}
            onCloseTerminal={closeTerminal}
            onHeightChange={setTerminalHeight}
            onAddTerminalContext={addTerminalContextToDraft}
          />
        );
      })()}

      {expandedImage && expandedImageItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
        >
          <button
            type="button"
            className="absolute inset-0 z-0 cursor-zoom-out"
            aria-label="Close image preview"
            onClick={closeExpandedImage}
          />
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
              aria-label="Previous image"
              onClick={() => {
                navigateExpandedImage(-1);
              }}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          )}
          <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-2 top-2"
              onClick={closeExpandedImage}
              aria-label="Close image preview"
            >
              <XIcon />
            </Button>
            <img
              src={expandedImageItem.src}
              alt={expandedImageItem.name}
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
              draggable={false}
            />
            <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
              {expandedImageItem.name}
              {expandedImage.images.length > 1
                ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
                : ""}
            </p>
          </div>
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
              aria-label="Next image"
              onClick={() => {
                navigateExpandedImage(1);
              }}
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const OpenCodeAgentPicker = memo(function OpenCodeAgentPicker(props: {
  agents: ReadonlyArray<OpenCodeComposerAgent>;
  selectedAgent: string | null;
  onAgentChange: (agent: string) => void;
  compact?: boolean;
  isLoading?: boolean;
  errorMessage?: string | null;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const selectedLabel = props.isLoading
    ? "Loading..."
    : props.errorMessage
      ? "Agents unavailable"
      : props.selectedAgent
        ? formatOpenCodeAgentLabel(props.selectedAgent)
        : props.agents.length > 0
          ? "Agent"
          : "No agents";

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
              props.compact ? "max-w-34" : undefined,
            )}
          />
        }
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Agents</div>
          {props.isLoading ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Loading OpenCode agents...
            </div>
          ) : null}
          {!props.isLoading && props.errorMessage ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{props.errorMessage}</div>
          ) : null}
          {!props.isLoading && !props.errorMessage && props.agents.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No OpenCode agents found
            </div>
          ) : null}
          <MenuRadioGroup
            value={props.selectedAgent ?? ""}
            onValueChange={(value) => {
              if (!value) return;
              props.onAgentChange(value);
              setIsMenuOpen(false);
            }}
          >
            {props.agents.map((agent) => (
              <MenuRadioItem
                key={agent.name}
                value={agent.name}
                onClick={() => setIsMenuOpen(false)}
              >
                {formatOpenCodeAgentLabel(agent.name)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

const OpenCodeVariantPicker = memo(function OpenCodeVariantPicker(props: {
  selectedVariant: string | null;
  variants: ReadonlyArray<string>;
  onVariantChange: (variant: string | null) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const selectedLabel = props.selectedVariant ?? "Default";

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
          />
        }
      >
        <span>{selectedLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Variant</div>
          <MenuRadioGroup
            value={props.selectedVariant ?? "default"}
            onValueChange={(value) => {
              props.onVariantChange(value === "default" ? null : value);
              setIsMenuOpen(false);
            }}
          >
            <MenuRadioItem value="default" onClick={() => setIsMenuOpen(false)}>
              Default
            </MenuRadioItem>
            {props.variants.map((variant) => (
              <MenuRadioItem key={variant} value={variant} onClick={() => setIsMenuOpen(false)}>
                {variant}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

const OpenCodeQuestionsPicker = memo(function OpenCodeQuestionsPicker(props: {
  allowQuestions: boolean;
  onAllowQuestionsChange: (allowQuestions: boolean) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
          />
        }
      >
        <span>{props.allowQuestions ? "Questions on" : "Questions off"}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Questions</div>
          <MenuRadioGroup
            value={props.allowQuestions ? "on" : "off"}
            onValueChange={(value) => {
              props.onAllowQuestionsChange(value === "on");
              setIsMenuOpen(false);
            }}
          >
            <MenuRadioItem value="on" onClick={() => setIsMenuOpen(false)}>
              Allow
            </MenuRadioItem>
            <MenuRadioItem value="off" onClick={() => setIsMenuOpen(false)}>
              Block
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
