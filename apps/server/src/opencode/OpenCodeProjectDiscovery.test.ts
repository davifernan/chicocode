import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isTemporaryWorktree,
  mergeOpenCodeProjectsByWorktree,
} from "./OpenCodeProjectDiscovery.ts";
import { canonicalizeWorkspacePath } from "./workspaceIdentity.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("OpenCodeProjectDiscovery", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("isTemporaryWorktree", () => {
    it("returns true for paths under the system temp directory", () => {
      const tmpBase = canonicalizeWorkspacePath(os.tmpdir());
      expect(isTemporaryWorktree(path.join(tmpBase, "chico-boot-xxx", "repo"))).toBe(true);
    });

    it("returns true for /tmp paths", () => {
      // /tmp may or may not exist on the current OS, test by prefix logic
      expect(isTemporaryWorktree("/tmp/some-sandbox/project")).toBe(true);
    });

    it("returns true for /private/tmp paths (macOS)", () => {
      expect(isTemporaryWorktree("/private/tmp/some-sandbox/project")).toBe(true);
    });

    it("returns false for real user project paths", () => {
      expect(isTemporaryWorktree("/Users/dev/WebstormProjects/voicechat")).toBe(false);
      expect(isTemporaryWorktree("/home/dev/projects/t3code")).toBe(false);
    });

    it("returns false for paths that merely contain 'tmp' in the name", () => {
      expect(isTemporaryWorktree("/Users/dev/projects/my-tmp-project")).toBe(false);
    });
  });

  describe("mergeOpenCodeProjectsByWorktree", () => {
    it("dedupes projects by canonical worktree and keeps the newest entry", () => {
      const root = makeTempDir("t3code-opencode-projects-");
      const projectDir = path.join(root, "voicechat");
      const projectAlias = path.join(root, "voicechat-alias");
      fs.mkdirSync(projectDir);
      fs.symlinkSync(projectDir, projectAlias);

      const merged = mergeOpenCodeProjectsByWorktree([
        [
          {
            id: "project-1",
            worktree: projectDir,
            time: { updated: 10 },
          },
        ],
        [
          {
            id: "project-2",
            worktree: projectAlias,
            time: { updated: 20 },
          },
        ],
      ]);

      expect(merged).toEqual([
        {
          id: "project-2",
          worktree: projectAlias,
          time: { updated: 20 },
        },
      ]);
    });

    it("skips entries with missing or root worktree", () => {
      const merged = mergeOpenCodeProjectsByWorktree([
        [
          { id: "global", worktree: "/" },
          { id: "empty", worktree: "" },
        ],
      ]);
      expect(merged).toHaveLength(0);
    });
  });
});
