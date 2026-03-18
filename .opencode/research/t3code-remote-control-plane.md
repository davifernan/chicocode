## Executive summary

- The strongest path for `T3 Code` is a `remote-authoritative control plane`, not full bidirectional local/remote state replication.
- For MVP, the easiest and safest implementation is: remote `T3 Code` server runs on the cloud host, the desktop client bootstraps/connects over SSH and/or a tunneled local port, and all threads/sessions live remotely.
- Your current codebase already has a useful seam for this: provider orchestration is mostly behind transport-neutral services, while the main hard local coupling sits in Codex process management.
- `Send to Remote` should start as `thread export/import or handoff`, not live event replication.
- Port forwarding for remote dev servers fits well as a second step after remote-authoritative sessions are working.

## Options considered

### 1) Full local <-> remote sync / hybrid mode

Description:

- Local and remote both persist chats/sessions and synchronize events, state, and possibly live session runtime.

Pros:

- Matches the intuitive "sync everything everywhere" product story.
- Supports offline-ish local work and later upload.

Cons:

- Highest complexity by far.
- Split-brain risk for live turns, approvals, interrupts, and session status.
- Hardest fit with current code because runtime state is partly in-memory and process-bound.

Fit for T3 Code now:

- Bad MVP choice.

### 2) Remote-authoritative control plane

Description:

- A remote `T3 Code` server becomes the source of truth for threads, projections, sessions, commands, and provider runtime.
- Local desktop/web clients are viewers/controllers.

Pros:

- Best match for "cloud central", mobile/web access, low local CPU/RAM use, and long-running sessions.
- Reuses most current client/server flow with fewer consistency problems.
- Lets remote sessions continue when laptop sleeps.

Cons:

- Requires clear auth/transport design.
- Local-only chats become a separate mode and need explicit handoff if you want to move them later.

Fit for T3 Code now:

- Best overall recommendation.

### 3) Client-only SSH orchestrator

Description:

- The local desktop app remains the primary orchestrator and uses SSH to create/manage remote workspaces and processes.

Pros:

- Good desktop UX.
- Can feel similar to DevPod and VS Code Remote-SSH.
- Fast to prototype if the local app simply opens SSH tunnels and starts remote processes.

Cons:

- Weak fit for browser/mobile clients.
- Local machine still owns too much orchestration state.
- Harder to evolve into a true multi-client central system.

Fit for T3 Code now:

- Good bootstrap tactic, weak end-state architecture.

## Internal codebase findings

### What already helps

- `apps/server/src/provider/Services/ProviderAdapter.ts` defines a clean `ProviderAdapterShape` with transport-neutral methods and a canonical `streamEvents` surface.
- `apps/server/src/provider/Services/ProviderService.ts` is already a provider facade, so higher orchestration layers do not need to know whether a provider is local or remote.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` and `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` are largely transport-neutral.
- `packages/contracts/src/providerRuntime.ts`, `packages/contracts/src/orchestration.ts`, and `packages/contracts/src/ws.ts` already give you typed event/request surfaces.
- `apps/server/src/opencode/OpenCodeSseClient.ts` is a useful reference for reconnecting streamed remote events.

### Where the current code is strongly local

- `apps/server/src/codexAppServerManager.ts` is tightly bound to local child processes, stdio JSON-RPC, and in-memory pending request state.
- `apps/server/src/wsServer.ts` contains too much inline business logic, especially around OpenCode process/session handling.
- Current persistence is single-node and local-first: SQLite projections/events plus in-memory push flow.

### Practical implication

- A future `RemoteProviderAdapter` is realistic.
- A robust `two-way sync engine` for live sessions is not a good first move.

## External evidence and source notes

### Coder: server-centric workspaces and agent workloads

Evidence:

- Coder describes itself as self-hosted cloud development environments with a server/control-plane model and remote workspaces defined in infrastructure.
- Coder docs now explicitly position Coder as infrastructure for developers and coding agents, including chat-based `Coder Tasks` for background jobs.

Why it matters:

- This matches your "cloud central" direction better than local orchestration.

Sources:

- https://github.com/coder/coder
- https://raw.githubusercontent.com/coder/coder/main/README.md
- https://coder.com/docs/ai-coder

### DevPod: useful bootstrap pattern, but intentionally client-only

Evidence:

- DevPod explicitly says it is `client-only`, connects a local IDE to any backend, and manages local or remote workspaces the same way.

Why it matters:

- This is a strong reference for the SSH/bootstrap/workspace-provider side of your idea.
- It is also evidence that `client-only` is a different product direction than your desired multi-device central control plane.

Sources:

- https://github.com/loft-sh/devpod
- https://raw.githubusercontent.com/loft-sh/devpod/main/README.md
- https://www.devpod.sh/docs/what-is-devpod

### VS Code Remote-SSH: SSH and port forwarding are proven UX patterns

Evidence:

- VS Code Remote-SSH runs commands/extensions on the remote machine and supports temporary or persistent forwarded ports via SSH.
- The docs explicitly note that direct source sync is not the main model; for local copies/tools they recommend SSHFS or `rsync`.

Why it matters:

- Good evidence that SSH tunneling and port forwarding are solid building blocks.
- Also a warning that "sync local and remote state" is a separate, harder concern and should not be mixed into the transport layer casually.

Sources:

- https://code.visualstudio.com/docs/remote/ssh

### code-server: browser access to remote compute is a strong precedent

Evidence:

- code-server emphasizes consistent development on any device while heavy work runs on the server to preserve local battery/resources.

Why it matters:

- This validates your user value proposition directly.

Sources:

- https://github.com/coder/code-server

### Codex cloud and Codex app-server: direct relevance for T3 Code

Evidence:

- Codex Web already supports cloud background work and IDE-triggered cloud delegation where diffs can later be applied locally.
- Codex app-server supports both stdio and experimental WebSocket transport.
- App-server already models persisted threads, resume/fork/list/read, streamed events, command execution, and overload signaling.

Why it matters:

- The `delegate remotely, then inspect/apply locally` model is much closer to a good MVP than full bidirectional replication.
- WebSocket app-server mode could reduce some custom proxying later.

Sources:

- https://developers.openai.com/codex/cloud
- https://developers.openai.com/codex/app-server

### OpenHands: cloud-hosted agent UI is a real precedent

Evidence:

- OpenHands has both local GUI and cloud deployment, plus multi-user/collaboration features on the cloud side.

Why it matters:

- Confirms that local GUI + hosted/cloud control plane is a viable product split for agent tooling.

Sources:

- https://github.com/OpenHands/OpenHands
- https://raw.githubusercontent.com/OpenHands/OpenHands/main/README.md

## Tradeoffs

### What you should avoid in MVP

- Avoid event-level replication between local and remote runtimes.
- Avoid keeping both local and remote sessions as equal authorities.
- Avoid using SSH as your only long-term application protocol for browser/mobile clients.

### What is worth doing first

- Make the remote server authoritative.
- Use SSH first for bootstrap and tunneling, not as the long-term data model.
- Keep local mode and remote mode separate at first.
- Add explicit handoff/export flows instead of pretending live migration is easy.

## Recommendation

### Recommended target architecture

1. `T3 Code Remote Server`

- Runs on the remote machine.
- Owns SQLite/event store, provider sessions, Codex/OpenCode processes, terminal sessions, and preview processes.

2. `T3 Code Client`

- Desktop/web UI connects to the remote server.
- Desktop can optionally bootstrap the server via SSH and create a local port tunnel.

3. `Remote authority`

- All chats and live sessions in remote mode are stored remotely.
- Local browser storage only caches UI preferences and last-known view state.

4. `Send to Remote` as handoff, not replication

- Start with exporting a completed or inactive local thread to a remote thread.
- Only later investigate true provider-native resume/migration where supported.

5. `Port forwarding` after remote sessions

- Represent forwarded ports as first-class remote resources.
- Desktop can use SSH `LocalForward` for MVP.
- Later, hosted browser/mobile access can move to authenticated reverse proxying.

## Suggested implementation order

### Phase 1: Remote host mode for desktop

- Add remote host settings: host, port, user, auth method, host fingerprint, remote API URL mode.
- Desktop app starts or verifies remote `T3 Code` server over SSH.
- Desktop app opens an SSH tunnel to remote HTTP/WS and points existing UI transport at the tunneled endpoint.
- Remote server becomes the only source of truth when connected in remote mode.

Why first:

- Highest user value with lowest architectural risk.
- Reuses current `wsTransport` model with minimal UI churn.

### Phase 2: Remote provider abstraction

- Introduce a `RemoteProviderAdapter` or remote-backed provider service boundary.
- Move Codex/OpenCode lifecycle fully behind that boundary.
- Extract business logic out of `apps/server/src/wsServer.ts`.

### Phase 3: Remote command/terminal execution

- Add first-class remote command execution and terminal streaming.
- Treat preview/dev server startup as remote commands tied to project/thread/workspace.

### Phase 4: Preview URL / forwarded ports UX

- Add `open preview`, `forward port`, `stop forwarding`, `list forwarded ports`.
- Start with SSH-based local forwarding for desktop.
- Later add reverse-proxied web previews for browser/mobile.

### Phase 5: Thread handoff and import/export

- Support `Send to Remote` for non-live or completed local threads.
- Prefer explicit import semantics over magical sync semantics.

## Concrete repo-level implications

- `apps/web/src/wsTransport.ts` already supports a configurable URL and is a natural insertion point for remote/tunneled transport.
- `apps/web/src/appSettings.ts` is the right initial place to store remote host preferences.
- `apps/server/src/persistence/Services/UiState.ts` can persist remote mode metadata server-side later.
- `apps/server/src/provider/Services/ProviderAdapter.ts` is the cleanest seam for introducing a remote-backed adapter.
- `apps/server/src/opencode/OpenCodeSseClient.ts` is a reference for reconnecting remote event streams.
- `apps/server/src/codexAppServerManager.ts` is the main technical debt hotspot to isolate behind a remote-capable boundary.

## Open questions

- Should desktop remote mode initially require SSH only, or also support direct WSS to a publicly reachable remote server?
- Is `Send to Remote` allowed to be a lossy handoff initially, or must it preserve exact provider-native continuation?
- Do you want one remote machine per user, or later many workspaces/machines behind one T3 control plane?
- Is mobile/browser access a near-term requirement or a later hosted phase?
- Do preview ports need authenticated sharing links, or is localhost-only forwarding enough for MVP?

## Bottom line

- Your idea is good.
- The trap is overcommitting to bidirectional sync too early.
- The best first version is: `remote server is the truth`, `desktop connects via SSH/tunnel`, `sessions keep running remotely`, `Send to Remote` comes later as explicit handoff, and `port forwarding` becomes a first-class remote feature once the remote session model is stable.
