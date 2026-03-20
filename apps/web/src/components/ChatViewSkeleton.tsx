import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { Skeleton } from "./ui/skeleton";

/**
 * Full-layout skeleton for the chat view.
 *
 * Mirrors the real ChatView structure:
 *   - Header  (drag-region in Electron, border-b)
 *   - Messages area (flex-1, scrollable)
 *   - Composer card (rounded-[20px] border bg-card — matches the real Lexical composer)
 */
export function ChatViewSkeleton() {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      role="status"
      aria-label="Lade Unterhaltung..."
    >
      {/* Header — exact classes from real ChatView header */}
      <header
        className={cn(
          "flex shrink-0 items-center border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region h-[52px]" : "py-2 sm:py-3",
        )}
      >
        <ChatHeaderSkeleton />
      </header>

      {/* Messages — same padding as real scroll container (px-3 py-3 sm:px-5 sm:py-4) */}
      <div className="min-h-0 flex-1 overflow-hidden px-3 py-3 sm:px-5 sm:py-4">
        <ChatViewMessagesSkeleton />
      </div>

      {/* Composer — matches real input bar wrapper (px-3 pt-1.5 pb-3 sm:px-5 sm:pt-2 sm:pb-4) */}
      <div className="shrink-0 px-3 pb-3 pt-1.5 sm:px-5 sm:pb-4 sm:pt-2">
        <ComposerCardSkeleton />
      </div>
    </div>
  );
}

/**
 * Messages skeleton — only the scrollable content area.
 * Used in ChatView while message history is being fetched.
 *
 * Design rules matching the real MessagesTimeline:
 *  - Container: mx-auto w-full max-w-3xl (line 618 in MessagesTimeline)
 *  - User bubble: max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3 (line 398)
 *  - Assistant: no bubble, px-1 py-0.5, text-sm leading-relaxed (line 485)
 *  - Pinned to bottom via justify-end min-h-full → no layout shift when real messages arrive
 */
export function ChatViewMessagesSkeleton() {
  return (
    <div className="flex min-h-full flex-col justify-end">
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6">
        {/* Assistant message 1 — multi-paragraph */}
        <AssistantMsgSkeleton lines={["w-full", "w-10/12", "w-8/12", "w-full", "w-9/12"]} />

        {/* User message 1 — short */}
        <UserMsgSkeleton lines={["w-44"]} />

        {/* Assistant message 2 */}
        <AssistantMsgSkeleton lines={["w-full", "w-11/12", "w-7/12"]} />

        {/* User message 2 — two lines */}
        <UserMsgSkeleton lines={["w-52", "w-36"]} />

        {/* Assistant message 3 — still loading, trailing off */}
        <AssistantMsgSkeleton lines={["w-full", "w-10/12"]} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal sub-skeletons
// ---------------------------------------------------------------------------

function ChatHeaderSkeleton() {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <Skeleton className="size-7 shrink-0 rounded-md md:hidden" />
        <Skeleton className="h-4 w-36 shrink rounded-sm" />
        <Skeleton className="h-5 w-20 shrink rounded-full" />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
      </div>
    </div>
  );
}

/**
 * Assistant message skeleton.
 * No bubble — just text lines in px-1 py-0.5, matching real ChatMarkdown output.
 * Line height h-4 (16px) + gap-[9px] approximates text-sm leading-relaxed.
 */
function AssistantMsgSkeleton({ lines }: { lines: string[] }) {
  return (
    <div className="min-w-0 px-1 py-0.5">
      <div className="flex flex-col gap-[9px]">
        {lines.map((w, i) => (
          // Static list — order never changes
          // eslint-disable-next-line react/no-array-index-key
          <Skeleton key={i} className={cn("h-4 rounded-sm", w)} />
        ))}
      </div>
      {/* Timestamp — matches mt-1.5 text-[10px] text-muted-foreground/30 */}
      <div className="mt-2">
        <Skeleton className="h-2.5 w-24 rounded-sm opacity-40" />
      </div>
    </div>
  );
}

/**
 * User message bubble skeleton.
 * Matches real bubble exactly: flex justify-end, max-w-[80%], rounded-2xl rounded-br-sm,
 * border border-border bg-secondary, px-4 py-3 (MessagesTimeline line 398).
 * `lines` are the text lines inside the bubble — pass 1 for short, 2 for multi-line.
 */
function UserMsgSkeleton({ lines }: { lines: string[] }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
        <div className="flex flex-col gap-[9px]">
          {lines.map((w, i) => (
            // Static list — order never changes
            // eslint-disable-next-line react/no-array-index-key
            <Skeleton key={i} className={cn("h-4 rounded-sm", w)} />
          ))}
        </div>
        {/* Timestamp row — matches mt-1.5 flex items-center justify-end */}
        <div className="mt-2 flex justify-end">
          <Skeleton className="h-2.5 w-16 rounded-sm opacity-40" />
        </div>
      </div>
    </div>
  );
}

/**
 * Composer skeleton that matches the real Lexical composer card:
 *
 *   rounded-[20px] border border-border bg-card
 *   ├── Textarea area (px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4)
 *   │    └── min-h-[70px] input space  (matches min-h-17.5 on the real editor)
 *   └── Bottom toolbar (px-2.5 pb-2.5 sm:px-3 sm:pb-3)
 *        ├── Left: model pill + effort pill + mode pill
 *        └── Right: circular send button
 */
function ComposerCardSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[var(--chat-content-max-width,100%)]">
      <div className="rounded-[20px] border border-border bg-card">
        {/* Textarea area */}
        <div className="px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
          {/* Token count pill — visible in the real composer */}
          <div className="mb-3">
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          {/* Empty textarea space — min-h-[70px] matches min-h-17.5 on ComposerPromptEditor */}
          <div className="min-h-[70px]" />
        </div>

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-2.5 pb-2.5 sm:px-3 sm:pb-3">
          {/* Left: model + effort + mode controls */}
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-20 rounded-md" />
            <Skeleton className="h-6 w-14 rounded-md" />
            <Skeleton className="h-6 w-[88px] rounded-md" />
          </div>
          {/* Right: send button — real button is a circle (rounded-full) */}
          <Skeleton className="size-8 rounded-full" />
        </div>
      </div>
    </div>
  );
}
