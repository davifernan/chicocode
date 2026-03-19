/**
 * BroadcastChannel-based communication between the main window and the dev logs
 * popout window.
 *
 * Works in all modern browsers and Electron's Chromium engine.
 */

const CHANNEL_NAME = "t3code-dev-logs-v1";

/** Sent from the MAIN window to the popout. */
export interface ActiveProjectMessage {
  type: "active-project";
  projectId: string;
  projectName: string;
  devServerRunning: boolean;
}

/**
 * Sent from the POPOUT window to the main window.
 * Asks the main window to re-broadcast the current active project — used when
 * the popout initialises after the last "active-project" message was sent.
 */
export interface RequestSyncMessage {
  type: "request-sync";
}

export type PopoutMessage = ActiveProjectMessage | RequestSyncMessage;

/**
 * Used by the MAIN window — broadcasts messages to any open popout windows
 * and listens for "request-sync" from the popout.
 * Create once per session; call `close()` on unmount.
 */
export class PopoutBroadcaster {
  private readonly channel = new BroadcastChannel(CHANNEL_NAME);
  private syncRequestHandler: (() => void) | null = null;

  send(msg: ActiveProjectMessage): void {
    // BroadcastChannel.postMessage does not take a targetOrigin (unlike window.postMessage)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    this.channel.postMessage(msg);
  }

  /**
   * Registers a callback invoked when the popout requests a sync.
   * The callback should call `send()` with the current active project.
   */
  onSyncRequest(cb: () => void): () => void {
    const handler = (e: MessageEvent<PopoutMessage>) => {
      if (e.data.type === "request-sync") cb();
    };
    this.channel.addEventListener("message", handler);
    this.syncRequestHandler = cb;
    return () => {
      this.channel.removeEventListener("message", handler);
      if (this.syncRequestHandler === cb) this.syncRequestHandler = null;
    };
  }

  close(): void {
    this.channel.close();
  }
}

/**
 * Used by the POPOUT window — receives active-project messages and can request
 * a sync from the main window.
 * Call `close()` on unmount.
 */
export class PopoutReceiver {
  private readonly channel = new BroadcastChannel(CHANNEL_NAME);

  /** Subscribes to incoming active-project messages. Returns an unsubscribe function. */
  onMessage(cb: (msg: ActiveProjectMessage) => void): () => void {
    const handler = (e: MessageEvent<PopoutMessage>) => {
      if (e.data.type === "active-project") cb(e.data);
    };
    this.channel.addEventListener("message", handler);
    return () => {
      this.channel.removeEventListener("message", handler);
    };
  }

  /** Asks the main window to re-send the current active project. */
  requestSync(): void {
    const msg: RequestSyncMessage = { type: "request-sync" };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    this.channel.postMessage(msg);
  }

  close(): void {
    this.channel.close();
  }
}
