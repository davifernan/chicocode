/**
 * ChicoRunRegistry — global registry of all active Chico run sessions.
 *
 * Thread-safe (single-threaded Node.js event loop) Map of runId → ChicoRunSession.
 * Emits change events so the gRPC server can push updates to connected WS clients.
 *
 * @module ChicoRunRegistry
 */

import { ChicoRunSession } from "./ChicoRunSession.ts";
import type { ChicoRunSnapshot } from "./ChicoRunSession.ts";
import type { AgentEvent, EventStreamInit } from "./ChicoProtoLoader.ts";

// ── Event types emitted by the registry ──────────────────────────────

export interface RunRegisteredEvent {
  readonly kind: "run.registered";
  readonly snapshot: ChicoRunSnapshot;
}

export interface RunDisconnectedEvent {
  readonly kind: "run.disconnected";
  readonly runId: string;
}

export interface RunEventReceivedEvent {
  readonly kind: "run.event";
  readonly runId: string;
  readonly event: AgentEvent;
  readonly snapshot: ChicoRunSnapshot;
}

export type ChicoRegistryEvent = RunRegisteredEvent | RunDisconnectedEvent | RunEventReceivedEvent;

export type ChicoRegistryListener = (event: ChicoRegistryEvent) => void;

// ── Registry ─────────────────────────────────────────────────────────

export class ChicoRunRegistry {
  private readonly sessions = new Map<string, ChicoRunSession>();
  private readonly listeners = new Set<ChicoRegistryListener>();

  // ── Listener management ─────────────────────────────────────────

  addListener(listener: ChicoRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ChicoRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let a bad listener crash the registry
      }
    }
  }

  // ── Session lifecycle ────────────────────────────────────────────

  /**
   * Register or re-activate a run when Chico opens a StreamEvents connection.
   * Returns the session (created or existing).
   */
  registerRun(init: EventStreamInit): ChicoRunSession {
    const existing = this.sessions.get(init.run_id);
    if (existing) {
      // Reconnect — re-activate and re-emit so the client updates status back to
      // "active" (it may have marked the run as "disconnected" on the previous drop).
      existing.status = "active";
      this.emit({ kind: "run.registered", snapshot: existing.toSnapshot() });
      return existing;
    }

    const session = new ChicoRunSession(init.run_id, init.container_id, init.project_name);
    this.sessions.set(init.run_id, session);
    this.emit({ kind: "run.registered", snapshot: session.toSnapshot() });
    return session;
  }

  /**
   * Mark a run as disconnected (gRPC stream closed / error).
   * Session state is preserved for display purposes.
   */
  disconnectRun(runId: string): void {
    const session = this.sessions.get(runId);
    if (!session) return;
    session.status = "disconnected";
    this.emit({ kind: "run.disconnected", runId });
  }

  /**
   * Apply an incoming AgentEvent to the correct session and emit change.
   * Creates a session on-the-fly if `ReportEvent` arrives before `StreamEvents`
   * (shouldn't happen in practice, but handle gracefully).
   */
  applyEvent(event: AgentEvent): void {
    let session = this.sessions.get(event.run_id);
    if (!session) {
      session = new ChicoRunSession(event.run_id, event.container_id, "");
      this.sessions.set(event.run_id, session);
      this.emit({ kind: "run.registered", snapshot: session.toSnapshot() });
    }

    session.applyEvent(event);

    this.emit({
      kind: "run.event",
      runId: event.run_id,
      event,
      snapshot: session.toSnapshot(),
    });
  }

  // ── Queries ──────────────────────────────────────────────────────

  getSession(runId: string): ChicoRunSession | undefined {
    return this.sessions.get(runId);
  }

  getAllSnapshots(): ChicoRunSnapshot[] {
    return Array.from(this.sessions.values()).map((s) => s.toSnapshot());
  }

  getSnapshot(runId: string): ChicoRunSnapshot | undefined {
    return this.sessions.get(runId)?.toSnapshot();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}

// ── Module-level singleton ────────────────────────────────────────────
// Shared across wsServer and ChicoGrpcServer without Effect DI.

export const chicoRunRegistry = new ChicoRunRegistry();
