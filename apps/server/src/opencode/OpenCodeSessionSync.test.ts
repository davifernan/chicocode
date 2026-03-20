import { describe, expect, it, vi } from "vitest";

import type { OpenCodeClient } from "./OpenCodeClient.ts";
import type { OpenCodeSessionDiscovery } from "./OpenCodeSessionDiscovery.ts";
import { OpenCodeSessionSync } from "./OpenCodeSessionSync.ts";

describe("OpenCodeSessionSync", () => {
  it("skips child sessions even when discovery returns them", async () => {
    const discovery = {
      discoverSessions: vi.fn(async () => [
        {
          sessionId: "root-session",
          title: "Root session",
          directory: "/repo",
          createdAt: 1,
          updatedAt: 2,
          slug: "root-session",
        },
        {
          sessionId: "child-session",
          title: "Child session",
          directory: "/repo",
          createdAt: 3,
          updatedAt: 4,
          slug: "child-session",
          parentId: "root-session",
        },
      ]),
    } as Pick<OpenCodeSessionDiscovery, "discoverSessions"> as OpenCodeSessionDiscovery;

    const sync = new OpenCodeSessionSync(discovery, {} as OpenCodeClient);

    const output = await sync.syncSessionsForDirectory("/repo", "project-1", new Map());

    expect(discovery.discoverSessions).toHaveBeenCalledWith("/repo");
    expect(output.result).toMatchObject({
      created: 1,
      updated: 0,
      unchanged: 0,
      errors: [],
    });
    expect(output.commands).toHaveLength(1);
    expect(output.commands[0]).toMatchObject({
      type: "thread.create",
      projectId: "project-1",
      title: "Root session",
      externalSessionId: "root-session",
      provider: "opencode",
    });
    expect(output.catalogUpserts).toHaveLength(1);
    expect(output.catalogUpserts[0]).toMatchObject({
      externalSessionId: "root-session",
      title: "Root session",
    });
  });
});
