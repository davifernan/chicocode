# Remote Mode — Technical Documentation

> **For server admin setup (installing T3 on a remote machine), see [`docs/remote-server-setup.md`](./remote-server-setup.md).**

This document describes the internal architecture of the Remote Mode feature: how it works end-to-end, which files are involved, and the design decisions behind it.

---

## Overview

Remote Mode lets a local T3 instance connect to a T3 server running on a different machine, via an SSH tunnel. After connecting, all sessions (Codex, OpenCode, threads) run on the remote server. Local threads are automatically synced to the remote before the switch happens.

```
User's Machine                               Remote Server
┌──────────────────────────────┐             ┌──────────────────────┐
│ Browser                      │             │ T3 Server            │
│                              │             │ port: 3773           │
│  managementTransport ────────┼─────────────┤ ws://localhost:3773  │
│  (always local, port 3773)   │ local WS    │ (SSH management,     │
│                              │             │  config, status)     │
│  appTransport ───────────────┼─────────────┤ SSH Tunnel           │
│  (switches to tunnel)        │ tunnel WS   │ ws://localhost:3774  │
│                              │             │ → remote:3773        │
└──────────────────────────────┘             └──────────────────────┘
         ▲ subscribes to
         │ server.remoteConnectionStatus
         │ (always from managementTransport)
```

---

## Full Connection Flow

### Step 1 — User configures remote host

In **Settings → Remote Host**, the user enters:

- Host, SSH Port, SSH User, SSH Key Path
- Remote Server Port (default 3773)
- Auth Token (optional)
- Enables the toggle

Clicking **Save & Connect** calls `api.remoteHost.setConfig(config)`, which goes via `managementTransport` to the **local** T3 server.

**Relevant files:**

- `apps/web/src/routes/_chat.settings.tsx` — `RemoteHostSettings` component
- `apps/web/src/remoteHostConfig.ts` — helper to load/save config
- `packages/contracts/src/remoteHost.ts` — `RemoteHostConfig` schema

---

### Step 2 — Server opens SSH tunnel

The local T3 server receives the config and stores it in `ui_state` (SQLite), then calls `RemoteHostService.applyConfig(config)`.

The service runs a 4-step pre-flight check before opening the tunnel:

| Step           | What it checks                        |
| -------------- | ------------------------------------- |
| `ssh-connect`  | TCP port reachability (host:sshPort)  |
| `port-test`    | T3 server port reachable via tunnel   |
| `t3-handshake` | HTTP GET `/api/health` through tunnel |
| `auth`         | Auth token validation (if configured) |

Each step failure includes a human-readable `error` and `hint` shown in the UI.

If all checks pass, `SshTunnelManager` spawns:

```
ssh -N -o ExitOnForwardFailure=yes \
    -L <localPort>:localhost:<remotePort> \
    -p <sshPort> \
    -i <keyPath> \
    <user>@<host>
```

The local port is reserved dynamically via `net.createServer({ port: 0 })` to avoid conflicts.

`SshTunnelManager` monitors the SSH process and performs exponential-backoff reconnects (up to 8 attempts, max 30s delay) if the tunnel dies.

**Relevant files:**

- `apps/server/src/remoteHost/Services/RemoteHostService.ts` — orchestrator
- `apps/server/src/remoteHost/Services/SshTunnelManager.ts` — SSH process management
- `apps/server/src/remoteHost/Services/ConnectionChecker.ts` — step-by-step checks
- `apps/server/src/remoteHost/Layers/RemoteHostService.ts` — Effect Layer

---

### Step 3 — Server pushes connection status

After each step, `RemoteHostService` publishes a `RemoteConnectionStatus` to all connected WebSocket clients:

```ts
// During tunnel setup:
{ status: "connecting", step: "ssh-connect" | "port-test" | "t3-handshake" | "auth" }

// After success:
{ status: "connected", tunnelWsUrl: "ws://127.0.0.1:<localPort>", connectedAt: "..." }

// On failure:
{ status: "error", step: "...", error: "...", hint: "..." }
```

The WS push goes via `server.remoteConnectionStatus` channel, subscribed by the browser on the **management transport**.

The `ConnectionStatusBadge` (sidebar) and `RemoteHostSettings` (settings page) both listen to the `t3:remoteStatus` custom DOM event, which `RemoteConnectionManager` dispatches when the status arrives.

**Relevant files:**

- `apps/server/src/wsServer.ts` — subscribes to `RemoteHostService.subscribeToStatus()` and publishes via `pushBus`
- `packages/contracts/src/ws.ts` — `WS_CHANNELS.serverRemoteConnectionStatus`
- `apps/web/src/components/ConnectionStatusBadge.tsx` — sidebar indicator
- `apps/web/src/main.tsx` — `RemoteConnectionManager`, dispatches `t3:remoteStatus`

---

### Step 4 — Browser runs thread sync

When `RemoteConnectionManager` in `main.tsx` receives `status: "connected"`, it immediately starts a client-orchestrated sync **before** switching the transport.

**Why client-orchestrated?** At this point, the browser still has the local transport pointing to the local server, and knows `tunnelWsUrl` for the remote. It can directly query both sides without the server needing to open its own outbound WS connection.

Sync protocol (`apps/web/src/syncOrchestrator.ts`):

```
1. GET local manifest:
   sync.getThreadManifest on local transport
   → [{ threadId, maxStreamVersion, eventCount }, ...]

2. GET remote manifest:
   sync.getThreadManifest on remote transport (new WsTransport(tunnelWsUrl))
   → [{ threadId, maxStreamVersion, eventCount }, ...]

3. Classify each local thread:
   - Only on local          → push queue
   - Both, same version     → skip (already in sync)
   - Both, different version → diverged (warn + skip, never overwrite)

4. For each thread in push queue:
   a. sync.exportThreadEvents(threadId) on local → OrchestrationEvent[]
   b. Batch events (100 per batch)
   c. sync.receiveEvents(batch) on remote → { accepted, skipped }

5. Report progress via onProgress callback → SyncStatusBanner
6. Return SyncSummary { pushed, skipped, diverged, errors }
```

**Why idempotent?** The `orchestration_events` table has `event_id TEXT UNIQUE`. `SyncService.receiveEvents()` calls `OrchestrationEventStore.append()` per event — duplicates silently fail the unique constraint and are counted as `skipped`.

**Relevant files:**

- `apps/web/src/syncOrchestrator.ts` — client-side sync logic
- `apps/server/src/sync/SyncService.ts` — server-side: `getThreadManifest`, `exportThreadEvents`, `receiveEvents`
- `apps/server/src/persistence/Migrations/017_SyncCursors.ts` — `sync_cursors` table (Phase 3 delta-sync)
- `apps/web/src/components/SyncStatusBanner.tsx` — progress banner ("Syncing 3/15 chats…")

---

### Step 5 — Transport switch (seamless, no page reload)

After sync completes, `RemoteConnectionManager` calls two things back-to-back:

```ts
replaceAppTransport(tunnelWsUrl); // wsNativeApi.ts
onTransportSwitch(); // increments React routerKey → remount
```

**How `replaceAppTransport` works:**

The browser maintains two persistent WebSocket connections:

| Transport             | URL                              | Purpose                     | Methods                                                                                                                   |
| --------------------- | -------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `managementTransport` | `ws://localhost:3773`            | Local server, never changes | `server.*`, `remoteHost.*`, `devServer.*`, push: `serverRemoteConnectionStatus`, `serverRemoteSyncStatus`                 |
| `appTransport`        | Starts local, switches to tunnel | All application data        | `orchestration.*`, `terminal.*`, `git.*`, `projects.*`, `shell.*`, `sync.*`, push: `serverWelcome`, `serverConfigUpdated` |

The split exists because `remoteHost.*` must always go to the local server (the SSH tunnel is managed locally). After switching, `remoteHost.setConfig` still reaches the local server even though all orchestration traffic goes to remote.

```ts
export function replaceAppTransport(tunnelWsUrl: string | null): void {
  // 1. Unsubscribe push channels from old transport (prevents stale events)
  for (const cleanup of instance.appSubscriptionCleanups) cleanup();

  // 2. Create new transport
  const old = instance.appTransport;
  const next = new WsTransport(tunnelWsUrl ?? undefined);

  // 3. Re-register push subscriptions on new transport
  const newCleanups = setupAppTransportSubscriptions(next);

  // 4. Update instance — all api() closures read instance.appTransport at call time
  instance = { ...instance, appTransport: next, appSubscriptionCleanups: newCleanups };

  // 5. Dispose old after 5s (lets in-flight requests complete)
  setTimeout(() => old.dispose(), 5_000);
}
```

**Why closures work here:** JavaScript closures capture variable _bindings_, not values. All API method closures in `wsNativeApi.ts` call `app()` which reads `instance!.appTransport` at call time. After the instance is updated, the next API call automatically goes to the new transport — without rebuilding the `api` object.

**Why `routerKey` remount:** The `app()` closure fix handles new requests. But push _subscriptions_ registered by React components (e.g., `api.orchestration.onDomainEvent(cb)` in `__root.tsx`) are bound to the old transport object. Incrementing `routerKey` forces `RouterProvider` to unmount and remount — triggering all `useEffect` cleanups and setups — so subscriptions naturally re-register on the new transport.

**Relevant files:**

- `apps/web/src/wsNativeApi.ts` — two-transport architecture, `replaceAppTransport`
- `apps/web/src/main.tsx` — `App` component with `routerKey`, `RemoteConnectionManager`

---

### Step 6 — Disconnect

The user clicks **Disconnect** in Settings → Remote Host. This calls:

```ts
api.remoteHost.setConfig(null);
```

The local server kills the SSH tunnel, publishes `status: "disconnected"`. `RemoteConnectionManager` detects this (when `isInRemoteMode.current === true`) and runs:

```ts
replaceAppTransport(null); // back to local URL
onTransportSwitch(); // remount router
```

The app switches back to the local server seamlessly.

---

## Data Model

### `sync_cursors` (SQLite — Phase 3, not yet active)

```sql
CREATE TABLE sync_cursors (
  remote_fingerprint   TEXT    NOT NULL,  -- "host:port"
  thread_id            TEXT    NOT NULL,
  last_synced_sequence INTEGER NOT NULL,  -- cursor for delta-sync
  last_synced_at       TEXT    NOT NULL,
  PRIMARY KEY (remote_fingerprint, thread_id)
)
```

Currently written but not yet read. Phase 3 will use `last_synced_sequence` as cursor for `OrchestrationEventStore.readFromSequence(cursor)` to push only new events on reconnect.

### Persistent remote config

`RemoteHostConfig` is stored server-side in `ui_state` (key: `"remoteHostConfig"`, value: JSON). Deliberately **not** in `localStorage` because it may contain SSH key paths and auth tokens.

On server startup, the saved config is loaded and `RemoteHostService.applyConfig()` is called automatically if `enabled: true`.

---

## WS Protocol

### New methods added

| Method                        | Direction       | Transport  | Description                                        |
| ----------------------------- | --------------- | ---------- | -------------------------------------------------- |
| `server.setRemoteHostConfig`  | client → server | management | Save config + trigger connect                      |
| `server.testRemoteConnection` | client → server | management | Run step-by-step connection check                  |
| `sync.getThreadManifest`      | client → server | app        | Get `[{ threadId, maxStreamVersion, eventCount }]` |
| `sync.exportThreadEvents`     | client → server | app        | Get all events for a thread                        |
| `sync.receiveEvents`          | client → server | app        | Append incoming events (idempotent)                |

### New push channels added

| Channel                         | Source transport | Payload                  |
| ------------------------------- | ---------------- | ------------------------ |
| `server.remoteConnectionStatus` | management       | `RemoteConnectionStatus` |
| `server.remoteSyncStatus`       | management       | `RemoteSyncStatus`       |

---

## Key Design Decisions

### Why SSH tunnel instead of direct exposure?

The remote T3 server binds to `127.0.0.1` only. No firewall rules needed, no TLS certificates, no port forwarding. The SSH tunnel is the only entry point. Authentication via existing SSH keys.

### Why client-orchestrated sync instead of server-to-server?

The browser has both transports available at sync time (local for reading events, tunnel for writing). Having the server open its own outbound WS client to the remote would add complexity (server needs to know tunnel URL, manage its own WS client lifecycle) without any benefit for a single-user scenario.

### Why diverged threads warn-and-skip instead of merge?

Event sourcing makes merge non-trivial — you'd need to compare event graphs. A diverged thread means the same `threadId` has a different `maxStreamVersion` on local vs. remote. The only safe action is to warn and let the user decide. Silently overwriting remote state would be data loss.

### Why `routerKey` remount instead of explicit re-subscription?

The alternative is tracking every subscription registered by every React component and forcing them to re-subscribe. This is error-prone and requires all components to opt in. The React key remount is a well-established pattern (used for auth state changes, locale switches) and is correct by construction — React cleans up all effects on unmount and re-registers them on mount.

### Why two transports instead of one switchable transport?

`remoteHost.*` and `server.*` management methods must **always** reach the local server. If we used a single transport and switched it to the tunnel, then `remoteHost.setConfig(null)` (disconnect) would go to the remote server — which has no SSH tunnel management capability and would fail. The two-transport split is a hard correctness requirement.

---

## Files Added / Changed

### New files

| File                                                        | Purpose                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/contracts/src/remoteHost.ts`                      | `RemoteHostConfig`, `RemoteConnectionStatus`, `RemoteConnectionStep`, sync schemas |
| `apps/server/src/remoteHost/Services/SshTunnelManager.ts`   | SSH process lifecycle, backoff reconnect                                           |
| `apps/server/src/remoteHost/Services/ConnectionChecker.ts`  | Step-by-step connection validation                                                 |
| `apps/server/src/remoteHost/Services/RemoteHostService.ts`  | Orchestration + PubSub for status                                                  |
| `apps/server/src/remoteHost/Layers/RemoteHostService.ts`    | Effect live layer                                                                  |
| `apps/server/src/sync/SyncService.ts`                       | `getThreadManifest`, `exportThreadEvents`, `receiveEvents`                         |
| `apps/server/src/persistence/Migrations/017_SyncCursors.ts` | DB migration for sync cursor table                                                 |
| `apps/server/src/persistence/Services/SyncCursor.ts`        | SyncCursor service interface                                                       |
| `apps/server/src/persistence/Layers/SyncCursor.ts`          | SyncCursor live layer                                                              |
| `apps/web/src/remoteHostConfig.ts`                          | Web-side config load/save/test helpers                                             |
| `apps/web/src/syncOrchestrator.ts`                          | Client-orchestrated sync logic                                                     |
| `apps/web/src/components/ConnectionStatusBadge.tsx`         | Sidebar connection indicator                                                       |
| `apps/web/src/components/SyncStatusBanner.tsx`              | Floating sync progress banner                                                      |
| `docs/remote-server-setup.md`                               | Server admin setup guide                                                           |

### Modified files

| File                                        | What changed                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/contracts/src/server.ts`          | `ServerUiStateKey` + `"remoteHostConfig"`                                    |
| `packages/contracts/src/ws.ts`              | 5 new WS methods, 2 new push channels, schemas                               |
| `packages/contracts/src/ipc.ts`             | `NativeApi` extended with `remoteHost` and `sync`                            |
| `apps/server/src/serverLayers.ts`           | `RemoteHostServiceLive`, `SyncServiceLive`, `SyncCursorRepositoryLive` added |
| `apps/server/src/wsServer.ts`               | New request handlers, startup config restore, status subscription            |
| `apps/server/src/persistence/Migrations.ts` | Migration `017_SyncCursors` registered                                       |
| `apps/web/src/wsNativeApi.ts`               | Two-transport split, `replaceAppTransport`, subscription cleanup             |
| `apps/web/src/main.tsx`                     | `App` with `routerKey`, `RemoteConnectionManager`                            |
| `apps/web/src/routes/_chat.settings.tsx`    | Remote Host settings section                                                 |
| `apps/web/src/routes/__root.tsx`            | `SyncStatusBanner` added                                                     |
| `apps/web/src/components/Sidebar.tsx`       | `ConnectionStatusBadge` added                                                |

---

## Phase 3 — Not yet implemented

Delta-sync using the `sync_cursors` table: on reconnect, instead of pushing all events for a thread, read only events since `last_synced_sequence` via `OrchestrationEventStore.readFromSequence(cursor)`. This makes reconnects fast (only new events transferred) and adds an optional background interval-sync when connected.
