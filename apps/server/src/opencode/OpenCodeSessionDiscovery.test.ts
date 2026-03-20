import { describe, expect, it, vi } from "vitest";

import type { OpenCodeClient } from "./OpenCodeClient.ts";
import { OpenCodeSessionDiscovery } from "./OpenCodeSessionDiscovery.ts";

describe("OpenCodeSessionDiscovery", () => {
  it("filters child sessions from discovery results", async () => {
    const client = {
      listSessions: vi.fn(async () => [
        {
          id: "root-session",
          title: "Root session",
          directory: "/repo",
          time: { created: 1, updated: 2 },
        },
        {
          id: "child-session",
          title: "Child session",
          directory: "/repo",
          parentID: "root-session",
          time: { created: 3, updated: 4 },
        },
      ]),
    } as Pick<OpenCodeClient, "listSessions"> as OpenCodeClient;

    const discovery = new OpenCodeSessionDiscovery(client);

    await expect(discovery.discoverSessions("/repo")).resolves.toEqual([
      {
        sessionId: "root-session",
        title: "Root session",
        directory: "/repo",
        createdAt: 1,
        updatedAt: 2,
        slug: "root-session",
        parentId: undefined,
      },
    ]);
    expect(client.listSessions).toHaveBeenCalledWith("/repo", { roots: true });
  });

  it("ignores child-session directories during orphaned discovery", async () => {
    const client = {
      listSessions: vi.fn(async () => [
        {
          id: "child-only",
          title: "Child only",
          directory: "/repo-child-only",
          parentID: "parent-session",
        },
        {
          id: "root-session",
          title: "Root session",
          directory: "/repo-root",
        },
        {
          id: "global-root",
          title: "Global root",
          directory: "/",
        },
      ]),
    } as Pick<OpenCodeClient, "listSessions"> as OpenCodeClient;

    const discovery = new OpenCodeSessionDiscovery(client);

    await expect(discovery.discoverOrphanedDirectories()).resolves.toEqual(["/repo-root"]);
    expect(client.listSessions).toHaveBeenCalledWith("/", { limit: 5_000 });
  });
});
