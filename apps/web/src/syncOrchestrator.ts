/**
 * syncOrchestrator - Client-orchestrated thread sync between local and remote servers.
 *
 * Sync protocol (runs after remote connection is established, BEFORE transport switch):
 *
 *  1. GET local manifest  → sync.getThreadManifest on local transport
 *  2. GET remote manifest → sync.getThreadManifest on remote transport (via tunnel)
 *  3. Compare manifests:
 *     - only-local threads   → push queue  (local → remote)
 *     - only-remote threads  → pull queue  (remote → local)
 *     - both, same version   → skip
 *     - both, version differ → warn + skip (diverged)
 *  4. For each thread in push queue:
 *     a. export events via local transport: sync.exportThreadEvents(threadId)
 *     b. send events via remote transport: sync.receiveEvents(events)
 *  5. For each thread in pull queue:
 *     a. export events via remote transport: sync.exportThreadEvents(threadId)
 *     b. send events via local transport: sync.receiveEvents(events)
 *  6. Report progress via onProgress callback
 *  7. Return a SyncSummary with totals
 *
 * @module syncOrchestrator
 */
import type { SyncThreadManifestEntry, OrchestrationEvent } from "@t3tools/contracts";

import { WsTransport } from "./wsTransport";

// ── Types ────────────────────────────────────────────────────────────

export interface SyncProgress {
  /** Total threads to process (push + pull). */
  total: number;
  pushed: number;
  pulled: number;
  skipped: number;
  diverged: string[]; // threadIds that diverged (warn-only)
  currentThreadId: string | null;
}

export interface SyncSummary {
  pushed: number;
  pulled: number;
  skipped: number;
  diverged: string[];
  errors: string[];
}

const SYNC_EVENT_BATCH_SIZE = 100;

// ── Transport helper ──────────────────────────────────────────────────

async function getManifest(transport: WsTransport): Promise<SyncThreadManifestEntry[]> {
  const result = await transport.request<{ threads: SyncThreadManifestEntry[] }>(
    "sync.getThreadManifest",
  );
  return result.threads;
}

async function exportThreadEvents(
  localTransport: WsTransport,
  threadId: string,
): Promise<OrchestrationEvent[]> {
  const result = await localTransport.request<{ events: OrchestrationEvent[] }>(
    "sync.exportThreadEvents",
    { threadId },
  );
  return result.events;
}

async function receiveEvents(
  remoteTransport: WsTransport,
  events: OrchestrationEvent[],
): Promise<{ accepted: number; skipped: number }> {
  return remoteTransport.request<{ accepted: number; skipped: number }>("sync.receiveEvents", {
    events,
  });
}

// ── Main orchestrator ─────────────────────────────────────────────────

export async function runSync(
  localTransport: WsTransport,
  tunnelWsUrl: string,
  onProgress: (progress: SyncProgress) => void,
  signal?: AbortSignal,
): Promise<SyncSummary> {
  const remoteTransport = new WsTransport(tunnelWsUrl);

  // Give remote transport a moment to connect
  await new Promise((res) => setTimeout(res, 1_500));

  const errors: string[] = [];
  const diverged: string[] = [];
  let pushed = 0;
  let pulled = 0;
  let skipped = 0;

  try {
    // Step 1+2: get both manifests in parallel
    const [localManifest, remoteManifest] = await Promise.all([
      getManifest(localTransport),
      getManifest(remoteTransport),
    ]);

    const remoteByThreadId = new Map<string, SyncThreadManifestEntry>(
      remoteManifest.map((e) => [e.threadId, e]),
    );
    const localByThreadId = new Map<string, SyncThreadManifestEntry>(
      localManifest.map((e) => [e.threadId, e]),
    );

    // Step 3: compute push queue (local-only → remote) and pull queue (remote-only → local)
    const pushQueue: string[] = [];
    for (const local of localManifest) {
      if (signal?.aborted) break;
      const remote = remoteByThreadId.get(local.threadId);
      if (!remote) {
        // Thread only exists locally → push to remote
        pushQueue.push(local.threadId);
      } else if (remote.maxStreamVersion !== local.maxStreamVersion) {
        // Both have it but different versions → warn and skip (safe)
        diverged.push(local.threadId);
      }
      // else: same version → skip silently
    }

    const pullQueue: string[] = [];
    for (const remote of remoteManifest) {
      if (signal?.aborted) break;
      if (!localByThreadId.has(remote.threadId)) {
        // Thread only exists on remote → pull to local
        pullQueue.push(remote.threadId);
      }
      // diverged and same-version already handled in the push pass above
    }

    const total = pushQueue.length + pullQueue.length;
    onProgress({
      total,
      pushed: 0,
      pulled: 0,
      skipped: skipped + (localManifest.length - pushQueue.length - diverged.length),
      diverged,
      currentThreadId: null,
    });

    // Step 4: push each local-only thread to remote
    for (const threadId of pushQueue) {
      if (signal?.aborted) break;

      onProgress({ total, pushed, pulled, skipped, diverged, currentThreadId: threadId });

      try {
        const events = await exportThreadEvents(localTransport, threadId);

        // Batch events to avoid oversized WS frames
        let accepted = 0;
        let threadSkipped = 0;
        for (let i = 0; i < events.length; i += SYNC_EVENT_BATCH_SIZE) {
          const batch = events.slice(i, i + SYNC_EVENT_BATCH_SIZE);
          const result = await receiveEvents(remoteTransport, batch);
          accepted += result.accepted;
          threadSkipped += result.skipped;
        }

        pushed += 1;
        skipped += threadSkipped > 0 && accepted === 0 ? 1 : 0;
      } catch (err) {
        errors.push(
          `Failed to push thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 5: pull each remote-only thread to local
    for (const threadId of pullQueue) {
      if (signal?.aborted) break;

      onProgress({ total, pushed, pulled, skipped, diverged, currentThreadId: threadId });

      try {
        const events = await exportThreadEvents(remoteTransport, threadId);

        // Batch events to avoid oversized WS frames — same pattern as push
        let accepted = 0;
        let threadSkipped = 0;
        for (let i = 0; i < events.length; i += SYNC_EVENT_BATCH_SIZE) {
          const batch = events.slice(i, i + SYNC_EVENT_BATCH_SIZE);
          const result = await receiveEvents(localTransport, batch);
          accepted += result.accepted;
          threadSkipped += result.skipped;
        }

        pulled += 1;
        skipped += threadSkipped > 0 && accepted === 0 ? 1 : 0;
      } catch (err) {
        errors.push(
          `Failed to pull thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    remoteTransport.dispose();
  }

  return { pushed, pulled, skipped, diverged, errors };
}
