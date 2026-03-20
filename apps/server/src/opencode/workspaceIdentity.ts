/**
 * workspaceIdentity - Path canonicalization for consistent workspace comparison.
 *
 * Resolves symlinks and normalizes workspace paths so that discovery and
 * catalog lookups are immune to superficial path differences (trailing slashes,
 * relative segments, symlink indirection, etc.).
 *
 * @module workspaceIdentity
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Normalize a workspace path to a canonical form for consistent comparison. */
export function canonicalizeWorkspacePath(inputPath: string): string {
  try {
    return realpathSync(resolve(inputPath));
  } catch {
    // If realpath fails (e.g., path doesn't exist yet), fall back to resolve.
    return resolve(inputPath);
  }
}
