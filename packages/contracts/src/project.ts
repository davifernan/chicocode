import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

// ── Git repo discovery ────────────────────────────────────────────────

/**
 * Input for project.resolveGitRepos — scans a workspace root for git repos.
 * Checks the root itself first; if not a git repo, scans one level of subdirs.
 */
export const ProjectResolveGitReposInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
});
export type ProjectResolveGitReposInput = typeof ProjectResolveGitReposInput.Type;

/** A discovered git repository with its remote URL and current branch. */
export const DiscoveredGitRepo = Schema.Struct({
  /** Path relative to the scanned workspaceRoot (e.g. "." or "frontend"). */
  relativePath: Schema.String,
  /** Absolute path on the scanning machine. */
  absolutePath: TrimmedNonEmptyString,
  /** Remote URL for the "origin" remote (or first remote found). */
  remoteUrl: TrimmedNonEmptyString,
  /** Currently checked-out branch name. */
  branch: Schema.String,
});
export type DiscoveredGitRepo = typeof DiscoveredGitRepo.Type;

export const ProjectResolveGitReposResult = Schema.Struct({
  repos: Schema.Array(DiscoveredGitRepo),
});
export type ProjectResolveGitReposResult = typeof ProjectResolveGitReposResult.Type;

// ── Git clone on remote ───────────────────────────────────────────────

/** A single repo to clone on the remote server. */
export const GitCloneTarget = Schema.Struct({
  remoteUrl: TrimmedNonEmptyString,
  /** Absolute target path on the remote server. */
  targetPath: TrimmedNonEmptyString,
  /** Branch to checkout after clone. Defaults to the remote's default branch. */
  branch: Schema.optional(Schema.String),
});
export type GitCloneTarget = typeof GitCloneTarget.Type;

export const ProjectGitCloneInput = Schema.Struct({
  repos: Schema.Array(GitCloneTarget),
});
export type ProjectGitCloneInput = typeof ProjectGitCloneInput.Type;

export const GitCloneResult = Schema.Struct({
  targetPath: TrimmedNonEmptyString,
  success: Schema.Boolean,
  /** Already existed as a valid git repo — skipped. */
  skipped: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type GitCloneResult = typeof GitCloneResult.Type;

export const ProjectGitCloneResult = Schema.Struct({
  results: Schema.Array(GitCloneResult),
});
export type ProjectGitCloneResult = typeof ProjectGitCloneResult.Type;
