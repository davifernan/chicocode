# Dev Server Feature — Implementation Plan

## Overview

Add a per-project background dev server (e.g. `bun run dev`) that can be started/stopped from the
ChatHeader navbar. Status is shared across all threads of the same project.

---

## User-Facing Behaviour

- **"Run dev" button** in the ChatHeader right-side button group (next to `ProjectScriptsControl`)
- Button states:
  - `idle / stopped / error` → green PlayIcon, label "Run dev"
  - `starting` → spinner, disabled, label "Starting…"
  - `running` → red SquareIcon, label "Stop dev"
- **Green dot** (`size-1.5 rounded-full bg-emerald-500`) next to the project name in the sidebar
  when the dev server is running for that project
- **DiffIcon toggle → `RightPanelControl` dropdown** (split button):
  - Primary button icon: DiffIcon (diff mode) or TerminalIcon (dev-logs mode)
  - Chevron dropdown: "Diff" | "Dev logs" (disabled when no dev server running)
- **Dev-Log panel** (like the diff panel) with:
  - Scrollable ANSI-stripped log output
  - Auto-scroll to bottom unless user has scrolled up
  - "Waiting for dev server…" placeholder
- **Detected URL** shown space-efficiently:
  - In the tooltip of the "Stop dev" button
  - As a clickable link in the Dev-Log panel header

---

## Package Manager Detection (server-side)

Priority order (check lockfiles in project `cwd`):

1. `bun.lock` → `bun run dev`
2. `yarn.lock` → `yarn dev`
3. `pnpm-lock.yaml` → `pnpm run dev`
4. `package-lock.json` → `npm run dev`
5. Fallback: read `package.json#packageManager` field, else `npm run dev`

Prerequisite: `package.json` must have a `"dev"` script, else error gracefully.

---

## Architecture

### Layer 1 — `packages/contracts`

**New file: `src/devServer.ts`**

```ts
DevServerStatus = "idle" | "starting" | "running" | "stopped" | "error"

DevServerInfo = {
  projectId: ProjectId
  status: DevServerStatus
  packageManager?: string       // "bun" | "npm" | "yarn" | "pnpm"
  url?: string                  // detected from stdout, e.g. "http://localhost:3000"
  pid?: number
  error?: string
}

DevServerLogLinePayload = {
  projectId: ProjectId
  line: string
  stream: "stdout" | "stderr"
}

// Input schemas
DevServerStartInput    = { projectId: ProjectId }
DevServerStopInput     = { projectId: ProjectId }
DevServerGetStatusInput = { projectId: ProjectId }
DevServerGetLogsInput  = { projectId: ProjectId, limit?: number }
// DevServerGetStatuses: no input (returns all)
```

**Update: `src/ws.ts`**

- New WS methods:
  - `devServer.start`
  - `devServer.stop`
  - `devServer.getStatus`
  - `devServer.getStatuses`
  - `devServer.getLogs`
- New push channels:
  - `devServer.statusChanged` → `DevServerInfo`
  - `devServer.logLine` → `DevServerLogLinePayload`
- Update `WsPushPayloadByChannel`, `WebSocketRequestBody`, `WsPushChannelSchema`, `WsPush`

**Update: `src/index.ts`** — re-export new types

---

### Layer 2 — `apps/server`

**New file: `src/devServer/DevServerManager.ts`**

```
DevServerSession = {
  process: ChildProcess
  status: DevServerStatus
  packageManager: string
  url?: string
  pid?: number
  logs: string[]   // rolling buffer, max 500 lines — HOOK for future agent context injection
  error?: string
}
```

Key methods:

- `start(projectId, cwd)` — detect PM, check dev script exists, spawn process, track session
- `stop(projectId)` — SIGTERM → 3s → SIGKILL (same pattern as processRunner.ts)
- `getStatus(projectId)` → `DevServerInfo`
- `getAllStatuses()` → `DevServerInfo[]`
- `getLogs(projectId, limit?)` → `string[]`

Internal:

- `detectPackageManager(cwd)` → async, checks lockfiles → reads package.json
- `parseUrlFromOutput(line)` → regex: `(https?://[^\s]+)` and `localhost:\d+`
- On status change: `this.emit("statusChanged", DevServerInfo)` → wsServer pushes
- On each log line: `this.emit("logLine", payload)` → wsServer pushes

Singleton export: `export const devServerManager = new DevServerManager()`

**Update: `src/wsServer.ts`**

- Import `devServerManager`
- Wire `devServerManager.on("statusChanged")` → `pushBus.publishAll("devServer.statusChanged", ...)`
- Wire `devServerManager.on("logLine")` → `pushBus.publishAll("devServer.logLine", ...)`
- Add request handlers for all 5 new WS methods

---

### Layer 3 — `apps/web`

**Update: `src/store.ts`**

```ts
devServerByProjectId: Record<string, DevServerInfo>;
devServerLogsByProjectId: Record<string, string[]>; // rolling, max 500 lines
```

Actions: `upsertDevServerStatus(info)`, `appendDevServerLogLine(payload)`

**Update: `src/wsNativeApi.ts`**

- Subscribe `devServer.statusChanged` → `store.upsertDevServerStatus`
- Subscribe `devServer.logLine` → `store.appendDevServerLogLine`
- After connect/reconnect: call `devServer.getStatuses` to seed store
- New callable methods: `devServerStart(projectId)`, `devServerStop(projectId)`, `devServerGetLogs(projectId)`

**New: `src/components/DevServerControl.tsx`**

```
Props: projectId, cwd, status: DevServerInfo | undefined, onStart, onStop
```

- stopped/idle/error → `<Button size="xs" variant="outline"><PlayIcon /> Run dev</Button>`
- starting → `<Button disabled><Spinner /> Starting…</Button>`
- running → `<Button size="xs" variant="outline"><SquareIcon /> Stop dev</Button>`
- Tooltip shows detected URL when running

**New: `src/components/RightPanelControl.tsx`** (replaces standalone DiffIcon Toggle)

```
Props:
  panelMode: "diff" | "dev-logs" | null
  devServerRunning: boolean
  isGitRepo: boolean
  shortcutLabel: string | null
  onPanelModeChange: (mode: "diff" | "dev-logs" | null) => void
```

Split-button Group (same pattern as ProjectScriptsControl):

- Primary toggle: DiffIcon (diff) or TerminalIcon (dev-logs), toggles current mode on/off
- Chevron dropdown:
  - "Diff" (DiffIcon)
  - "Dev logs" (TerminalIcon) — disabled when dev server not running

**New: `src/components/chat/DevLogsPanel.tsx`**

```
Props: logs: string[], projectName?: string, serverUrl?: string
```

- Scrollable output, ANSI-stripped via simple regex
- "Open in browser" button when `serverUrl` is set
- Auto-scroll to bottom (ref + useEffect), paused when user scrolls up
- "Waiting for dev server to start…" when `logs.length === 0`

**Update: `src/components/chat/ChatHeader.tsx`**

- Replace `diffOpen / onToggleDiff` with `rightPanelMode / onRightPanelModeChange`
- Add `devServerStatus`, `onStartDevServer`, `onStopDevServer` props
- Render `<DevServerControl>` next to `<ProjectScriptsControl>`
- Render `<RightPanelControl>` where the DiffIcon Toggle was

**Update: `src/components/ChatView.tsx`**

- Replace `diffOpen` state with `rightPanelMode: "diff" | "dev-logs" | null`
- Render `<DevLogsPanel>` when `rightPanelMode === "dev-logs"`
- Wire all new props through to `ChatHeader`
- Read `devServerByProjectId` and `devServerLogsByProjectId` from store

**Update: `src/components/Sidebar.tsx`**

- Import `devServerByProjectId` from store
- After `<span>{project.name}</span>`, render:
  ```tsx
  {
    devServerByProjectId[project.id]?.status === "running" && (
      <span
        className="size-1.5 rounded-full bg-emerald-500 shrink-0"
        aria-label="Dev server running"
      />
    );
  }
  ```

---

### Layer 4 — Agent Context (Future-Ready, no code now)

The `DevServerManager` already maintains a `logs` rolling buffer per project and exposes
`getLogs(projectId, limit)` via WS.

**Future integration point** (comment placeholder in `ProviderCommandReactor.ts`):

```ts
// TODO(dev-server-context): Before sending a turn, optionally inject recent dev server logs
// as a system context item. Fetch via devServerManager.getLogs(projectId, 50).
// Controlled by a per-project or per-thread "attach dev logs to context" toggle.
```

No MCP needed — direct access to the singleton `devServerManager` from the server process.

---

## Files Touched

| Package   | File                                   | Action |
| --------- | -------------------------------------- | ------ |
| contracts | `src/devServer.ts`                     | New    |
| contracts | `src/ws.ts`                            | Update |
| contracts | `src/index.ts`                         | Update |
| server    | `src/devServer/DevServerManager.ts`    | New    |
| server    | `src/wsServer.ts`                      | Update |
| web       | `src/store.ts`                         | Update |
| web       | `src/wsNativeApi.ts`                   | Update |
| web       | `src/components/DevServerControl.tsx`  | New    |
| web       | `src/components/RightPanelControl.tsx` | New    |
| web       | `src/components/chat/DevLogsPanel.tsx` | New    |
| web       | `src/components/chat/ChatHeader.tsx`   | Update |
| web       | `src/components/ChatView.tsx`          | Update |
| web       | `src/components/Sidebar.tsx`           | Update |

---

## Quality Gates

All of `bun fmt`, `bun lint`, `bun typecheck` must pass before the feature is considered done.
