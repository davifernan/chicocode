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
  readonly providerID?: string | undefined;
  readonly modelID?: string | undefined;
  readonly variant?: string | undefined;
  readonly cost?: number | undefined;
  readonly tokens?: OpenCodeTokenData | undefined;
  readonly time?: {
    readonly created?: number | undefined;
    readonly completed?: number | undefined;
  };
}

export interface OpenCodeTodo {
  readonly content: string;
  readonly status: string;
  readonly priority: string;
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

/** Project info as returned by GET /project. */
export interface OpenCodeProject {
  readonly id: string;
  readonly worktree: string;
  readonly vcs?: string | undefined;
  readonly time?: {
    readonly created?: number | undefined;
    readonly updated?: number | undefined;
  };
}

/** Model capabilities as returned by GET /provider. */
export interface OpenCodeModelCapabilities {
  readonly temperature: boolean;
  readonly reasoning: boolean;
  readonly attachment: boolean;
  readonly toolcall: boolean;
}

/** Model cost info as returned by GET /provider. */
export interface OpenCodeModelCost {
  readonly input: number;
  readonly output: number;
  readonly cache?: { readonly read: number; readonly write: number } | undefined;
}

/** Model context limits as returned by GET /provider. */
export interface OpenCodeModelLimit {
  readonly context: number;
  readonly input?: number | undefined;
  readonly output: number;
}

/** A single model within a provider from GET /provider. */
export interface OpenCodeProviderModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly family?: string | undefined;
  readonly capabilities?: OpenCodeModelCapabilities | undefined;
  readonly cost?: OpenCodeModelCost | undefined;
  readonly limit?: OpenCodeModelLimit | undefined;
  readonly status?: "alpha" | "beta" | "deprecated" | "active" | undefined;
  readonly release_date?: string | undefined;
  readonly variants?: Record<string, Record<string, unknown>> | undefined;
}

/** A provider entry from GET /provider. */
export interface OpenCodeProvider {
  readonly id: string;
  readonly name: string;
  readonly models: Record<string, OpenCodeProviderModel>;
}

/** Response from GET /provider. */
export interface OpenCodeProviderListResponse {
  readonly all: readonly OpenCodeProvider[];
  readonly default: Record<string, string>;
  readonly connected: readonly string[];
}

export interface OpenCodeAgentInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden?: boolean | undefined;
  readonly color?: string | undefined;
  readonly variant?: string | undefined;
  readonly model?:
    | {
        readonly providerID: string;
        readonly modelID: string;
      }
    | undefined;
}

export interface OpenCodeModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

/** Body for POST /session/:id/prompt_async. */
export interface OpenCodePromptPart {
  readonly type: "text";
  readonly text: string;
}

export interface OpenCodeQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface OpenCodeQuestionInfo {
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<OpenCodeQuestionOption>;
  readonly multiple?: boolean | undefined;
  readonly custom?: boolean | undefined;
}

export interface OpenCodeQuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: ReadonlyArray<OpenCodeQuestionInfo>;
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
  // Provider endpoints
  // -----------------------------------------------------------------------

  /**
   * List all available providers and their models.
   *
   * Returns providers with nested models, a map of default models per provider,
   * and which providers are currently connected (have valid API keys).
   *
   * @param directory - Working directory path for instance scoping.
   */
  async listProviders(directory: string): Promise<OpenCodeProviderListResponse> {
    return this.fetchJson<OpenCodeProviderListResponse>("GET", "/provider", directory);
  }

  /**
   * List all OpenCode agents visible to the current instance.
   *
   * @param directory - Working directory path for instance scoping.
   */
  async listAgents(directory: string): Promise<OpenCodeAgentInfo[]> {
    return this.fetchJson<OpenCodeAgentInfo[]>("GET", "/agent", directory);
  }

  async resolveModelRef(
    directory: string,
    selectedModel: string | null | undefined,
  ): Promise<OpenCodeModelRef | undefined> {
    const trimmed = selectedModel?.trim();
    if (!trimmed) {
      return undefined;
    }

    const providers = await this.listProviders(directory);
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex > 0) {
      const providerID = trimmed.slice(0, slashIndex);
      const modelID = trimmed.slice(slashIndex + 1);
      const provider = providers.all.find((entry) => entry.id === providerID);
      if (provider?.models[modelID]) {
        return { providerID, modelID };
      }
    }

    for (const provider of providers.all) {
      if (provider.models[trimmed]) {
        return {
          providerID: provider.id,
          modelID: trimmed,
        };
      }
    }

    return undefined;
  }

  // -----------------------------------------------------------------------
  // Project endpoints
  // -----------------------------------------------------------------------

  /**
   * List all projects known to the OpenCode server.
   *
   * @param directory - Any valid directory for instance scoping.
   */
  async listProjects(directory: string): Promise<OpenCodeProject[]> {
    return this.fetchJson<OpenCodeProject[]>("GET", "/project", directory);
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

  async getTodos(sessionId: string, directory: string): Promise<ReadonlyArray<OpenCodeTodo>> {
    return this.fetchJson<ReadonlyArray<OpenCodeTodo>>(
      "GET",
      `/session/${sessionId}/todo`,
      directory,
    );
  }

  /**
   * Send a prompt asynchronously with OpenCode-specific agent/model overrides.
   *
   * Use this to submit work without waiting for completion.
   * Monitor progress via SSE events instead.
   *
   * @param sessionId - Session identifier.
   * @param message - Text prompt to send.
   * @param directory - Working directory path for instance scoping.
   * @param options - Optional model / agent / variant overrides.
   */
  async sendPromptAsync(
    sessionId: string,
    message: string,
    directory: string,
    options?: {
      readonly agent?: string;
      readonly model?: OpenCodeModelRef;
      readonly tools?: Record<string, boolean>;
      readonly variant?: string;
    },
  ): Promise<void> {
    const body = {
      parts: [{ type: "text" as const, text: message }],
      ...(options?.agent ? { agent: options.agent } : {}),
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.tools ? { tools: options.tools } : {}),
      ...(options?.variant ? { variant: options.variant } : {}),
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

  async replyQuestion(
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
    directory?: string,
  ): Promise<void> {
    const resp = await this.fetch("POST", `/question/${requestId}/reply`, directory, { answers });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new OpenCodeClientError(resp.status, detail);
    }
  }

  async rejectQuestion(requestId: string, directory?: string): Promise<void> {
    const resp = await this.fetch("POST", `/question/${requestId}/reject`, directory);
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
