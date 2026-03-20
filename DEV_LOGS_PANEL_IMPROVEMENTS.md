# Dev Logs Panel Improvements — Implementation Plan

## Overview

Three major improvements to the Dev Logs panel:

1. **ANSI colors + prefix detection** — proper terminal color rendering
2. **Resizable panel** — drag handle on the left edge
3. **Popout window** — standalone browser window that follows the active project

---

## Feature 1: ANSI Colors + Prefix Detection

### New file: `apps/web/src/lib/ansiRenderer.ts`

**ANSI color parsing:**

- Parse escape sequences `\x1b[<code>m` into styled React spans
- Supported codes: 30-37 (standard), 90-97 (bright), 1 (bold), 4 (underline), 0 (reset), 39 (fg reset)
- Color palette: One Dark Pro — looks good on dark and light backgrounds

```
30  → #282c34  (black)
31  → #e06c75  (red)
32  → #98c379  (green)
33  → #e5c07b  (yellow)
34  → #61afef  (blue)
35  → #c678dd  (magenta)
36  → #56b6c2  (cyan)
37  → #abb2bf  (white)
90-97 → bright variants
```

**Prefix detection:**

Detects monorepo/turbo style prefixes at the start of a line:

```
@scope/pkg:script:   → e.g. "@cb/database:dev:"
pkg:script:          → e.g. "server:dev:"
[tag]:               → e.g. "[vite]:"
prefix |             → e.g. "web | " (turborepo pipe format)
```

- Deterministic color via djb2 hash of the prefix string
- Palette of 8 distinct colors (rotates, hash-consistent)
- Same prefix always same color across sessions and reloads
- Prefix rendered with its color + slightly dimmed rest of line for contrast

**API:**

```ts
// Returns an array of styled React nodes for one log line
export function renderLogLine(line: string): React.ReactNode;
```

---

## Feature 2: Resizable Panel

### Changes in: `apps/web/src/components/ChatView.tsx`

Replace the fixed-width DevLogsPanel div with a resizable container:

```tsx
// State
const [devLogsPanelWidth, setDevLogsPanelWidth] = useState(() =>
  parseInt(localStorage.getItem("t3code:dev-logs-width") ?? "384", 10),
);
const devLogsPanelWidthRef = useRef(devLogsPanelWidth); // for mouseup handler closure

// Resize handler
const handleResizeMouseDown = (e: React.MouseEvent) => {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = devLogsPanelWidth;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = startX - moveEvent.clientX; // drag left → panel grows
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
};
```

Layout:

```tsx
{devLogsOpen && activeProject ? (
  <div className="flex shrink-0 min-h-0" style={{ width: devLogsPanelWidth }}>
    {/* Drag handle on the LEFT edge (user drags left to expand) */}
    <div
      className="w-1 shrink-0 cursor-col-resize bg-border/50 hover:bg-primary/40 active:bg-primary/60 transition-colors"
      onMouseDown={handleResizeMouseDown}
    />
    <DevLogsPanel
      logs={...}
      serverUrl={...}
      projectName={activeProject.name}
      onPopout={handlePopout}
      className="flex-1 min-w-0 border-l border-border"
    />
  </div>
) : null}
```

---

## Feature 3: Popout Window

### New file: `apps/web/src/lib/devLogsPopoutChannel.ts`

BroadcastChannel-based communication between main window and popout:

```ts
const CHANNEL_NAME = "t3code-dev-logs-v1";

export interface PopoutMessage {
  type: "active-project";
  projectId: string;
  projectName: string;
  devServerRunning: boolean;
}

// Used by the MAIN window — sends messages to the popout
export class PopoutBroadcaster {
  private channel = new BroadcastChannel(CHANNEL_NAME);
  send(msg: PopoutMessage): void {
    this.channel.postMessage(msg);
  }
  close(): void {
    this.channel.close();
  }
}

// Used by the POPOUT window — receives messages from the main window
export class PopoutReceiver {
  private channel = new BroadcastChannel(CHANNEL_NAME);
  onMessage(cb: (msg: PopoutMessage) => void): () => void {
    const handler = (e: MessageEvent) => cb(e.data as PopoutMessage);
    this.channel.addEventListener("message", handler);
    return () => this.channel.removeEventListener("message", handler);
  }
  close(): void {
    this.channel.close();
  }
}
```

### Changes in: `apps/web/src/components/ChatView.tsx`

**Popout handler** (opens/focuses window):

```tsx
const popoutWindowRef = useRef<Window | null>(null);
const popoutChannelRef = useRef<PopoutBroadcaster | null>(null);

const handlePopout = useCallback(() => {
  // Focus if already open
  if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
    popoutWindowRef.current.focus();
    return;
  }
  // Lazy-init broadcaster
  popoutChannelRef.current ??= new PopoutBroadcaster();

  const win = window.open(
    "/dev-logs-popout",
    "t3code-dev-logs-popout", // named window: browser focuses it if already open
    "width=960,height=720,menubar=no,toolbar=no,location=no,resizable=yes,scrollbars=yes",
  );
  popoutWindowRef.current = win;
}, []);
```

**Broadcast on project change:**

```tsx
useEffect(() => {
  if (!activeProject || !popoutChannelRef.current) return;
  popoutChannelRef.current.send({
    type: "active-project",
    projectId: activeProject.id,
    projectName: activeProject.name,
    devServerRunning: devServerByProjectId[activeProject.id]?.status === "running",
  });
}, [activeProject?.id, devServerByProjectId]);

// Cleanup broadcaster on unmount
useEffect(
  () => () => {
    popoutChannelRef.current?.close();
  },
  [],
);
```

### New file: `apps/web/src/routes/dev-logs-popout.tsx`

Standalone TanStack Router route at `/dev-logs-popout`.

Uses the **same app infrastructure** as the main window:

- `EventRouter` runs → creates WS connection → populates Zustand store
- Route component reads `devServerByProjectId` + `devServerLogsByProjectId` from store
- Listens on `BroadcastChannel` for active project changes

**Switch logic:**

```
On "active-project" broadcast received:
  if (devServerByProjectId[newProjectId]?.status === "running"):
    → Switch displayProjectId to newProjectId ✓
  else:
    → Keep current displayProjectId (no switch) ✓

On initial load (store populated from WS):
  → Pick the first running dev server as displayProjectId
```

**UI:**

- Full-screen `DevLogsPanel` with `isPopout={true}` (hides popout button)
- Document title: `"Dev Logs — {projectName}"`
- Minimal header: project name + status badge + close button

```tsx
export const Route = createFileRoute("/dev-logs-popout")({
  component: DevLogsPopoutPage,
});

function DevLogsPopoutPage() {
  const devServerByProjectId = useStore((s) => s.devServerByProjectId);
  const devServerLogsByProjectId = useStore((s) => s.devServerLogsByProjectId);
  const [displayProjectId, setDisplayProjectId] = useState<string | null>(null);
  const [displayProjectName, setDisplayProjectName] = useState("Dev Logs");

  // On store update: pick a running server if not already displaying one
  useEffect(() => {
    if (displayProjectId && devServerByProjectId[displayProjectId]?.status === "running") return;
    const running = Object.values(devServerByProjectId).find((s) => s.status === "running");
    if (running) {
      setDisplayProjectId(running.projectId);
    }
  }, [devServerByProjectId]);

  // BroadcastChannel listener
  useEffect(() => {
    const receiver = new PopoutReceiver();
    const unsub = receiver.onMessage((msg) => {
      if (msg.type !== "active-project") return;
      if (devServerByProjectId[msg.projectId]?.status === "running") {
        setDisplayProjectId(msg.projectId);
        setDisplayProjectName(msg.projectName);
      }
      // else: no switch, keep current
    });
    return () => {
      unsub();
      receiver.close();
    };
  }, [devServerByProjectId]);

  // Update document title
  useEffect(() => {
    document.title = displayProjectName ? `Dev Logs — ${displayProjectName}` : "Dev Logs";
  }, [displayProjectName]);

  const logs = displayProjectId ? (devServerLogsByProjectId[displayProjectId] ?? []) : [];
  const serverInfo = displayProjectId ? devServerByProjectId[displayProjectId] : undefined;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <DevLogsPanel
        logs={logs}
        serverUrl={serverInfo?.url}
        projectName={displayProjectName}
        isPopout={true}
        className="flex-1"
      />
    </div>
  );
}
```

### Updated: `apps/web/src/components/chat/DevLogsPanel.tsx`

**New props:**

```tsx
interface DevLogsPanelProps {
  logs: string[];
  serverUrl?: string | undefined;
  projectName?: string | undefined; // shown in header
  onPopout?: (() => void) | undefined; // popout button callback
  isPopout?: boolean | undefined; // hides popout button when true
  className?: string | undefined;
}
```

**Header:**

```
┌─────────────────────────────────────────────────────┐
│ [●] Dev Server Logs  ·  @cb/database             [↗] │
│                                        [http://...↗]  │
└─────────────────────────────────────────────────────┘
```

- Left: green dot + "Dev Server Logs" label + project name (dimmed)
- Right: URL link button + popout button (hidden when `isPopout={true}`)

**Log line rendering:**

- Replace `stripAnsi(line)` with `renderLogLine(line)` from `ansiRenderer.ts`
- Each line is a `<div>` with `whitespace-pre-wrap break-all font-mono text-xs`
- Prefix is rendered in its deterministic color with a slightly bold weight
- ANSI-colored portions are rendered as `<span style={{ color: "..." }}>` inline

---

## Files Touched

| Package | File                                   | Action                               |
| ------- | -------------------------------------- | ------------------------------------ |
| web     | `src/lib/ansiRenderer.ts`              | New                                  |
| web     | `src/lib/devLogsPopoutChannel.ts`      | New                                  |
| web     | `src/routes/dev-logs-popout.tsx`       | New                                  |
| web     | `src/components/chat/DevLogsPanel.tsx` | Update (rewrite)                     |
| web     | `src/components/ChatView.tsx`          | Update (resize + popout + broadcast) |

---

## Quality Gates

All of `bun fmt`, `bun lint`, `bun typecheck` must pass.

## Notes

- **Electron popout**: `window.open()` works in Electron and creates a native `BrowserWindow`. No extra code needed — Electron handles it via its default `nativeWindowOpen` behavior.
- **BroadcastChannel browser support**: All modern browsers + Electron's Chromium engine ✓
- **routeTree.gen.ts**: Auto-regenerated by TanStack Router's Vite plugin when the new route file is added — no manual changes needed.
- **Resize persistence**: Width stored in `localStorage` at key `t3code:dev-logs-width`.
