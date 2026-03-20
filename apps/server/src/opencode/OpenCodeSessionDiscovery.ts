/**
 * OpenCodeSessionDiscovery - Discovers existing OpenCode sessions for a workspace.
 *
 * Queries the OpenCode HTTP server for root-level sessions scoped to a given
 * directory. The discovered sessions are returned in a normalized shape ready
 * for sync into T3Code's orchestration layer.
 *
 * @module OpenCodeSessionDiscovery
 */

import type { OpenCodeClient, OpenCodeMessage, OpenCodeSession } from "./OpenCodeClient.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Normalized representation of a remote OpenCode session. */
export interface DiscoveredOpenCodeSession {
  /** OpenCode session ID (UUID). */
  readonly sessionId: string;
  /** Human-readable title. */
  readonly title: string;
  /** Working directory the session is associated with. */
  readonly directory: string;
  /** Unix epoch millis when the session was created. */
  readonly createdAt: number;
  /** Unix epoch millis when the session was last updated. */
  readonly updatedAt: number;
  /** URL-safe slug derived from the title. */
  readonly slug: string;
  /** Parent session ID (absent for root sessions). */
  readonly parentId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export class OpenCodeSessionDiscovery {
  constructor(private readonly client: OpenCodeClient) {}

  /**
   * Discover root sessions for the given directory.
   *
   * Fetches all top-level sessions from the OpenCode server scoped to
   * `directory` and maps them into a consistent internal shape.
   *
   * @param directory - Workspace directory to discover sessions for.
   * @returns Array of discovered sessions, ordered by the server's default.
   */
  async discoverSessions(directory: string): Promise<DiscoveredOpenCodeSession[]> {
    const sessions = await this.client.listSessions(directory, { roots: true });
    return sessions.filter(isRootSession).map((s) => mapSession(s, directory));
  }

  /**
   * Discover unique project directories that have sessions stored under the
   * global OpenCode project (worktree `/`).
   *
   * Older versions of OpenCode stored all sessions under the global project
   * instead of registering per-worktree project entries. This method retrieves
   * sessions from that global context and returns the distinct `directory`
   * values so they can be treated as first-class projects during sync.
   *
   * @param limit - Max sessions to fetch when scanning. Defaults to 5000.
   * @returns Unique non-root directory paths found in global-project sessions.
   */
  async discoverOrphanedDirectories(limit = 5_000): Promise<string[]> {
    const sessions = await this.client.listSessions("/", { limit });
    const seen = new Set<string>();
    for (const s of sessions) {
      if (!isRootSession(s)) {
        continue;
      }
      const dir = s.directory;
      if (dir && dir !== "/" && !seen.has(dir)) {
        seen.add(dir);
      }
    }
    return [...seen];
  }

  /**
   * Fetch the full message history for a single session.
   *
   * @param sessionId - OpenCode session identifier.
   * @param directory - Workspace directory for request scoping.
   * @returns Chronologically ordered messages.
   */
  async fetchSessionMessages(sessionId: string, directory: string): Promise<OpenCodeMessage[]> {
    return this.client.getMessages(sessionId, directory);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapSession(raw: OpenCodeSession, directory: string): DiscoveredOpenCodeSession {
  return {
    sessionId: raw.id,
    title: raw.title || "Untitled session",
    directory: raw.directory ?? directory,
    createdAt: raw.time?.created ?? 0,
    updatedAt: raw.time?.updated ?? 0,
    slug: raw.slug ?? raw.id,
    parentId: raw.parentID ?? undefined,
  };
}

function isRootSession(session: OpenCodeSession): boolean {
  return (session.parentID ?? "").trim().length === 0;
}
