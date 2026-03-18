import http from "node:http";
import assert from "node:assert/strict";

import { afterEach, describe, expect, it } from "vitest";

import { OpenCodeProcessManager, openCodeServerControl } from "./OpenCodeProcessManager.ts";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine test server address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function attachMissingServer(this: OpenCodeProcessManager, url: string) {
  const parsed = new URL(url);
  const manager = this as any;
  manager._hostname = parsed.hostname;
  manager._port = parsed.port ? Number(parsed.port) : 4096;
  return false;
}

async function reportManagedServerHealth(this: OpenCodeProcessManager) {
  return Boolean((this as any)._running);
}

describe("openCodeServerControl.refreshStatus", () => {
  afterEach(async () => {
    const status = openCodeServerControl.getStatus();
    if (status.state === "running" && status.managedByT3 && openCodeServerControl.canStop) {
      await openCodeServerControl.stop();
    }
    await openCodeServerControl.refreshStatus();
  });

  it("clears a stale attached running status when the external server stops", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/global/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ healthy: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const port = await listen(server);
    const serverUrl = `http://127.0.0.1:${port}`;

    await openCodeServerControl.start({ serverUrl });
    expect(openCodeServerControl.getStatus()).toEqual({
      state: "running",
      url: serverUrl,
      managedByT3: false,
    });

    await close(server);

    await expect(openCodeServerControl.refreshStatus()).resolves.toEqual({ state: "stopped" });
    expect(openCodeServerControl.getStatus()).toEqual({ state: "stopped" });
  });

  it("attaches to an already-running external server when refreshing from stopped", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/global/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ healthy: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const originalUrl = process.env.OPENCODE_SERVER_URL;
    const originalUsername = process.env.OPENCODE_SERVER_USERNAME;
    const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;

    try {
      const port = await listen(server);
      const serverUrl = `http://127.0.0.1:${port}`;
      process.env.OPENCODE_SERVER_URL = serverUrl;
      process.env.OPENCODE_SERVER_USERNAME = "opencode";
      process.env.OPENCODE_SERVER_PASSWORD = "";

      await expect(openCodeServerControl.refreshStatus({ serverUrl })).resolves.toEqual({
        state: "running",
        url: serverUrl,
        managedByT3: false,
      });
      expect(openCodeServerControl.getStatus()).toEqual({
        state: "running",
        url: serverUrl,
        managedByT3: false,
      });
    } finally {
      if (originalUrl === undefined) delete process.env.OPENCODE_SERVER_URL;
      else process.env.OPENCODE_SERVER_URL = originalUrl;
      if (originalUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
      else process.env.OPENCODE_SERVER_USERNAME = originalUsername;
      if (originalPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = originalPassword;
      await close(server);
    }
  });

  it("deduplicates concurrent starts so only one managed process is created", async () => {
    const originalAttach = OpenCodeProcessManager.prototype.attach;
    const originalStart = OpenCodeProcessManager.prototype.start;
    const originalIsHealthy = OpenCodeProcessManager.prototype.isHealthy;
    const originalStop = OpenCodeProcessManager.prototype.stop;

    let startCalls = 0;
    let stopCalls = 0;

    OpenCodeProcessManager.prototype.attach = attachMissingServer;

    OpenCodeProcessManager.prototype.start = async function start(opts?: { port?: number }) {
      startCalls += 1;
      const manager = this as any;
      manager._hostname = "127.0.0.1";
      manager._port = opts?.port ?? 4096;
      manager._running = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    };

    OpenCodeProcessManager.prototype.isHealthy = reportManagedServerHealth;

    OpenCodeProcessManager.prototype.stop = async function stop() {
      stopCalls += 1;
      (this as any)._running = false;
    };

    try {
      const serverUrl = "http://127.0.0.1:4198";
      await Promise.all([
        openCodeServerControl.start({ port: 4198, serverUrl }),
        openCodeServerControl.start({ port: 4198, serverUrl }),
      ]);

      assert.equal(startCalls, 1);
      expect(openCodeServerControl.getStatus()).toEqual({
        state: "running",
        url: serverUrl,
        managedByT3: true,
      });
      assert.equal(openCodeServerControl.canStop, true);

      await openCodeServerControl.stop();

      assert.equal(stopCalls, 1);
      expect(openCodeServerControl.getStatus()).toEqual({ state: "stopped" });
    } finally {
      OpenCodeProcessManager.prototype.attach = originalAttach;
      OpenCodeProcessManager.prototype.start = originalStart;
      OpenCodeProcessManager.prototype.isHealthy = originalIsHealthy;
      OpenCodeProcessManager.prototype.stop = originalStop;
    }
  });
});
