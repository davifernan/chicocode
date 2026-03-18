import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { OpenCodeProject } from "./OpenCodeClient.ts";
import { canonicalizeWorkspacePath } from "./workspaceIdentity.ts";

// ---------------------------------------------------------------------------
// Temp-path detection
// ---------------------------------------------------------------------------

/**
 * Build a deduplicated set of system temp-directory prefix strings.
 *
 * Each candidate is added in BOTH its raw (symlink-unresolved) form and its
 * canonical (realpath) form. This handles the macOS case where /tmp is a
 * symlink to /private/tmp: a non-existent path like /tmp/sandbox/repo resolves
 * via node:path resolve (not realpathSync) to "/tmp/sandbox/repo", so we must
 * check it against the raw "/tmp" prefix, not just the canonical "/private/tmp".
 */
function buildTempPrefixes(): ReadonlySet<string> {
  const candidates = [tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/var/folders"];
  const prefixes = new Set<string>();
  for (const p of candidates) {
    const normalized = resolve(p).replace(/\/+$/, "");
    prefixes.add(normalized);
    try {
      prefixes.add(canonicalizeWorkspacePath(p));
    } catch {
      // ignore paths that don't exist on this OS
    }
  }
  return prefixes;
}

const TEMP_PREFIXES: ReadonlySet<string> = buildTempPrefixes();

/**
 * Returns true if the given path lives inside a system temp directory.
 * Used to skip transient sandbox worktrees that OpenCode creates during
 * agent runs (e.g. /private/tmp/chico-boot-xxx/repo).
 *
 * Checks both the raw resolved path and the canonical (realpath) form so that
 * non-existent paths (cleaned-up sandboxes) are still matched correctly.
 */
export function isTemporaryWorktree(worktreePath: string): boolean {
  const normalized = resolve(worktreePath).replace(/\/+$/, "");
  const canonical = canonicalizeWorkspacePath(worktreePath);

  for (const prefix of TEMP_PREFIXES) {
    if (
      normalized === prefix ||
      normalized.startsWith(prefix + "/") ||
      canonical === prefix ||
      canonical.startsWith(prefix + "/")
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Project deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate a flat list of OpenCode projects by canonical worktree path.
 * When the same worktree appears more than once (e.g. from multiple API
 * calls), keeps the entry with the most recent `time.updated`.
 */
export function mergeOpenCodeProjectsByWorktree(
  projectGroups: ReadonlyArray<ReadonlyArray<OpenCodeProject>>,
): OpenCodeProject[] {
  const projectsByWorktree = new Map<string, OpenCodeProject>();

  for (const projects of projectGroups) {
    for (const project of projects) {
      if (!project.worktree || project.worktree === "/") {
        continue;
      }

      const worktreeKey = canonicalizeWorkspacePath(project.worktree);
      const existing = projectsByWorktree.get(worktreeKey);
      if (!existing) {
        projectsByWorktree.set(worktreeKey, project);
        continue;
      }

      const existingUpdatedAt = existing.time?.updated ?? existing.time?.created ?? 0;
      const nextUpdatedAt = project.time?.updated ?? project.time?.created ?? 0;
      if (nextUpdatedAt > existingUpdatedAt) {
        projectsByWorktree.set(worktreeKey, project);
      }
    }
  }

  return [...projectsByWorktree.values()];
}
