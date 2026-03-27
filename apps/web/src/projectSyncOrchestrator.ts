/**
 * projectSyncOrchestrator - Auto-clone local git projects on the remote server.
 *
 * Runs after thread sync (and before appTransport switch) when:
 *   - A remote host tunnel is established
 *   - `config.autoCloneGitProjects` is true
 *   - `config.remoteWorkspaceBase` is set
 *
 * For each local project:
 *   1. Call `project.resolveGitRepos` on the LOCAL server to discover git repos
 *      (checks the workspaceRoot itself; if not a repo, scans one level of subdirs)
 *   2. For each discovered repo, compute the target path on the remote server:
 *      remoteWorkspaceBase / <project-dir-name> / <relative-path>
 *   3. Call `project.gitClone` on the REMOTE server (via tunnel)
 *   4. Report progress via the onProgress callback
 *
 * @module projectSyncOrchestrator
 */
import type { DiscoveredGitRepo, GitCloneResult, RemoteHostConfig } from "@t3tools/contracts";
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";

import { WsTransport } from "./wsTransport";

// ── Types ─────────────────────────────────────────────────────────────

export interface ProjectSyncProgress {
  total: number;
  cloned: number;
  skipped: number;
  failed: number;
  currentRemoteUrl: string | null;
}

export interface ProjectSyncSummary {
  cloned: number;
  skipped: number;
  failed: number;
  errors: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Derive the last path segment (project directory name) from a workspaceRoot. */
function projectDirName(workspaceRoot: string): string {
  // Normalise separators and remove trailing slash
  const normalised = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const parts = normalised.split("/");
  return parts[parts.length - 1] ?? "project";
}

/** Build the target absolute path on the remote server for a discovered repo. */
function remoteTargetPath(
  remoteWorkspaceBase: string,
  workspaceRoot: string,
  repo: DiscoveredGitRepo,
): string {
  const base = remoteWorkspaceBase.replace(/\\/g, "/").replace(/\/$/, "");
  const projectDir = projectDirName(workspaceRoot);

  if (repo.relativePath === ".") {
    // The workspace root itself is the git repo
    return `${base}/${projectDir}`;
  }
  // Sub-directory repo — preserve the relative path under the project dir
  return `${base}/${projectDir}/${repo.relativePath}`;
}

/** Discover git repos for a single project via the local transport. */
async function resolveGitRepos(
  localTransport: WsTransport,
  workspaceRoot: string,
): Promise<DiscoveredGitRepo[]> {
  const result = await localTransport.request<{ repos: DiscoveredGitRepo[] }>(
    WS_METHODS.projectResolveGitRepos,
    { workspaceRoot },
  );
  return result.repos;
}

/** Clone repos on the remote server via the tunnel transport. */
async function cloneRepos(
  remoteTransport: WsTransport,
  targets: Array<{ remoteUrl: string; targetPath: string; branch?: string }>,
): Promise<GitCloneResult[]> {
  const result = await remoteTransport.request<{ results: GitCloneResult[] }>(
    WS_METHODS.projectGitClone,
    { repos: targets },
  );
  return result.results;
}

// ── Main orchestrator ─────────────────────────────────────────────────

export async function runProjectSync(
  localTransport: WsTransport,
  tunnelWsUrl: string,
  config: RemoteHostConfig,
  /** List of { id, workspaceRoot } for all local projects. */
  localProjects: ReadonlyArray<{ id: string; workspaceRoot: string }>,
  onProgress: (progress: ProjectSyncProgress) => void,
  signal?: AbortSignal,
): Promise<ProjectSyncSummary> {
  if (!config.autoCloneGitProjects || !config.remoteWorkspaceBase.trim()) {
    return { cloned: 0, skipped: 0, failed: 0, errors: [] };
  }

  const remoteTransport = new WsTransport(tunnelWsUrl);
  // Wait for the remote WebSocket to be fully open. The tunnel is usually
  // already established at this point, but the new WS handshake still needs
  // to complete before we can send requests.
  await remoteTransport.waitUntilOpen(15_000);

  const errors: string[] = [];
  let cloned = 0;
  let skipped = 0;
  let failed = 0;

  try {
    // Collect all repos across all projects first so we can report total.
    // We also track which repos are the project root (relativePath === ".")
    // so we can update workspaceRoot on the remote server after cloning.
    type RepoTarget = {
      remoteUrl: string;
      targetPath: string;
      branch?: string;
      /** Identifies the owning project — used to update workspaceRoot after clone. */
      projectId: string;
      /** True when this repo is the project root (not a sub-directory repo). */
      isRootRepo: boolean;
    };
    const allTargets: RepoTarget[] = [];

    for (const project of localProjects) {
      if (signal?.aborted) break;
      try {
        const repos = await resolveGitRepos(localTransport, project.workspaceRoot);
        for (const repo of repos) {
          allTargets.push({
            remoteUrl: repo.remoteUrl,
            targetPath: remoteTargetPath(config.remoteWorkspaceBase, project.workspaceRoot, repo),
            ...(repo.branch ? { branch: repo.branch } : {}),
            projectId: project.id,
            isRootRepo: repo.relativePath === ".",
          });
        }
      } catch {
        // If discovery fails for a project, skip it silently
      }
    }

    const total = allTargets.length;
    onProgress({ total, cloned: 0, skipped: 0, failed: 0, currentRemoteUrl: null });

    if (total === 0) {
      return { cloned: 0, skipped: 0, failed: 0, errors: [] };
    }

    // Clone in batches of 5 to avoid flooding the tunnel
    const BATCH_SIZE = 5;
    for (let i = 0; i < allTargets.length; i += BATCH_SIZE) {
      if (signal?.aborted) break;
      const batch = allTargets.slice(i, i + BATCH_SIZE);

      onProgress({
        total,
        cloned,
        skipped,
        failed,
        currentRemoteUrl: batch[0]?.remoteUrl ?? null,
      });

      try {
        // Strip client-only fields before sending to the server
        const cloneTargets = batch.map(({ remoteUrl, targetPath, branch }) => ({
          remoteUrl,
          targetPath,
          ...(branch ? { branch } : {}),
        }));
        const results = await cloneRepos(remoteTransport, cloneTargets);
        for (const result of results) {
          if (result.skipped) {
            skipped += 1;
          } else if (result.success) {
            cloned += 1;
          } else {
            failed += 1;
            if (result.error) {
              errors.push(`Clone failed for ${result.targetPath}: ${result.error}`);
            }
          }

          // After a successful clone (or when the repo already exists), update
          // the project's workspaceRoot on the remote server to the remote path.
          // This is critical so the agent uses the correct CWD when running on
          // the remote instead of the local machine's path.
          if ((result.success || result.skipped) && !signal?.aborted) {
            const target = batch.find((t) => t.targetPath === result.targetPath);
            if (target?.isRootRepo) {
              try {
                await remoteTransport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, {
                  command: {
                    type: "project.meta.update",
                    commandId: crypto.randomUUID(),
                    projectId: target.projectId,
                    workspaceRoot: target.targetPath,
                  },
                });
              } catch {
                // Non-fatal: if the path doesn't exist yet on the remote or the
                // server normalisation rejects it, we skip silently. The agent
                // will still start — just potentially with the wrong cwd.
              }
            }
          }
        }
      } catch (err) {
        failed += batch.length;
        errors.push(`Clone batch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    remoteTransport.dispose();
  }

  return { cloned, skipped, failed, errors };
}
