import { ChevronDownIcon, ClockIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface QueuedMessage {
  /** Stable client-generated ID for this queue entry. */
  id: string;
  /**
   * Full message text (already has terminal contexts appended via
   * appendTerminalContextsToPrompt — exactly what will be sent to the API).
   */
  text: string;
  /**
   * First non-empty line of `text`, used as the truncated label in the dock.
   * Pre-computed at queue time so the dock doesn't have to parse.
   */
  preview: string;
}

interface ComposerQueueDockProps {
  items: QueuedMessage[];
  /** True while the first queued item is being sent (sendPhase !== "idle"). */
  isSending: boolean;
  onRemove: (id: string) => void;
}

/**
 * Tray rendered directly above the composer card while messages are waiting.
 *
 * Visually merges with the composer card below it:
 *  - Same rounded-[20px] top radius as the composer card
 *  - rounded-b-none so the bottom is flat — the composer card continues below
 *  - border-b-0 removes the shared edge; the composer card's top border acts
 *    as the divider between the two sections
 *  - Same bg-card / border-border so both appear as one unified panel
 *
 * UX model (same as OpenCode's SessionFollowupDock):
 *  - Shows "N in queue" header with collapse/expand toggle
 *  - Each item shows position number, truncated preview, and Remove button
 *  - Items are sent FIFO automatically once the LLM finishes its turn
 */
export const ComposerQueueDock = memo(function ComposerQueueDock({
  items,
  isSending,
  onRemove,
}: ComposerQueueDockProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0) return null;

  const label = items.length === 1 ? "1 message in queue" : `${items.length} messages in queue`;

  return (
    <div aria-label="Queued messages" role="region">
      {/* Matches the composer card exactly: same rounded-[20px] top, border-border bg-card.
          Bottom radius removed + border-b removed so it flows into the composer card. */}
      <div className="rounded-t-[20px] rounded-b-none border border-b-0 border-border bg-card">
        {/* Header row */}
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <ClockIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span className="flex-1 text-xs font-medium text-muted-foreground/80">{label}</span>
          {isSending && <span className="text-[10px] text-muted-foreground/50">Sending…</span>}
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150",
              collapsed && "rotate-180",
            )}
          />
        </button>

        {/* Items list */}
        {!collapsed && (
          <ul className="flex max-h-36 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
            {items.map((item, index) => (
              <li key={item.id} className="flex min-w-0 items-center gap-2 py-0.5">
                {/* Position indicator */}
                <span className="w-4 shrink-0 text-center text-[10px] text-muted-foreground/35">
                  {index + 1}
                </span>

                {/* Message preview */}
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
                  {item.preview || "(empty)"}
                </span>

                {/* Sending indicator for first item */}
                {index === 0 && isSending && (
                  <span className="shrink-0 text-[10px] text-muted-foreground/50">sending…</span>
                )}

                {/* Remove button — disabled while the item is actively being sent */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 shrink-0 text-muted-foreground/40 hover:text-muted-foreground"
                  disabled={index === 0 && isSending}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(item.id);
                  }}
                  aria-label="Remove from queue"
                >
                  <XIcon className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
