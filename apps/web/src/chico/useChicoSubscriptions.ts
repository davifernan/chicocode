/**
 * useChicoSubscriptions — bootstraps Chico data and keeps the store live.
 *
 * Call once near the root of the Chico view tree.
 * On mount:
 *   1. Fetches server info and initial run list.
 *   2. Subscribes to chico.* WS push channels.
 *
 * @module useChicoSubscriptions
 */

import { useEffect } from "react";
import { useChicoStore } from "./chicoStore";
import { ensureNativeApi } from "../nativeApi";

export function useChicoSubscriptions(): void {
  const store = useChicoStore();

  useEffect(() => {
    let cancelled = false;

    // ── Bootstrap ──────────────────────────────────────────────────
    const bootstrap = async () => {
      store.setBootstrapping(true);
      store.setBootstrapError(null);
      try {
        const api = ensureNativeApi();
        const [info, runs] = await Promise.all([api.chico.getServerInfo(), api.chico.getRuns()]);
        if (cancelled) return;
        store.setServerInfo(info);
        for (const run of runs) {
          store.upsertRun(run);
        }
      } catch (err) {
        if (cancelled) return;
        store.setBootstrapError(String(err));
      } finally {
        if (!cancelled) store.setBootstrapping(false);
      }
    };

    void bootstrap();

    // ── Live subscriptions ─────────────────────────────────────────
    const liveApi = ensureNativeApi();

    const unsubRegistered = liveApi.chico.onRunRegistered((payload) => {
      store.upsertRun(payload);
    });

    const unsubDisconnected = liveApi.chico.onRunDisconnected((payload) => {
      store.markRunDisconnected(payload.runId);
    });

    // onRunEvent carries a single event — we don't store individual events
    // here; the EventStream component subscribes directly for live display.
    const unsubEvent = liveApi.chico.onRunEvent((_payload) => {
      // Intentionally a no-op at the store level.
      // EventStream components subscribe to nativeApi directly for low-latency display.
    });

    const unsubStateUpdate = liveApi.chico.onRunStateUpdate((payload) => {
      store.applyRunStateUpdate(payload.runId, payload.snapshot);
    });

    return () => {
      cancelled = true;
      unsubRegistered();
      unsubDisconnected();
      unsubEvent();
      unsubStateUpdate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once — store actions are stable
}
