import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenCodeClient } from "./OpenCodeClient.ts";

describe("OpenCodeClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends prompt tool overrides to prompt_async", async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 204 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new OpenCodeClient("http://127.0.0.1:4096", "opencode", "secret");
    await client.sendPromptAsync("session-1", "hello", "/repo", {
      agent: "build",
      tools: { question: false },
      variant: "fast",
    });

    const [url, init] = fetchMock.mock.calls[0]!;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe("http://127.0.0.1:4096/session/session-1/prompt_async");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: expect.stringMatching(/^Basic /),
        "Content-Type": "application/json",
        "x-opencode-directory": "/repo",
      }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      parts: [{ type: "text", text: "hello" }],
      agent: "build",
      tools: { question: false },
      variant: "fast",
    });
  });

  it("replies to question requests through the question endpoint", async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify(true), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new OpenCodeClient("http://127.0.0.1:4096", "opencode", "secret");
    await client.replyQuestion("question-1", [["yes"], ["custom answer"]], "/repo");

    const [url, init] = fetchMock.mock.calls[0]!;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe("http://127.0.0.1:4096/question/question-1/reply");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: expect.stringMatching(/^Basic /),
        "Content-Type": "application/json",
        "x-opencode-directory": "/repo",
      }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      answers: [["yes"], ["custom answer"]],
    });
  });

  it("aborts a running session through the session abort endpoint", async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify(true), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new OpenCodeClient("http://127.0.0.1:4096", "opencode", "secret");
    await client.abortSession("session-1", "/repo");

    const [url, init] = fetchMock.mock.calls[0]!;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe("http://127.0.0.1:4096/session/session-1/abort");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: expect.stringMatching(/^Basic /),
        "x-opencode-directory": "/repo",
      }),
    });
  });
});
