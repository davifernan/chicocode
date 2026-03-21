/**
 * chicoStore — Zustand store for the Chico Observability Zentrale.
 *
 * Isolated from the main app store — ChicoCenter manages its own slice.
 * Populated via WS push subscriptions set up in useChicoSubscriptions.
 *
 * @module chicoStore
 */

import { create } from "zustand";
import type { ChicoRunSnapshot, ChicoServerInfo } from "@t3tools/contracts";

// ── State ─────────────────────────────────────────────────────────────

export interface ChicoStoreState {
  /** All known runs keyed by runId */
  runs: Map<string, ChicoRunSnapshot>;
  /** Currently selected run in the detail view */
  selectedRunId: string | null;
  /** gRPC server info (port, endpoint hint for Chico containers) */
  serverInfo: ChicoServerInfo | null;
  /** True while the initial getRuns/getServerInfo call is in-flight */
  isBootstrapping: boolean;
  /** Non-null if bootstrap failed */
  bootstrapError: string | null;
}

// ── Actions ───────────────────────────────────────────────────────────

export interface ChicoStoreActions {
  setServerInfo: (info: ChicoServerInfo) => void;
  upsertRun: (snapshot: ChicoRunSnapshot) => void;
  markRunDisconnected: (runId: string) => void;
  selectRun: (runId: string | null) => void;
  setBootstrapping: (v: boolean) => void;
  setBootstrapError: (msg: string | null) => void;
  applyRunStateUpdate: (runId: string, snapshot: ChicoRunSnapshot) => void;
}

// ── Store ─────────────────────────────────────────────────────────────

export const useChicoStore = create<ChicoStoreState & ChicoStoreActions>((set, get) => ({
  runs: new Map(),
  selectedRunId: null,
  serverInfo: null,
  isBootstrapping: false,
  bootstrapError: null,

  setServerInfo: (info) => set({ serverInfo: info }),

  upsertRun: (snapshot) =>
    set((state) => {
      const next = new Map(state.runs);
      next.set(snapshot.runId, snapshot);
      return { runs: next };
    }),

  markRunDisconnected: (runId) =>
    set((state) => {
      const existing = state.runs.get(runId);
      if (!existing) return state;
      const next = new Map(state.runs);
      next.set(runId, { ...existing, status: "disconnected" });
      return { runs: next };
    }),

  selectRun: (runId) => {
    // Auto-validate: only select runs we actually know about
    if (runId !== null && !get().runs.has(runId)) return;
    set({ selectedRunId: runId });
  },

  setBootstrapping: (v) => set({ isBootstrapping: v }),
  setBootstrapError: (msg) => set({ bootstrapError: msg }),

  applyRunStateUpdate: (runId, snapshot) =>
    set((state) => {
      const next = new Map(state.runs);
      next.set(runId, snapshot);
      return { runs: next };
    }),
}));

// ── Derived selectors ─────────────────────────────────────────────────

export function selectAllRuns(state: ChicoStoreState): ChicoRunSnapshot[] {
  return Array.from(state.runs.values()).toSorted(
    (a, b) => new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime(),
  );
}

export function selectActiveRuns(state: ChicoStoreState): ChicoRunSnapshot[] {
  return selectAllRuns(state).filter((r) => r.status === "active");
}

export function selectSelectedRun(state: ChicoStoreState): ChicoRunSnapshot | null {
  if (!state.selectedRunId) return null;
  return state.runs.get(state.selectedRunId) ?? null;
}
