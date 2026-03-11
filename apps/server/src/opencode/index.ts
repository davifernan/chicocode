/**
 * OpenCode provider module — barrel exports.
 *
 * Aggregates the OpenCode HTTP client, process manager, SSE client, and auth
 * manager for use by the rest of the T3Code server.
 *
 * @module opencode
 */

export {
  OpenCodeClient,
  OpenCodeClientError,
  type OpenCodeHealthResponse,
  type OpenCodeMessage,
  type OpenCodeMessageInfo,
  type OpenCodePart,
  type OpenCodePromptPart,
  type OpenCodeSession,
  type OpenCodeStepFinishPart,
  type OpenCodeTextPart,
  type OpenCodeTokenData,
  type OpenCodeToolPart,
  type OpenCodeUnknownPart,
} from "./OpenCodeClient.ts";

export { OpenCodeProcessManager } from "./OpenCodeProcessManager.ts";

export {
  OpenCodeSseClient,
  type OpenCodeSseEvent,
  type OpenCodeSseEventHandler,
  type OpenCodeSseEventPayload,
} from "./OpenCodeSseClient.ts";

export {
  OpenCodeAuthManager,
  type OpenCodeAuthApi,
  type OpenCodeAuthEntry,
  type OpenCodeAuthOauth,
  type OpenCodeAuthStatus,
  type OpenCodeAuthWellKnown,
} from "./OpenCodeAuthManager.ts";

export {
  OpenCodeSessionDiscovery,
  type DiscoveredOpenCodeSession,
} from "./OpenCodeSessionDiscovery.ts";

export {
  OpenCodeSessionSync,
  type ExistingCatalogEntry,
  type SyncCatalogUpsert,
  type SyncOutput,
  type SyncResult,
  type SyncThreadCreateCommand,
} from "./OpenCodeSessionSync.ts";

export { canonicalizeWorkspacePath } from "./workspaceIdentity.ts";
