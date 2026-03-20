# AGENTS.md

## Important: Issues & PRs

- **NEVER** create issues or PRs on the upstream repo (`pingdotgg/t3code`) unless explicitly asked to do so.
- Always use `davifernan/chicocode` (this fork) for issues, PRs, and discussions.

## CRITICAL: File Safety in Multi-Agent / Multi-Commit Environments

**NEVER overwrite or replace file contents without an explicit instruction to do so.**

This repo is worked on by multiple agents and humans simultaneously. A file you edited
in a previous step may have been modified by a concurrent commit before you write to it
again. Violating this rule destroys work silently and is the hardest class of bug to
debug in a multi-agent workflow.

Mandatory rules:

1. **Always `Read` a file immediately before editing it**, even if you read it moments
   ago. Use the modification-time error from the `Edit` tool as a hard signal that the
   file changed underneath you — stop, re-read, and merge your change carefully.
2. **Never use `Write` to replace a file you did not just read in the same step.**
   Prefer `Edit` (targeted patch) over `Write` (full replacement) for any file that
   already exists.
3. **Before starting work on a task, run `git status` and `git log --oneline -5`** to
   understand the current state of the branch. If files you intend to touch show
   uncommitted changes or were touched by a very recent commit, read them first.
4. **When committing, ONLY stage files directly related to your own changes.**
   Never use `git add .` or `git add -A` — these sweep up changes made by other
   agents or humans working concurrently and destroy their work silently.
   Always stage files explicitly by path: `git add path/to/your/file.ts`.

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
