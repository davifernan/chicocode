/**
 * OpenCodeSessionSync - Materializes discovered OpenCode sessions as T3Code threads.
 *
 * The sync is fully idempotent: it compares remote sessions against a local
 * `provider_thread_catalog` snapshot (passed in by the caller) and produces
 * the minimal set of orchestration commands and catalog upserts required to
 * bring the local state up to date.
 *
 * The caller is responsible for:
 * 1. Dispatching the returned `thread.create` commands through the orchestration engine.
 * 2. Persisting the returned `catalogUpserts` to the `provider_thread_catalog` table.
 *
 * @module OpenCodeSessionSync
 */

import crypto from "node:crypto";

import type { OpenCodeClient } from "./OpenCodeClient.ts";
import type {
  DiscoveredOpenCodeSession,
  OpenCodeSessionDiscovery,
} from "./OpenCodeSessionDiscovery.ts";
import { canonicalizeWorkspacePath } from "./workspaceIdentity.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary of a single sync run. */
export interface SyncResult {
  /** Number of new threads created. */
  readonly created: number;
  /** Number of existing threads whose catalog entry was updated (e.g. title/timestamp change). */
  readonly updated: number;
  /** Number of sessions already in sync — no action taken. */
  readonly unchanged: number;
  /** Per-session errors that did not abort the overall sync. */
  readonly errors: ReadonlyArray<{ sessionId: string; error: string }>;
}

/** Shape of a `thread.create` command produced by the sync. */
export interface SyncThreadCreateCommand {
  readonly type: "thread.create";
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly model: string;
  readonly runtimeMode: "full-access";
  readonly interactionMode: "default";
  readonly provider: "opencode";
  readonly source: "discovered";
  readonly externalSessionId: string;
  readonly branch: null;
  readonly worktreePath: null;
  readonly createdAt: string;
}

/** Shape of a catalog upsert produced by the sync. */
export interface SyncCatalogUpsert {
  readonly providerKind: "opencode";
  readonly workspaceRootCanonical: string;
  readonly externalSessionId: string;
  readonly threadId: string;
  readonly title: string;
  readonly externalUpdatedAt: string;
  readonly syncedAt: string;
}

/** Existing catalog entry as provided by the caller (pre-fetched from DB). */
export interface ExistingCatalogEntry {
  readonly threadId: string;
  readonly externalUpdatedAt: string;
}

/** Full return value of `syncSessionsForDirectory`. */
export interface SyncOutput {
  readonly commands: ReadonlyArray<SyncThreadCreateCommand>;
  readonly catalogUpserts: ReadonlyArray<SyncCatalogUpsert>;
  readonly result: SyncResult;
}

/** Default model assigned to discovered OpenCode threads. */
const DEFAULT_OPENCODE_MODEL = "claude-sonnet-4-20250514";

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export class OpenCodeSessionSync {
  constructor(
    private readonly discovery: OpenCodeSessionDiscovery,
    private readonly client: OpenCodeClient,
  ) {}

  /**
   * Sync OpenCode sessions for a workspace directory into T3Code threads.
   *
   * Returns orchestration commands to dispatch for creating threads, catalog
   * upserts to persist, and a summary result. The operation is idempotent:
   * re-running with the same inputs will produce zero commands and zero upserts
   * once everything is in sync.
   *
   * @param directory       - Workspace directory to discover sessions for.
   * @param projectId       - T3Code project that discovered threads belong to.
   * @param existingCatalogEntries - Map keyed by `externalSessionId`, pre-fetched
   *   from `provider_thread_catalog` for the same provider/workspace pair.
   */
  async syncSessionsForDirectory(
    directory: string,
    projectId: string,
    existingCatalogEntries: Map<string, ExistingCatalogEntry>,
  ): Promise<SyncOutput> {
    const canonicalPath = canonicalizeWorkspacePath(directory);
    const now = new Date().toISOString();

    let discovered: DiscoveredOpenCodeSession[];
    try {
      discovered = await this.discovery.discoverSessions(directory);
    } catch (err) {
      // If we can't reach the OpenCode server at all, return a single error
      // rather than throwing — the caller can decide how to handle it.
      return {
        commands: [],
        catalogUpserts: [],
        result: {
          created: 0,
          updated: 0,
          unchanged: 0,
          errors: [
            {
              sessionId: "*",
              error: `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        },
      };
    }

    const commands: SyncThreadCreateCommand[] = [];
    const catalogUpserts: SyncCatalogUpsert[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const errors: Array<{ sessionId: string; error: string }> = [];

    for (const session of discovered) {
      if (session.parentId?.trim()) {
        continue;
      }
      try {
        const externalUpdatedAt = toIsoFromEpochMs(session.updatedAt);
        const existing = existingCatalogEntries.get(session.sessionId);

        if (!existing) {
          // ------- New session — create thread + catalog entry -------
          const threadId = crypto.randomUUID();
          const createdAt = toIsoFromEpochMs(session.createdAt) || now;

          commands.push({
            type: "thread.create",
            threadId,
            projectId,
            title: session.title,
            model: DEFAULT_OPENCODE_MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            provider: "opencode",
            source: "discovered",
            externalSessionId: session.sessionId,
            branch: null,
            worktreePath: null,
            createdAt,
          });

          catalogUpserts.push({
            providerKind: "opencode",
            workspaceRootCanonical: canonicalPath,
            externalSessionId: session.sessionId,
            threadId,
            title: session.title,
            externalUpdatedAt,
            syncedAt: now,
          });

          created++;
        } else if (existing.externalUpdatedAt !== externalUpdatedAt) {
          // ------- Session updated remotely — update catalog -------
          catalogUpserts.push({
            providerKind: "opencode",
            workspaceRootCanonical: canonicalPath,
            externalSessionId: session.sessionId,
            threadId: existing.threadId,
            title: session.title,
            externalUpdatedAt,
            syncedAt: now,
          });

          updated++;
        } else {
          // ------- Already in sync -------
          unchanged++;
        }
      } catch (err) {
        errors.push({
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      commands,
      catalogUpserts,
      result: { created, updated, unchanged, errors },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an epoch-millis timestamp to ISO-8601 string.
 * Returns an empty string for zero/missing values so the caller can
 * fall back to `now`.
 */
function toIsoFromEpochMs(epochMs: number): string {
  if (!epochMs || epochMs <= 0) return "";
  return new Date(epochMs).toISOString();
}
