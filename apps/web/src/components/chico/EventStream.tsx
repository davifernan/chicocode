/**
 * EventStream — live scrolling feed of OrchestratorEvents for a run.
 *
 * Subscribes directly to nativeApi.chico.onRunEvent for the selected run
 * so individual events appear immediately without going through the store.
 * Also renders the recentEvents snapshot from the run for initial population.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { cn } from "../../lib/utils";
import type { ChicoRunSnapshot, ChicoSerializedEvent } from "@t3tools/contracts";
import { eventLevelColor } from "./utils";
import { ensureNativeApi } from "../../nativeApi";

const MAX_EVENTS = 300;

function EventRow({ event }: { event: ChicoSerializedEvent }) {
  const time = event.timestamp
    ? new Date(event.timestamp).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";

  const workerLabel =
    event.worker_id != null
      ? event.worker_id === 999
        ? "mgr"
        : `w${event.worker_id}`
      : event.source
        ? event.source.replace("worker-", "w").replace("watchbuddy", "wb")
        : "";

  return (
    <div className="flex items-baseline gap-2 px-3 py-0.5 text-[11px] font-mono leading-5 hover:bg-accent/10 transition-colors">
      <span className="text-muted-foreground/40 shrink-0 tabular-nums w-[60px]">{time}</span>
      {workerLabel && (
        <span className="text-primary/60 shrink-0 w-[28px] truncate text-right">{workerLabel}</span>
      )}
      <span className={cn("shrink-0 text-[10px] tracking-wide", eventLevelColor(event.level))}>
        {event.event_type.length > 24 ? event.event_type.slice(0, 22) + ".." : event.event_type}
      </span>
      <span className="text-muted-foreground/70 truncate flex-1 min-w-0">
        {summarizePayload(event.payload)}
      </span>
    </div>
  );
}

function summarizePayload(raw: string): string {
  if (!raw || raw === "{}") return "";
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const keys = ["activity", "text", "message", "reason", "phase", "to", "label", "task"];
    for (const key of keys) {
      if (typeof data[key] === "string" && (data[key] as string).length > 0) {
        const val = data[key] as string;
        return val.length > 80 ? val.slice(0, 78) + "…" : val;
      }
    }
    return "";
  } catch {
    return "";
  }
}

interface Props {
  run: ChicoRunSnapshot;
}

export function EventStream({ run }: Props) {
  const [events, setEvents] = useState<ChicoSerializedEvent[]>(() =>
    run.recentEvents.slice(-MAX_EVENTS),
  );
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Sync initial recentEvents when run snapshot changes (e.g. run switch)
  useEffect(() => {
    setEvents(run.recentEvents.slice(-MAX_EVENTS));
  }, [run.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to live events for THIS run
  useEffect(() => {
    const unsub = ensureNativeApi().chico.onRunEvent((payload) => {
      if (payload.runId !== run.runId) return;
      setEvents((prev) => {
        const next = [...prev, payload.event];
        return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      });
    });
    return unsub;
  }, [run.runId]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    isAtBottomRef.current = atBottom;
    setAutoScroll(atBottom);
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-muted/20">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50">
          Events
        </span>
        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true);
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            }}
            className="text-[10px] text-primary hover:underline"
          >
            ↓ Follow
          </button>
        )}
      </div>

      {/* Scrollable event list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        {events.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground/40 font-mono">
            Waiting for events…
          </div>
        ) : (
          events.map((e) => <EventRow key={`${e.seq}-${e.event_type}`} event={e} />)
        )}
      </div>
    </div>
  );
}
