import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GitForkIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "~/lib/utils";

export interface ForkModelOption {
  slug: string;
  name: string;
}

interface MessageForkButtonProps {
  messageText: string;
  preFillContent: boolean;
  defaultNavigate: boolean;
  modelOptions: ReadonlyArray<ForkModelOption>;
  defaultModel: string;
  disabled?: boolean;
  /** Called whenever the fork panel opens or closes. Used by the parent to
   *  pin the action-bar visible while the panel (or its portal dropdown) is
   *  active, so `opacity-0 group-hover:opacity-100` doesn't hide the bar. */
  onOpenChange?: (open: boolean) => void;
  onFork: (prompt: string, navigate: boolean, model: string) => void;
}

const MIN_HEIGHT = 24; // ≈ 1 line of text-sm + leading-relaxed
const MIN_PANEL_WIDTH = 280;
// px-4 on both sides (32px) + comfortable padding for the measure ghost
const PANEL_PADDING_PX = 64;
// minimum gap between the panel's left edge and the scroll-clip ancestor
const PANEL_EDGE_GUTTER = 16;
const GROW_ANIMATION_MS = 130;

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveChatContentMaxWidthPx(): number {
  if (typeof window === "undefined") return MIN_PANEL_WIDTH;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--chat-content-max-width")
    .trim();
  if (!raw) return MIN_PANEL_WIDTH;
  if (raw.endsWith("rem")) {
    const rootFs = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return Number.parseFloat(raw) * rootFs;
  }
  if (raw.endsWith("px")) return Number.parseFloat(raw);
  return Number.parseFloat(raw) || MIN_PANEL_WIDTH;
}

function findScrollClipAncestor(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    const { overflowX, overflow } = getComputedStyle(cur);
    if (/(hidden|clip|auto|scroll)/.test(overflowX) || /(hidden|clip|auto|scroll)/.test(overflow))
      return cur;
    cur = cur.parentElement;
  }
  return null;
}

// ── Component ────────────────────────────────────────────────────────────────

export const MessageForkButton = memo(function MessageForkButton({
  messageText,
  preFillContent,
  defaultNavigate,
  modelOptions,
  defaultModel,
  disabled = false,
  onOpenChange,
  onFork,
}: MessageForkButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [navigate, setNavigate] = useState(defaultNavigate);
  const [selectedModel, setSelectedModel] = useState(defaultModel);

  // panelWidth drives the inline `width` style; starts at min and grows as text expands
  const [panelWidth, setPanelWidth] = useState(MIN_PANEL_WIDTH);
  // bumped on window resize to re-run the width layout-effect
  const [layoutTick, setLayoutTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // invisible ghost span that mirrors textarea font — lets us measure text width
  const measureRef = useRef<HTMLSpanElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // FLIP: remember the panel's previous pixel size so we can animate from it
  const prevSizeRef = useRef<{ w: number; h: number } | null>(null);
  const growAnimRef = useRef<Animation | null>(null);

  // ── Outside-click detection ───────────────────────────────────────────────
  // SelectPopup renders into a Portal (document.body), outside the React root
  // container. React's event delegation lives on #root, so onMouseDownCapture
  // on panelRef never fires for portal clicks. Instead: track whether the
  // Select dropdown is open and skip the close handler while it is.
  const [selectOpen, setSelectOpen] = useState(false);

  // Sync defaults when closed
  useEffect(() => {
    if (!isOpen) {
      setNavigate(defaultNavigate);
      setSelectedModel(defaultModel);
    }
  }, [defaultNavigate, defaultModel, isOpen]);

  // Re-run width layout on viewport resize
  useEffect(() => {
    if (!isOpen) return;
    const handler = () => setLayoutTick((t) => t + 1);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [isOpen]);

  // The longest line drives how wide the panel wants to be before wrapping.
  const longestLine = useMemo(() => {
    const lines = prompt.split(/\r?\n/);
    return lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  }, [prompt]);

  // ── Single layout effect: width → height → FLIP ───────────────────────────
  //
  // WHY one effect instead of three:
  // React layout effects run synchronously in declaration order within the same
  // commit, but `setPanelWidth` (a state update) is batched — the new value is
  // NOT visible to sibling effects in the same commit. If width and height were
  // separate effects the height effect would see the OLD panelWidth and measure
  // textarea wrap based on the previous (narrower) width, so height would grow
  // first and width second — the opposite of what we want.
  //
  // By merging into one effect we guarantee this exact order per keystroke:
  //   1. Width written directly to the DOM (panelEl.style.width)
  //   2. Textarea height measured with the new width already in the DOM
  //   3. FLIP reads the final committed size after both mutations
  //   4. setPanelWidth syncs React state so future renders keep the right value
  useLayoutEffect(() => {
    if (!isOpen) {
      prevSizeRef.current = null;
      growAnimRef.current?.cancel();
      growAnimRef.current = null;
      setPanelWidth(MIN_PANEL_WIDTH);
      return;
    }

    const rootEl = rootRef.current;
    const measureEl = measureRef.current;
    const textareaEl = textareaRef.current;
    const panelEl = panelRef.current;
    if (!rootEl || !measureEl || !textareaEl || !panelEl) return;

    // 0. Snapshot previous size for FLIP — must happen before any DOM mutation
    const prev = prevSizeRef.current;

    // 1. Calculate new width
    const clipAncestor = findScrollClipAncestor(rootEl);
    const triggerRect = rootEl.getBoundingClientRect();
    const containerLeft = clipAncestor
      ? clipAncestor.getBoundingClientRect().left
      : PANEL_EDGE_GUTTER;
    const availableWidth = Math.floor(triggerRect.right - containerLeft - PANEL_EDGE_GUTTER);
    // Mirror the textarea's exact computed font onto the ghost span so our
    // width measurement matches the browser's line-break decision 1:1.
    const textareaStyles = getComputedStyle(textareaEl);
    measureEl.style.font = textareaStyles.font;
    measureEl.style.letterSpacing = textareaStyles.letterSpacing;

    const chatMax = Math.floor(resolveChatContentMaxWidthPx());
    const maxWidth = Math.min(chatMax, availableWidth);
    const textPx = Math.ceil(measureEl.getBoundingClientRect().width);
    const nextWidth = Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, textPx + PANEL_PADDING_PX));

    // 2. Write width to DOM directly — forces reflow so step 3 measures the
    //    correct scrollHeight for the new wrap point (width-first growth).
    panelEl.style.width = `${nextWidth}px`;

    // 3. Measure and apply textarea height (new width is already in DOM)
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${Math.max(textareaEl.scrollHeight, MIN_HEIGHT)}px`;

    // 4. FLIP: animate from previous shape to current shape
    const next = { w: panelEl.offsetWidth, h: panelEl.offsetHeight };
    if (prev && (Math.abs(prev.w - next.w) > 1 || Math.abs(prev.h - next.h) > 1)) {
      growAnimRef.current?.cancel();
      const scaleX = next.w > 0 ? prev.w / next.w : 1;
      const scaleY = next.h > 0 ? prev.h / next.h : 1;
      growAnimRef.current = panelEl.animate(
        [
          { transform: `scale(${scaleX}, ${scaleY})`, transformOrigin: "bottom right" },
          { transform: "scale(1, 1)", transformOrigin: "bottom right" },
        ],
        { duration: GROW_ANIMATION_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "none" },
      );
    }
    prevSizeRef.current = next;

    // 5. Sync React state so JSX style={{ width }} stays in agreement with DOM
    setPanelWidth(nextWidth);
  }, [isOpen, longestLine, layoutTick, prompt, selectedModel, navigate]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    setNavigate(defaultNavigate);
    setSelectedModel(defaultModel);
    setPrompt(preFillContent ? messageText : "");
    onOpenChange?.(true);
  }, [defaultNavigate, defaultModel, preFillContent, messageText, onOpenChange]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setSelectOpen(false);
    setPrompt("");
    prevSizeRef.current = null;
    onOpenChange?.(false);
  }, [onOpenChange]);

  const handleSubmit = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onFork(trimmed, navigate, selectedModel);
    handleClose();
  }, [prompt, navigate, selectedModel, onFork, handleClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    },
    [handleSubmit, handleClose],
  );

  // Focus once on open
  const didFocusRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      didFocusRef.current = false;
      return;
    }
    if (didFocusRef.current) return;
    didFocusRef.current = true;
    const id = setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      if (preFillContent && el.value) el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
    }, 50);
    return () => clearTimeout(id);
  }, [isOpen, preFillContent]);

  // Outside-click: close the panel when the user clicks outside the panel div.
  // While the Select dropdown is open we skip closing — the dropdown lives in a
  // Portal outside panelRef's DOM subtree, so contains() would incorrectly
  // return false for clicks inside it.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (selectOpen) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      handleClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, selectOpen, handleClose]);

  const selectedModelLabel =
    modelOptions.find((o) => o.slug === selectedModel)?.name ?? selectedModel;

  return (
    <div ref={rootRef} className="relative">
      {/* ── Fork composer panel ─────────────────────────────────────── */}
      {isOpen && (
        <div
          ref={panelRef}
          className={cn(
            "absolute bottom-[calc(100%+8px)] right-0 z-20",
            "rounded-[20px] border border-border bg-card shadow-lg",
            "transition-colors duration-200 focus-within:border-ring/45",
            // will-change lets the compositor promote this layer for the FLIP animation
            "will-change-transform origin-bottom-right animate-fork-expand",
          )}
          style={{ width: `${panelWidth}px` }}
        >
          {/* Ghost span — mirrors textarea font, used to measure text width.
              Lives inside the panel so it inherits the same rem/font context.
              Invisible, not in the tab order, never clips anything. */}
          <span
            ref={measureRef}
            aria-hidden="true"
            className="pointer-events-none absolute -z-10 inline-block w-max max-w-none whitespace-pre text-sm leading-relaxed opacity-0"
            style={{ left: 16, top: 14 }}
          >
            {longestLine || " "}
          </span>

          {/* Textarea — grows/shrinks via useLayoutEffect; no wrapper needed */}
          <div className="px-4 pb-2 pt-3.5">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter new prompt…"
              rows={1}
              style={{
                height: MIN_HEIGHT,
                // overflow:hidden prevents scrollbar; height is driven by JS
                overflow: "hidden",
              }}
              className="block w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>

          {/* Footer */}
          <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2">
            {modelOptions.length > 0 && (
              <Select
                value={selectedModel}
                onValueChange={(v) => setSelectedModel(String(v))}
                open={selectOpen}
                onOpenChange={setSelectOpen}
              >
                <SelectTrigger
                  size="xs"
                  className="min-w-0 flex-1 border-border/60 bg-transparent text-xs text-muted-foreground hover:text-foreground"
                >
                  <SelectValue placeholder="Model">
                    <span className="truncate">{selectedModelLabel}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" side="top" sideOffset={6}>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.slug} value={opt.slug}>
                      {opt.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}

            <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5">
              <input
                type="checkbox"
                checked={navigate}
                onChange={(e) => setNavigate(e.target.checked)}
                className="size-3.5 cursor-pointer accent-primary"
              />
              <span className="text-xs text-muted-foreground">Navigate</span>
            </label>

            <button
              type="button"
              disabled={!prompt.trim()}
              onClick={handleSubmit}
              aria-label="Fork conversation from here"
              title="Fork (Enter)"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Trigger button ───────────────────────────────────────────── */}
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={isOpen ? handleClose : handleOpen}
        title={disabled ? "Fork is only available for OpenCode threads" : "Fork from this message"}
        className={cn(isOpen && "border-primary/50 bg-primary/5 text-primary")}
      >
        <GitForkIcon className="size-3" />
      </Button>
    </div>
  );
});
