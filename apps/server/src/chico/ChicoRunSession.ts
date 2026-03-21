/**
 * ChicoRunSession — per-run state and live event reducer.
 *
 * Holds all observable state for one Chico orchestrator run.
 * `applyEvent()` is a TypeScript port of the key event cases from
 * `chico/src/commands/watch.rs::apply_wb_sse_event()`.
 *
 * @module ChicoRunSession
 */

import type { AgentEvent } from "./ChicoProtoLoader.ts";

// ── Worker state ─────────────────────────────────────────────────────

export type WorkerLifecycle =
  | "declared"
  | "starting"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "aborted"
  | "stopped";

export interface ChicoWorker {
  id: number;
  label: string;
  lifecycle: WorkerLifecycle;
  activity: string;
  cost: number;
  steps: number;
  model: string;
  elapsedMs: number;
  startedAt: number | null; // unix ms
}

// ── Run-level state ──────────────────────────────────────────────────

export type ChicoRunStatus = "active" | "disconnected";

export interface ChicoRunSnapshot {
  runId: string;
  containerId: string;
  projectName: string;
  status: ChicoRunStatus;
  phase: string;
  workers: ChicoWorker[];
  totalCostUsd: number;
  recentEvents: SerializedAgentEvent[];
  connectedAt: string; // ISO 8601
  lastEventAt: string | null;
  lastKnownSeq: number;
}

export interface SerializedAgentEvent {
  seq: number;
  timestamp: string;
  event_type: string;
  source: string;
  worker_id?: number;
  phase: string;
  level: string;
  payload: string;
  run_id: string;
}

// ── Session class ────────────────────────────────────────────────────

const MAX_RECENT_EVENTS = 200;

function parseProjectNameFromRunId(runId: string): string {
  // run_id format: "wb_YYYYMMDD_HHMMSS" or "chico-{project}-{hash}"
  // or simply the project name passed via container env
  const chicoMatch = /^chico-(.+)-[a-f0-9]{6,}$/.exec(runId);
  if (chicoMatch) return chicoMatch[1] ?? runId;
  return runId;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class ChicoRunSession {
  readonly runId: string;
  readonly containerId: string;
  projectName: string;
  status: ChicoRunStatus = "active";

  phase = "starting";
  workers = new Map<number, ChicoWorker>();
  totalCostUsd = 0;
  lastKnownSeq = 0;

  readonly connectedAt: Date;
  lastEventAt: Date | null = null;

  private recentEvents: SerializedAgentEvent[] = [];

  constructor(runId: string, containerId: string, projectName: string) {
    this.runId = runId;
    this.containerId = containerId;
    this.projectName = projectName.length > 0 ? projectName : parseProjectNameFromRunId(runId);
    this.connectedAt = new Date();
  }

  // ── Event reducer ──────────────────────────────────────────────────

  applyEvent(event: AgentEvent): void {
    const seq = parseInt(event.seq, 10);
    if (!isNaN(seq) && seq > this.lastKnownSeq) {
      this.lastKnownSeq = seq;
    }
    this.lastEventAt = new Date();

    // Push to ring buffer
    const serialized: SerializedAgentEvent = {
      seq,
      timestamp: event.timestamp,
      event_type: event.event_type,
      source: event.source,
      ...(event.worker_id != null ? { worker_id: event.worker_id } : {}),
      phase: event.phase,
      level: event.level,
      payload: event.payload,
      run_id: event.run_id,
    };
    this.recentEvents.push(serialized);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }

    const data = parsePayload(event.payload);

    switch (event.event_type) {
      // ── Phase ────────────────────────────────────────────────────
      case "PhaseChangeRequested":
      case "PhaseTransition": {
        const phase = (data["phase"] ?? data["to"] ?? event.phase) as string;
        if (phase) this.phase = phase;
        break;
      }

      // ── Worker lifecycle ─────────────────────────────────────────
      case "WorkerSessionAssigned": {
        const workerId =
          event.worker_id ??
          (data["worker_id"] as number | undefined) ??
          (data["id"] as number | undefined);
        if (workerId == null) break;
        const label = (data["label"] ?? data["task"] ?? `worker-${workerId}`) as string;
        const model = (event.model ?? data["model"] ?? "") as string;
        if (!this.workers.has(workerId)) {
          this.workers.set(workerId, {
            id: workerId,
            label,
            lifecycle: "declared",
            activity: "",
            cost: 0,
            steps: 0,
            model,
            elapsedMs: 0,
            startedAt: null,
          });
        } else {
          const w = this.workers.get(workerId)!;
          if (label) w.label = label;
          if (model) w.model = model;
        }
        break;
      }

      case "WorkerActive": {
        const workerId = event.worker_id ?? (data["worker_id"] as number | undefined);
        if (workerId == null) break;
        this.ensureWorker(workerId, event).lifecycle = "running";
        const w = this.workers.get(workerId)!;
        w.startedAt = w.startedAt ?? Date.now();
        break;
      }

      case "WorkerIdle": {
        const workerId = event.worker_id ?? (data["worker_id"] as number | undefined);
        if (workerId == null) break;
        this.ensureWorker(workerId, event).lifecycle = "idle";
        break;
      }

      case "WorkerCompleted": {
        const workerId = event.worker_id ?? (data["worker_id"] as number | undefined);
        if (workerId == null) break;
        const w = this.ensureWorker(workerId, event);
        w.lifecycle = "completed";
        w.activity = "";
        break;
      }

      case "WorkerFailed": {
        const workerId = event.worker_id ?? (data["worker_id"] as number | undefined);
        if (workerId == null) break;
        const w = this.ensureWorker(workerId, event);
        w.lifecycle = "failed";
        w.activity = (data["reason"] as string) ?? "";
        break;
      }

      case "WorkerAborted":
      case "WorkerStopped": {
        const workerId = event.worker_id ?? (data["worker_id"] as number | undefined);
        if (workerId == null) break;
        const lifecycle = event.event_type === "WorkerAborted" ? "aborted" : "stopped";
        this.ensureWorker(workerId, event).lifecycle = lifecycle;
        break;
      }

      // ── Worker activity text ─────────────────────────────────────
      case "WorkerActivity": {
        const workerId = event.worker_id ?? (data["worker_id"] as number | undefined);
        if (workerId == null) break;
        const text = (data["activity"] ?? data["text"] ?? data["message"] ?? "") as string;
        if (text) this.ensureWorker(workerId, event).activity = text;
        break;
      }

      // ── Cost + steps ─────────────────────────────────────────────
      case "WorkerCostUpdate": {
        const workerId = event.worker_id ?? (data["worker_id"] as number | undefined);
        const cost =
          (data["cost_usd"] as number | undefined) ??
          (data["total_cost"] as number | undefined) ??
          0;
        const steps =
          (data["steps"] as number | undefined) ?? (data["step_count"] as number | undefined) ?? 0;
        if (workerId != null) {
          const w = this.ensureWorker(workerId, event);
          w.cost = cost;
          if (steps > 0) w.steps = steps;
        }
        this.recalcTotalCost();
        break;
      }

      // ── Manager is also a worker (id 999) ────────────────────────
      case "ManagerActive": {
        const w = this.ensureWorker(999, event);
        w.lifecycle = "running";
        w.label = "Manager";
        w.startedAt = w.startedAt ?? Date.now();
        break;
      }

      case "ManagerCompleted": {
        const w = this.ensureWorker(999, event);
        w.lifecycle = "completed";
        w.activity = "";
        break;
      }

      default:
        // Unhandled events still appear in the event stream UI
        break;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private ensureWorker(id: number, event: AgentEvent): ChicoWorker {
    if (!this.workers.has(id)) {
      this.workers.set(id, {
        id,
        label: id === 999 ? "Manager" : `worker-${id}`,
        lifecycle: "declared",
        activity: "",
        cost: 0,
        steps: 0,
        model: event.model ?? "",
        elapsedMs: 0,
        startedAt: null,
      });
    }
    return this.workers.get(id)!;
  }

  private recalcTotalCost(): void {
    let total = 0;
    for (const w of this.workers.values()) {
      total += w.cost;
    }
    this.totalCostUsd = total;
  }

  // ── Snapshot ────────────────────────────────────────────────────────

  toSnapshot(): ChicoRunSnapshot {
    return {
      runId: this.runId,
      containerId: this.containerId,
      projectName: this.projectName,
      status: this.status,
      phase: this.phase,
      workers: Array.from(this.workers.values()),
      totalCostUsd: this.totalCostUsd,
      recentEvents: [...this.recentEvents],
      connectedAt: this.connectedAt.toISOString(),
      lastEventAt: this.lastEventAt?.toISOString() ?? null,
      lastKnownSeq: this.lastKnownSeq,
    };
  }
}
