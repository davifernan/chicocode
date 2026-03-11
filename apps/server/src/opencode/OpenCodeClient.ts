/**
 * OpenCodeClient - HTTP client for OpenCode server REST API.
 *
 * Handles authentication via HTTP Basic Auth and provides methods for all
 * OpenCode REST endpoints. All non-global endpoints require a directory
 * context, passed via the `x-opencode-directory` header to scope operations
 * to the correct OpenCode instance (worktree).
 *
 * Uses native `fetch` — no external HTTP libraries.
 *
 * @module OpenCodeClient
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Session info returned by GET /session and POST /session. */
export interface OpenCodeSession {
  readonly id: string;
  readonly title: string;
  readonly directory?: string | undefined;
  readonly slug?: string | undefined;
  readonly parentID?: string | undefined;
  readonly time?: {
    readonly created?: number | undefined;
    readonly updated?: number | undefined;
    readonly archived?: number | undefined;
  };
}

/** Message info (metadata for both user and assistant messages). */
export interface OpenCodeMessageInfo {
  readonly id: string;
  readonly sessionID: string;
  readonly role: "user" | "assistant" | "system";
  readonly agent?: string | undefined;
  readonly cost?: number | undefined;
  readonly tokens?: OpenCodeTokenData | undefined;
  readonly time?: {
    readonly created?: number | undefined;
    readonly completed?: number | undefined;
  };
}

/** Token usage data attached to a message. */
export interface OpenCodeTokenData {
  readonly input: number;
  readonly output: number;
  readonly reasoning?: number | undefined;
  readonly cache?: { readonly read: number; readonly write: number } | undefined;
}

/** Text content part. */
export interface OpenCodeTextPart {
  readonly type: "text";
  readonly id?: string | undefined;
  readonly text: string;
}

/** Tool call content part. */
export interface OpenCodeToolPart {
  readonly type: "tool";
  readonly id?: string | undefined;
  readonly tool?: string | undefined;
  readonly callID?: string | undefined;
  [key: string]: unknown;
}

/** Step-finish marker content part. */
export interface OpenCodeStepFinishPart {
  readonly type: "step-finish";
  readonly id?: string | undefined;
  readonly cost?: number | undefined;
  [key: string]: unknown;
}

/** Catch-all for future part types. */
export interface OpenCodeUnknownPart {
  readonly type: string;
  readonly id?: string | undefined;
  [key: string]: unknown;
}

/** Discriminated union of message content parts. */
export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeToolPart
  | OpenCodeStepFinishPart
  | OpenCodeUnknownPart;

/** A message with its content parts (GET /session/:id/message response item). */
export interface OpenCodeMessage {
  readonly info: OpenCodeMessageInfo;
  readonly parts: ReadonlyArray<OpenCodePart>;
}

/** Health check response from GET /global/health. */
export interface OpenCodeHealthResponse {
  readonly healthy: boolean;
  readonly version?: string | undefined;
}

/** Body for POST /session/:id/prompt_async. */
export interface OpenCodePromptPart {
  readonly type: "text";
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OpenCodeClientError extends Error {
  override readonly name = "OpenCodeClientError";
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`OpenCode API error (${status}): ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const encoded = btoa(`${username}:${password}`);
    this.authHeader = `Basic ${encoded}`;
  }

  /**
   * Create a client from environment variables.
   *
   * Reads configuration from:
   * - `OPENCODE_SERVER_URL` (default: `http://localhost:4096`)
   * - `OPENCODE_SERVER_USERNAME` (required)
   * - `OPENCODE_SERVER_PASSWORD` (required)
   */
  static fromEnv(): OpenCodeClient {
    const baseUrl = process.env.OPENCODE_SERVER_URL ?? "http://localhost:4096";
    const username = process.env.OPENCODE_SERVER_USERNAME;
    const password = process.env.OPENCODE_SERVER_PASSWORD;

    if (!username) {
      throw new Error("OPENCODE_SERVER_USERNAME is not set");
    }
    if (!password) {
      throw new Error("OPENCODE_SERVER_PASSWORD is not set");
    }

    return new OpenCodeClient(baseUrl, username, password);
  }

  /** Return the `Authorization` header value for external use (e.g. SSE). */
  getAuthHeader(): string {
    return this.authHeader;
  }

  /** Return the base URL for external use (e.g. SSE endpoint construction). */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  // -----------------------------------------------------------------------
  // Global endpoints
  // -----------------------------------------------------------------------

  /**
   * Perform a health check on the OpenCode server.
   *
   * @returns Health status and optional version string.
   */
  async health(): Promise<OpenCodeHealthResponse> {
    const resp = await this.fetch("GET", "/global/health");
    if (!resp.ok) {
      return { healthy: false };
    }
    try {
      return (await resp.json()) as OpenCodeHealthResponse;
    } catch {
      // If the body isn't JSON but status is 2xx, treat as healthy.
      return { healthy: true };
    }
  }

  // -----------------------------------------------------------------------
  // Session endpoints
  // -----------------------------------------------------------------------

  /**
   * List sessions for a given directory.
   *
   * @param directory - Working directory path for instance scoping.
   * @param opts.roots - Only return root sessions (no parentID).
   * @param opts.limit - Maximum number of sessions to return.
   */
  async listSessions(
    directory: string,
    opts?: { roots?: boolean; limit?: number },
  ): Promise<OpenCodeSession[]> {
    const params = new URLSearchParams();
    if (opts?.roots) params.set("roots", "true");
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const path = qs ? `/session?${qs}` : "/session";
    return this.fetchJson<OpenCodeSession[]>("GET", path, directory);
  }

  /**
   * Get a single session by ID.
   *
   * @param sessionId - Session identifier.
   * @param directory - Working directory path for instance scoping.
   */
  async getSession(sessionId: string, directory: string): Promise<OpenCodeSession> {
    return this.fetchJson<OpenCodeSession>("GET", `/session/${sessionId}`, directory);
  }

  /**
   * Create a new session.
   *
   * @param directory - Working directory path for instance scoping.
   * @param title - Optional human-readable title.
   */
  async createSession(directory: string, title?: string): Promise<OpenCodeSession> {
    const body = title !== undefined ? { title } : undefined;
    return this.fetchJson<OpenCodeSession>("POST", "/session", directory, body);
  }

  /**
   * Get messages from a session, ordered chronologically.
   *
   * @param sessionId - Session identifier.
   * @param directory - Working directory path for instance scoping.
   */
  async getMessages(sessionId: string, directory: string): Promise<OpenCodeMessage[]> {
    return this.fetchJson<OpenCodeMessage[]>("GET", `/session/${sessionId}/message`, directory);
  }

  /**
   * Send a prompt asynchronously (fire-and-forget).
   *
   * Use this to submit work without waiting for completion.
   * Monitor progress via SSE events instead.
   *
   * @param sessionId - Session identifier.
   * @param message - Text prompt to send.
   * @param directory - Working directory path for instance scoping.
   */
  async sendPromptAsync(sessionId: string, message: string, directory: string): Promise<void> {
    const body = {
      parts: [{ type: "text" as const, text: message }],
    };
    const resp = await this.fetch("POST", `/session/${sessionId}/prompt_async`, directory, body);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new OpenCodeClientError(resp.status, detail);
    }
  }

  /**
   * Abort a running session.
   *
   * @param sessionId - Session identifier.
   * @param directory - Working directory path for instance scoping.
   */
  async abortSession(sessionId: string, directory: string): Promise<void> {
    const resp = await this.fetch("POST", `/session/${sessionId}/abort`, directory);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new OpenCodeClientError(resp.status, detail);
    }
  }

  // -----------------------------------------------------------------------
  // Internal fetch helpers
  // -----------------------------------------------------------------------

  /**
   * Low-level fetch wrapper that attaches auth and optional directory header.
   */
  private async fetch(
    method: string,
    path: string,
    directory?: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
    };
    if (directory) {
      headers["x-opencode-directory"] = directory;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    return globalThis.fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Fetch helper that parses JSON response and throws on non-2xx.
   */
  private async fetchJson<T>(
    method: string,
    path: string,
    directory?: string,
    body?: unknown,
  ): Promise<T> {
    const resp = await this.fetch(method, path, directory, body);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new OpenCodeClientError(resp.status, detail);
    }
    return (await resp.json()) as T;
  }
}
