import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { OpenCodeSseClient } from "./OpenCodeSseClient.ts";

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

describe("OpenCodeSseClient", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        if (server.listening) {
          await close(server);
        }
      }),
    );
  });

  it("waits for the SSE stream to connect and preserves chunked event data", async () => {
    let response: http.ServerResponse | null = null;
    const server = http.createServer((req, res) => {
      if (req.url !== "/global/event") {
        res.writeHead(404);
        res.end();
        return;
      }

      response = res;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();

      setTimeout(() => {
        res.write('data: {"directory":"/repo","payload":{"type":"message.created",');
      }, 10);
      setTimeout(() => {
        res.write('"properties":{"sessionID":"session-1","role":"assistant",');
      }, 20);
      setTimeout(() => {
        res.write('"id":"msg-1"}}}\n\n');
      }, 30);
    });
    servers.push(server);

    const port = await listen(server);
    const client = new OpenCodeSseClient();
    const eventPromise = new Promise<{
      readonly directory?: string;
      readonly type: string;
      readonly sessionId?: string;
      readonly role?: string;
      readonly id?: string;
    }>((resolve) => {
      client.onEvent((event) => {
        resolve({
          type: event.payload.type,
          ...(event.directory ? { directory: event.directory } : {}),
          ...(typeof event.payload.properties.sessionID === "string"
            ? { sessionId: event.payload.properties.sessionID }
            : {}),
          ...(typeof event.payload.properties.role === "string"
            ? { role: event.payload.properties.role }
            : {}),
          ...(typeof event.payload.properties.id === "string"
            ? { id: event.payload.properties.id }
            : {}),
        });
      });
    });

    client.connect(`http://127.0.0.1:${port}`, "Basic test");

    await expect(client.waitUntilConnected(1_000)).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(true);

    await expect(eventPromise).resolves.toEqual({
      directory: "/repo",
      type: "message.created",
      sessionId: "session-1",
      role: "assistant",
      id: "msg-1",
    });

    client.disconnect();
    (response as http.ServerResponse | null)?.end();
  });
});
