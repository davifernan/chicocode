/**
 * OpenCodeSseClient - SSE client for the `/global/event` endpoint.
 *
 * Subscribes to the OpenCode server's global SSE stream and dispatches parsed
 * events to registered handlers. Implements auto-reconnect with exponential
 * backoff and heartbeat timeout detection (following Chico's 90 s convention).
 *
 * Uses manual `fetch`-based SSE parsing because Node/Bun do not ship a native
 * `EventSource` that supports custom `Authorization` headers.
 *
 * SSE data format:
 * ```
 * data: {"directory":"...","payload":{"type":"...","properties":{...}}}
 * ```
 *
 * @module OpenCodeSseClient
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload envelope for a single SSE event. */
export interface OpenCodeSseEventPayload {
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

/** Top-level SSE event (global format — wraps directory + payload). */
export interface OpenCodeSseEvent {
  readonly directory?: string | undefined;
  readonly payload: OpenCodeSseEventPayload;
}

export type OpenCodeSseEventHandler = (event: OpenCodeSseEvent) => void;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Heartbeat timeout — if no event arrives within this window, reconnect. */
const HEARTBEAT_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OpenCodeSseClient {
  private abortController: AbortController | null = null;
  private handlers: OpenCodeSseEventHandler[] = [];
  private connected = false;
  private connecting = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private shouldReconnect = false;
  private connectedWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];

  private sseBaseUrl = "";
  private sseAuthHeader = "";

  /**
   * Connect to the OpenCode global SSE event stream.
   *
   * Subscribes to `{baseUrl}/global/event` using the provided auth header.
   * Automatically reconnects with exponential backoff on disconnection.
   *
   * @param baseUrl - OpenCode server base URL (e.g. `http://127.0.0.1:4096`).
   * @param authHeader - Complete `Authorization` header value (e.g. `Basic ...`).
   */
  connect(baseUrl: string, authHeader: string): void {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    const sameTarget = this.sseBaseUrl === normalizedBaseUrl && this.sseAuthHeader === authHeader;

    if (sameTarget && (this.connected || this.connecting)) {
      this.shouldReconnect = true;
      return;
    }

    if (this.connected || this.connecting || this.abortController) {
      this.disconnect();
    }

    this.sseBaseUrl = normalizedBaseUrl;
    this.sseAuthHeader = authHeader;
    this.shouldReconnect = true;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

    this.startConnection();
  }

  /**
   * Wait until the SSE stream is connected.
   *
   * Resolves immediately when the stream is already active. Otherwise waits
   * until a connection is established or the timeout elapses.
   */
  waitUntilConnected(timeoutMs = 5_000): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectedWaiters = this.connectedWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Timed out waiting for OpenCode SSE connection after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.connectedWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
    });
  }

  /**
   * Register an event handler.
   *
   * Handlers are called synchronously for each parsed SSE event.
   * Multiple handlers may be registered.
   */
  onEvent(handler: OpenCodeSseEventHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Remove a previously registered event handler.
   */
  offEvent(handler: OpenCodeSseEventHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  /**
   * Disconnect from the SSE stream and stop reconnecting.
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.connected = false;
    this.connecting = false;
    this.clearHeartbeat();
    this.rejectConnectedWaiters("OpenCode SSE connection was disconnected before becoming ready.");

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /** Whether the client currently has an active SSE connection. */
  isConnected(): boolean {
    return this.connected;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private startConnection(): void {
    if (this.connecting) {
      return;
    }

    const url = `${this.sseBaseUrl}/global/event`;
    this.abortController = new AbortController();
    this.connecting = true;
    const { signal } = this.abortController;

    const connect = async () => {
      try {
        const response = await globalThis.fetch(url, {
          method: "GET",
          headers: {
            Authorization: this.sseAuthHeader,
            Accept: "text/event-stream",
          },
          signal,
        });

        if (!response.ok) {
          this.connecting = false;
          console.error(`[OpenCodeSseClient] SSE connection failed: HTTP ${response.status}`);
          this.scheduleReconnect();
          return;
        }

        if (!response.body) {
          this.connecting = false;
          console.error("[OpenCodeSseClient] SSE response has no body");
          this.scheduleReconnect();
          return;
        }

        this.connected = true;
        this.connecting = false;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.resetHeartbeat();
        this.resolveConnectedWaiters();

        await this.consumeStream(response.body, signal);
      } catch (err) {
        this.connecting = false;
        if (signal.aborted) return; // Intentional disconnect.
        console.error(`[OpenCodeSseClient] SSE connection error: ${String(err)}`);
      } finally {
        this.connecting = false;
        this.connected = false;
        this.clearHeartbeat();
      }

      this.scheduleReconnect();
    };

    void connect();
  }

  /**
   * Read the SSE byte stream and parse events line-by-line.
   *
   * Implements the SSE protocol:
   * - Lines starting with `data:` contain event data
   * - Empty lines mark the end of an event
   * - Lines starting with `event:`, `id:`, or `:` are metadata/comments
   */
  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const processLines = (lines: ReadonlyArray<string>) => {
      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line.startsWith("data:")) {
          const payload = line.slice(5).trimStart();
          dataLines.push(payload);
          continue;
        }

        if (line.trim() === "") {
          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            this.handleData(data);
            dataLines = [];
          }
        }
      }
    };

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines.
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer.
        buffer = lines.pop() ?? "";

        processLines(lines);
      }

      const flushedBuffer = `${buffer}${decoder.decode()}`;
      if (flushedBuffer.length > 0) {
        processLines(flushedBuffer.split("\n"));
      }
      if (dataLines.length > 0) {
        this.handleData(dataLines.join("\n"));
      }
    } finally {
      reader.releaseLock();
    }
  }

  private resolveConnectedWaiters(): void {
    const waiters = this.connectedWaiters;
    this.connectedWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private rejectConnectedWaiters(message: string): void {
    if (this.connectedWaiters.length === 0) {
      return;
    }

    const waiters = this.connectedWaiters;
    this.connectedWaiters = [];
    const error = new Error(message);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  /**
   * Parse a single SSE data payload and dispatch to handlers.
   *
   * Supports both global format (`{directory, payload}`) and flat/server
   * format (`{payload: {type, properties}}`).
   */
  private handleData(data: string): void {
    this.resetHeartbeat();

    let event: OpenCodeSseEvent;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;

      if (parsed.payload && typeof parsed.payload === "object") {
        // Standard global format or server-level event.
        event = parsed as unknown as OpenCodeSseEvent;
      } else if (parsed.type && typeof parsed.type === "string") {
        // Flat/instance format — wrap it.
        event = {
          payload: parsed as unknown as OpenCodeSseEventPayload,
        };
      } else {
        return; // Unrecognized shape — skip.
      }
    } catch {
      return; // Malformed JSON — skip.
    }

    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error(`[OpenCodeSseClient] Handler error: ${String(err)}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private resetHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      console.warn(
        `[OpenCodeSseClient] Heartbeat timeout (${HEARTBEAT_TIMEOUT_MS}ms) — forcing reconnect`,
      );
      // Force-close the current connection so reconnect logic kicks in.
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Reconnect
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.startConnection();
      }
    }, delay);
  }
}
