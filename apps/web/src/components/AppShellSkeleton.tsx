import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { ChatViewSkeleton } from "./ChatViewSkeleton";
import { Skeleton } from "./ui/skeleton";

/**
 * Full two-panel app shell skeleton.
 *
 * Shown while the WebSocket NativeApi is not yet available (root connect state).
 * Mirrors the real _chat.tsx layout: SidebarProvider → Sidebar (left) + SidebarInset (right).
 *
 * Cannot use the real Sidebar/SidebarProvider here since those sit inside the route tree
 * which is not mounted yet at this point. Uses raw divs that match the real dimensions.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      <SidebarPanelSkeleton />
      {/* Right panel — mirrors SidebarInset */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <ChatViewSkeleton />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar panel skeleton
// Matches: <Sidebar className="bg-card border-r border-border"> + <ThreadSidebar />
// ---------------------------------------------------------------------------

function SidebarPanelSkeleton() {
  return (
    <div
      // Width mirrors CHAT_SIDEBAR_DEFAULT_WIDTH: clamp(17rem,22vw,28rem)
      className="hidden shrink-0 flex-col bg-card border-r border-border md:flex"
      style={{ width: "clamp(17rem,22vw,28rem)" }}
    >
      {/* Header — matches SidebarHeader in Electron vs web */}
      {isElectron ? (
        <div className="drag-region flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
          {/* Wordmark placeholder */}
          <Skeleton className="h-4 w-24 rounded-sm" />
          {/* Update button placeholder */}
          <Skeleton className="ml-auto size-7 rounded-md" />
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-4 sm:py-3">
          <Skeleton className="h-4 w-24 rounded-sm" />
        </div>
      )}

      {/* Thread list content area */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden px-2 py-2">
        {/* Project 1 */}
        <div className="flex items-center gap-1.5 px-1 py-1">
          <Skeleton className="size-3.5 shrink-0 rounded-sm opacity-40" />
          <Skeleton className="h-3.5 w-28 rounded-sm" />
        </div>
        {/* Threads under project 1 */}
        <ThreadRowSkeleton width="w-40" indent />
        <ThreadRowSkeleton width="w-32" indent />
        <ThreadRowSkeleton width="w-36" indent active />
        <ThreadRowSkeleton width="w-28" indent />

        {/* Project 2 */}
        <div className="mt-2 flex items-center gap-1.5 px-1 py-1">
          <Skeleton className="size-3.5 shrink-0 rounded-sm opacity-40" />
          <Skeleton className="h-3.5 w-20 rounded-sm" />
        </div>
        {/* Threads under project 2 */}
        <ThreadRowSkeleton width="w-44" indent />
        <ThreadRowSkeleton width="w-28" indent />
      </div>

      {/* Footer — matches SidebarFooter + settings button */}
      <div className="shrink-0 border-t border-border p-2">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <Skeleton className="size-3.5 rounded-sm opacity-50" />
          <Skeleton className="h-3 w-14 rounded-sm opacity-50" />
        </div>
      </div>
    </div>
  );
}

function ThreadRowSkeleton({
  width,
  indent = false,
  active = false,
}: {
  width: string;
  indent?: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1",
        indent && "ml-5",
        active && "bg-accent/40",
      )}
    >
      <Skeleton className={cn("h-3.5 rounded-sm", width)} />
    </div>
  );
}
