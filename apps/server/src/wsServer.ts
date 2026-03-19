/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import os from "node:os";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  MessageId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  type WsResponse as WsResponseMessage,
  WsResponse,
  type WsPushEnvelopeBase,
  RemoteHostConfig,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import { searchWorkspaceEntries } from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";

import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";
import { makeServerPushBus } from "./wsServer/pushBus.ts";
import { makeServerReadiness } from "./wsServer/readiness.ts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import { UiStateRepository } from "./persistence/Services/UiState.ts";
import { ProviderThreadCatalogRepository } from "./persistence/Services/ProviderThreadCatalog.ts";
import { RemoteHostService } from "./remoteHost/Services/RemoteHostService.ts";
import { testConnection } from "./remoteHost/Services/ConnectionChecker.ts";
import { SyncService } from "./sync/SyncService.ts";
import { SyncCursorRepository } from "./persistence/Services/SyncCursor.ts";
import {
  OpenCodeClient,
  type OpenCodeMessage,
  type OpenCodePart,
} from "./opencode/OpenCodeClient.ts";
import { buildOpenCodeThreadProviderMetadata } from "./opencode/providerMetadata.ts";
import { openCodeServerControl } from "./opencode/OpenCodeProcessManager.ts";
import { OpenCodeSessionDiscovery } from "./opencode/OpenCodeSessionDiscovery.ts";
import { devServerManager } from "./devServer/DevServerManager.ts";
import { OpenCodeSessionSync } from "./opencode/OpenCodeSessionSync.ts";
import {
  isTemporaryWorktree,
  mergeOpenCodeProjectsByWorktree,
} from "./opencode/OpenCodeProjectDiscovery.ts";
import { canonicalizeWorkspacePath } from "./opencode/workspaceIdentity.ts";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: Error): boolean => {
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toNullableIso(value: string | null | undefined): string | null {
  if (!value) return null;
  return value;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

const encodeWsResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));
const decodeWebSocketRequest = decodeJsonResult(WebSocketRequest);

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService
  | ProviderHealth;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TerminalManager
  | ProviderThreadCatalogRepository
  | UiStateRepository
  | Keybindings
  | Open
  | AnalyticsService
  | RemoteHostService
  | SyncService
  | SyncCursorRepository;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const uiStateRepository = yield* UiStateRepository;
  const providerThreadCatalogRepository = yield* ProviderThreadCatalogRepository;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remoteHostService = yield* RemoteHostService;
  const syncService = yield* SyncService;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");
  const readiness = yield* makeServerReadiness;

  function logOutgoingPush(push: WsPushEnvelopeBase, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      sequence: push.sequence,
      recipients,
      payload: push.data,
    });
  }

  const pushBus = yield* makeServerPushBus({
    clients,
    logOutgoingPush,
  });
  yield* readiness.markPushBusReady;
  yield* keybindingsManager.start.pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "keybindingsRuntimeStart", cause }),
    ),
  );
  yield* readiness.markKeybindingsReady;

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
      const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return normalizedWorkspaceRoot;
    });

    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                stateDir: serverConfig.stateDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                stateDir: serverConfig.stateDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (Exit.isFailure(streamExit)) {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        // ── OpenCode provider proxy ─────────────────────────────────
        // Proxies GET /api/opencode/providers to the running OpenCode
        // server's GET /provider endpoint. Returns the full provider
        // catalog (providers, models, connected status) so the web UI
        // can build a real model picker without needing auth credentials.
        if (url.pathname === "/api/opencode/providers" && req.method === "GET") {
          const requestedCwd = url.searchParams.get("cwd")?.trim() || cwd;
          const requestedServerUrl = url.searchParams.get("serverUrl")?.trim() || undefined;
          const requestedBinaryPath = url.searchParams.get("binaryPath")?.trim() || undefined;

          const result = yield* Effect.tryPromise({
            try: async () => {
              await openCodeServerControl.start({
                ...(requestedServerUrl ? { serverUrl: requestedServerUrl } : {}),
                ...(requestedBinaryPath ? { binaryPath: requestedBinaryPath } : {}),
              });
              const {
                url: ocServerUrl,
                username: ocUsername,
                password: ocPassword,
              } = openCodeServerControl.getCredentials();
              const client = new OpenCodeClient(ocServerUrl, ocUsername, ocPassword);
              return client.listProviders(requestedCwd);
            },
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }).pipe(Effect.result);

          if (Result.isSuccess(result)) {
            respond(
              200,
              {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify(result.success),
            );
          } else {
            const detail = result.failure;
            respond(
              502,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify({
                error: "Failed to fetch providers from OpenCode server",
                detail,
              }),
            );
          }
          return;
        }

        // ── OpenCode agent proxy ────────────────────────────────────
        // Proxies GET /api/opencode/agents to the running OpenCode
        // server's GET /agent endpoint so the web UI can render a real
        // agent/subagent picker for the current workspace.
        if (url.pathname === "/api/opencode/agents" && req.method === "GET") {
          const requestedCwd = url.searchParams.get("cwd")?.trim() || cwd;
          const requestedServerUrl = url.searchParams.get("serverUrl")?.trim() || undefined;
          const requestedBinaryPath = url.searchParams.get("binaryPath")?.trim() || undefined;

          const result = yield* Effect.tryPromise({
            try: async () => {
              await openCodeServerControl.start({
                ...(requestedServerUrl ? { serverUrl: requestedServerUrl } : {}),
                ...(requestedBinaryPath ? { binaryPath: requestedBinaryPath } : {}),
              });
              const {
                url: ocServerUrl,
                username: ocUsername,
                password: ocPassword,
              } = openCodeServerControl.getCredentials();
              const client = new OpenCodeClient(ocServerUrl, ocUsername, ocPassword);
              return client.listAgents(requestedCwd);
            },
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }).pipe(Effect.result);

          if (Result.isSuccess(result)) {
            respond(
              200,
              {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify(result.success),
            );
          } else {
            const detail = result.failure;
            respond(
              502,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify({
                error: "Failed to fetch agents from OpenCode server",
                detail,
              }),
            );
          }
          return;
        }

        // ── OpenCode server status ───────────────────────────────────
        if (url.pathname === "/api/opencode/server" && req.method === "GET") {
          const requestedServerUrl = url.searchParams.get("serverUrl")?.trim() || undefined;
          const status = yield* Effect.tryPromise({
            try: () =>
              openCodeServerControl.refreshStatus(
                requestedServerUrl ? { serverUrl: requestedServerUrl } : undefined,
              ),
            catch: () => openCodeServerControl.getStatus(),
          }).pipe(Effect.orElseSucceed(() => openCodeServerControl.getStatus()));

          respond(
            200,
            {
              "Content-Type": "application/json",
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*",
            },
            JSON.stringify(status),
          );
          return;
        }

        // ── OpenCode server start ────────────────────────────────────
        if (url.pathname === "/api/opencode/server/start" && req.method === "POST") {
          // Parse optional JSON body with { serverUrl?, binaryPath? }
          const startOpts = yield* Effect.tryPromise({
            try: async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of req)
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              const raw = Buffer.concat(chunks).toString("utf8").trim();
              if (!raw) return {};
              return JSON.parse(raw) as { serverUrl?: string; binaryPath?: string };
            },
            catch: () => ({}) as { serverUrl?: string; binaryPath?: string },
          });

          const startResult = yield* Effect.tryPromise({
            try: () =>
              openCodeServerControl.start({
                ...(startOpts.serverUrl ? { serverUrl: startOpts.serverUrl } : {}),
                ...(startOpts.binaryPath ? { binaryPath: startOpts.binaryPath } : {}),
              }),
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }).pipe(Effect.result);

          if (Result.isSuccess(startResult)) {
            respond(
              200,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify(openCodeServerControl.getStatus()),
            );

            // Fire-and-forget: sync OpenCode sessions into T3 threads
            void syncOpenCodeSessions().catch((err) => {
              logger.warn("Auto-sync of OpenCode sessions failed after server start", {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          } else {
            respond(
              502,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify({
                error: "Failed to start OpenCode server",
                detail: startResult.failure,
              }),
            );
          }
          return;
        }

        // ── OpenCode server stop ─────────────────────────────────────
        if (url.pathname === "/api/opencode/server/stop" && req.method === "POST") {
          if (!openCodeServerControl.canStop) {
            respond(
              409,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify({
                error: "Cannot stop: server was not started by T3 Code.",
              }),
            );
            return;
          }

          const stopResult = yield* Effect.tryPromise({
            try: () => openCodeServerControl.stop(),
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }).pipe(Effect.result);

          if (Result.isSuccess(stopResult)) {
            respond(
              200,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify(openCodeServerControl.getStatus()),
            );
          } else {
            respond(
              502,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify({
                error: "Failed to stop OpenCode server",
                detail: stopResult.failure,
              }),
            );
          }
          return;
        }

        // ── OpenCode session sync ────────────────────────────────────
        // Discovers existing OpenCode sessions and materializes them
        // as T3Code threads so they appear in the sidebar.
        if (url.pathname === "/api/opencode/sync-sessions" && req.method === "POST") {
          const syncResult = yield* Effect.tryPromise({
            try: () => syncOpenCodeSessions(),
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }).pipe(Effect.result);

          if (Result.isSuccess(syncResult)) {
            respond(
              200,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify(syncResult.success),
            );
          } else {
            respond(
              502,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify({
                error: "Session sync failed",
                detail: syncResult.failure,
              }),
            );
          }
          return;
        }

        // ── OpenCode thread message loading ──────────────────────────
        // Fetches messages from an OpenCode session and materializes
        // them as orchestration messages so they render in the chat view.
        const loadMessagesMatch =
          url.pathname.match(/^\/api\/opencode\/threads\/([^/]+)\/load-messages$/) ?? undefined;
        if (loadMessagesMatch && req.method === "POST") {
          const threadId = loadMessagesMatch[1]!;
          const loadResult = yield* Effect.tryPromise({
            try: () => loadOpenCodeThreadMessages(threadId),
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }).pipe(Effect.result);

          if (Result.isSuccess(loadResult)) {
            respond(
              200,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify(loadResult.success),
            );
          } else {
            respond(
              502,
              {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
              JSON.stringify({
                error: "Failed to load messages",
                detail: loadResult.failure,
              }),
            );
          }
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const OPEN_CODE_HYDRATION_CONCURRENCY = 2;
  const OPEN_CODE_BACKGROUND_HYDRATION_LIMIT = 8;
  const OPEN_CODE_HYDRATION_PRIORITY_OPEN = 0;
  const OPEN_CODE_HYDRATION_PRIORITY_BACKGROUND = 1;

  type OpenCodeHydrationQueueEntry = {
    readonly threadId: string;
    readonly priority: number;
    readonly force: boolean;
    readonly enqueuedAt: number;
    readonly reason: string;
  };

  const openCodeHydrationQueue = new Map<string, OpenCodeHydrationQueueEntry>();
  const openCodeHydrationInFlight = new Map<
    string,
    Promise<{ threadId: string; imported: number; refreshed: boolean; reason: string }>
  >();
  let openCodeHydrationsActive = 0;

  const persistOpenCodeCatalogUpsert = async (upsert: {
    providerKind: "opencode";
    workspaceRootCanonical: string;
    externalSessionId: string;
    threadId: string;
    title: string;
    externalUpdatedAt: string;
    syncedAt: string;
  }): Promise<void> => {
    await Effect.runPromise(
      providerThreadCatalogRepository.upsert({
        providerKind: upsert.providerKind,
        workspaceRootCanonical: upsert.workspaceRootCanonical,
        externalSessionId: upsert.externalSessionId,
        threadId: ThreadId.makeUnsafe(upsert.threadId),
        title: upsert.title,
        externalUpdatedAt: toNullableIso(upsert.externalUpdatedAt),
        syncedAt: upsert.syncedAt,
        mirroredExternalUpdatedAt: null,
        mirrorSyncedAt: null,
      }),
    );
  };

  const mapOpenCodeMessagesToSnapshot = (
    ocMessages: ReadonlyArray<OpenCodeMessage>,
  ): ReadonlyArray<{
    readonly messageId: MessageId;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: string;
  }> => {
    const imported: Array<{
      readonly messageId: MessageId;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly createdAt: string;
    }> = [];
    for (const ocMessage of ocMessages) {
      const role = ocMessage.info.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }

      const text = extractTextFromParts(ocMessage.parts, role);
      if (role === "assistant" && text.length === 0) {
        continue;
      }

      imported.push({
        messageId: MessageId.makeUnsafe(`oc:${ocMessage.info.id}`),
        role,
        text,
        createdAt: ocMessage.info.time?.created
          ? new Date(ocMessage.info.time.created).toISOString()
          : new Date().toISOString(),
      });
    }
    return imported;
  };

  const refreshOpenCodeThreadMirror = async (
    threadIdStr: string,
    options?: { readonly force?: boolean; readonly reason?: string },
  ): Promise<{ threadId: string; imported: number; refreshed: boolean; reason: string }> => {
    const existingRefresh = openCodeHydrationInFlight.get(threadIdStr);
    if (existingRefresh) {
      return existingRefresh;
    }

    const refreshPromise = (async () => {
      await openCodeServerControl.start();

      const snapshot = await Effect.runPromise(projectionReadModelQuery.getSnapshot());
      const thread = snapshot.threads.find(
        (entry) => entry.id === threadIdStr && entry.deletedAt === null,
      );
      if (!thread) {
        throw new Error(`Thread not found: ${threadIdStr}`);
      }
      if (thread.provider !== "opencode") {
        throw new Error(`Thread ${threadIdStr} is not an OpenCode thread`);
      }
      if (!thread.externalSessionId) {
        throw new Error(`Thread ${threadIdStr} has no external session ID`);
      }

      const project = snapshot.projects.find(
        (entry) => entry.id === thread.projectId && entry.deletedAt === null,
      );
      if (!project) {
        throw new Error(`Project not found for thread ${threadIdStr}`);
      }

      const catalogEntry = await Effect.runPromise(
        providerThreadCatalogRepository.getByThreadId({
          threadId: ThreadId.makeUnsafe(threadIdStr),
        }),
      );
      const force = options?.force === true;
      const resolvedCatalogEntry = Option.getOrUndefined(catalogEntry);
      const hasLocalMessages = thread.messages.length > 0;
      const remoteVersion = resolvedCatalogEntry?.externalUpdatedAt ?? null;
      const mirroredVersion = resolvedCatalogEntry?.mirroredExternalUpdatedAt ?? null;
      const shouldRefresh =
        force ||
        !hasLocalMessages ||
        resolvedCatalogEntry === undefined ||
        remoteVersion !== mirroredVersion;
      const reason = force
        ? (options?.reason ?? "forced")
        : !hasLocalMessages
          ? "empty-local-mirror"
          : resolvedCatalogEntry === undefined
            ? "missing-catalog-entry"
            : remoteVersion !== mirroredVersion
              ? "remote-newer-than-mirror"
              : (options?.reason ?? "already-fresh");

      if (!shouldRefresh) {
        return { threadId: threadIdStr, imported: 0, refreshed: false, reason };
      }

      const {
        url: ocUrl,
        username: ocUser,
        password: ocPass,
      } = openCodeServerControl.getCredentials();
      const client = new OpenCodeClient(ocUrl, ocUser, ocPass);

      const ocMessages = await client.getMessages(thread.externalSessionId, project.workspaceRoot);
      const ocTodos = await client
        .getTodos(thread.externalSessionId, project.workspaceRoot)
        .catch(() => [] as const);
      const importedMessages = mapOpenCodeMessagesToSnapshot(ocMessages);
      const providerMetadata = buildOpenCodeThreadProviderMetadata({
        messages: ocMessages,
        todos: ocTodos,
      });
      const createdAt = new Date().toISOString();

      await Effect.runPromise(
        orchestrationEngine.dispatch({
          type: "thread.messages.import-snapshot",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: ThreadId.makeUnsafe(threadIdStr),
          messages: importedMessages,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
          createdAt,
        }),
      );

      if (resolvedCatalogEntry === undefined) {
        await Effect.runPromise(
          providerThreadCatalogRepository.upsert({
            providerKind: "opencode",
            workspaceRootCanonical: canonicalizeWorkspacePath(project.workspaceRoot),
            externalSessionId: thread.externalSessionId,
            threadId: ThreadId.makeUnsafe(threadIdStr),
            title: thread.title,
            externalUpdatedAt: null,
            syncedAt: createdAt,
            mirroredExternalUpdatedAt: null,
            mirrorSyncedAt: null,
          }),
        );
      }

      await Effect.runPromise(
        providerThreadCatalogRepository.markMirrored({
          threadId: ThreadId.makeUnsafe(threadIdStr),
          mirroredExternalUpdatedAt: remoteVersion,
          mirrorSyncedAt: createdAt,
        }),
      );

      return {
        threadId: threadIdStr,
        imported: importedMessages.length,
        refreshed: true,
        reason,
      };
    })().finally(() => {
      openCodeHydrationInFlight.delete(threadIdStr);
    });

    openCodeHydrationInFlight.set(threadIdStr, refreshPromise);
    return refreshPromise;
  };

  const pumpOpenCodeHydrationQueue = () => {
    while (
      openCodeHydrationsActive < OPEN_CODE_HYDRATION_CONCURRENCY &&
      openCodeHydrationQueue.size > 0
    ) {
      const nextEntry = [...openCodeHydrationQueue.values()].toSorted(
        (left, right) => left.priority - right.priority || left.enqueuedAt - right.enqueuedAt,
      )[0];
      if (!nextEntry) {
        return;
      }
      openCodeHydrationQueue.delete(nextEntry.threadId);
      openCodeHydrationsActive++;
      void refreshOpenCodeThreadMirror(nextEntry.threadId, {
        force: nextEntry.force,
        reason: nextEntry.reason,
      })
        .catch((error) => {
          logger.warn("OpenCode mirror refresh failed", {
            threadId: nextEntry.threadId,
            reason: nextEntry.reason,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          openCodeHydrationsActive--;
          pumpOpenCodeHydrationQueue();
        });
    }
  };

  const enqueueOpenCodeThreadHydration = (
    threadId: string,
    options: { readonly priority: number; readonly force?: boolean; readonly reason: string },
  ): boolean => {
    if (openCodeHydrationInFlight.has(threadId)) {
      return false;
    }
    const current = openCodeHydrationQueue.get(threadId);
    const nextEntry: OpenCodeHydrationQueueEntry = {
      threadId,
      priority: current ? Math.min(current.priority, options.priority) : options.priority,
      force: current?.force === true || options.force === true,
      enqueuedAt: current?.enqueuedAt ?? Date.now(),
      reason: current?.force === true ? current.reason : options.reason,
    };
    openCodeHydrationQueue.set(threadId, nextEntry);
    pumpOpenCodeHydrationQueue();
    return current === undefined;
  };

  /**
   * Sync OpenCode sessions across ALL projects into T3Code threads.
   *
   * Fetches every project from the OpenCode server, creates a T3 project for
   * each worktree that doesn't have one, then discovers sessions per project
   * and dispatches `thread.create` commands for new ones.
   *
   * Safe to call repeatedly — already-synced sessions are skipped.
   */
  const syncOpenCodeSessions = async (): Promise<{
    created: number;
    skipped: number;
    projectsCreated: number;
    errors: string[];
  }> => {
    await openCodeServerControl.start();

    const {
      url: ocUrl,
      username: ocUser,
      password: ocPass,
    } = openCodeServerControl.getCredentials();
    const client = new OpenCodeClient(ocUrl, ocUser, ocPass);
    const discovery = new OpenCodeSessionDiscovery(client);
    const sync = new OpenCodeSessionSync(discovery, client);

    // GET /project returns all projects globally regardless of the directory
    // header — a single query is sufficient.
    let rawOcProjects: Awaited<ReturnType<typeof client.listProjects>> = [];
    const allErrors: string[] = [];
    try {
      rawOcProjects = await client.listProjects(cwd);
    } catch (error) {
      allErrors.push(
        `project discovery: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const ocProjects = mergeOpenCodeProjectsByWorktree([rawOcProjects]);

    const snapshot = await Effect.runPromise(projectionReadModelQuery.getSnapshot());

    // --- Cleanup: soft-delete T3 projects whose workspaceRoot is a temp path.
    // These are leftover sandbox worktrees created by OpenCode agents (e.g.
    // /private/tmp/chico-boot-xxx/repo). They should never appear as real
    // projects in the sidebar.
    for (const t3Project of snapshot.projects) {
      if (t3Project.deletedAt !== null) continue;
      if (!isTemporaryWorktree(t3Project.workspaceRoot)) continue;
      try {
        await Effect.runPromise(
          orchestrationEngine.dispatch({
            type: "project.delete",
            commandId: CommandId.makeUnsafe(crypto.randomUUID()),
            projectId: ProjectId.makeUnsafe(t3Project.id),
          }),
        );
      } catch (err) {
        allErrors.push(
          `cleanup temp project ${t3Project.workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const existingCatalogEntries = await Effect.runPromise(
      providerThreadCatalogRepository.listByProviderKind({ providerKind: "opencode" }),
    );
    const catalogByThreadId = new Map(
      existingCatalogEntries
        .filter((entry) => entry.threadId !== null)
        .map((entry) => [entry.threadId!, entry] as const),
    );

    // Build a global dedup map: externalSessionId → existing thread.
    // Exclude threads whose project has been soft-deleted so that sessions
    // previously imported into a now-deleted project (e.g. a temp sandbox
    // that was cleaned up) are re-synced into their correct project.
    const deletedProjectIds = new Set(
      snapshot.projects.filter((p) => p.deletedAt !== null).map((p) => p.id),
    );
    const existingExternalIds = new Map<string, { threadId: string; externalUpdatedAt: string }>();
    for (const thread of snapshot.threads) {
      if (
        thread.provider === "opencode" &&
        thread.externalSessionId &&
        thread.deletedAt === null &&
        !deletedProjectIds.has(thread.projectId)
      ) {
        const catalogEntry = catalogByThreadId.get(thread.id);
        existingExternalIds.set(thread.externalSessionId, {
          threadId: thread.id,
          externalUpdatedAt: catalogEntry?.externalUpdatedAt ?? thread.updatedAt,
        });
      }
    }

    let totalCreated = 0;
    let totalSkipped = 0;
    let projectsCreated = 0;

    /**
     * Find-or-create a T3 project for `worktree`, then sync its OpenCode
     * sessions. Mutates `existingExternalIds`, `totalCreated`, `totalSkipped`,
     * `projectsCreated`, and `allErrors` in the enclosing scope.
     */
    const syncWorktreeProject = async (worktree: string): Promise<void> => {
      // Re-read snapshot each time so newly created projects are visible.
      const currentSnapshot = await Effect.runPromise(projectionReadModelQuery.getSnapshot());
      let t3Project = currentSnapshot.projects.find(
        (p) => p.workspaceRoot === worktree && p.deletedAt === null,
      );
      if (!t3Project) {
        const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const createdAt = new Date().toISOString();
        const title = path.basename(worktree) || "project";
        try {
          await Effect.runPromise(
            orchestrationEngine.dispatch({
              type: "project.create",
              commandId: CommandId.makeUnsafe(crypto.randomUUID()),
              projectId,
              title,
              workspaceRoot: worktree,
              defaultModel: "claude-sonnet-4-20250514",
              createdAt,
            }),
          );
          const afterCreate = await Effect.runPromise(projectionReadModelQuery.getSnapshot());
          t3Project = afterCreate.projects.find(
            (p) => p.workspaceRoot === worktree && p.deletedAt === null,
          );
          projectsCreated++;
        } catch (err) {
          allErrors.push(
            `project ${worktree}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }

      if (!t3Project) return;

      const output = await sync.syncSessionsForDirectory(
        worktree,
        t3Project.id,
        existingExternalIds,
      );

      const createdThreadIds = new Set(output.commands.map((command) => command.threadId));

      for (const cmd of output.commands) {
        try {
          await Effect.runPromise(
            orchestrationEngine.dispatch({
              ...cmd,
              commandId: CommandId.makeUnsafe(crypto.randomUUID()),
              threadId: ThreadId.makeUnsafe(cmd.threadId),
              projectId: ProjectId.makeUnsafe(cmd.projectId),
            }),
          );
          const matchingCatalogUpsert = output.catalogUpserts.find(
            (upsert) => upsert.threadId === cmd.threadId,
          );
          if (matchingCatalogUpsert) {
            await persistOpenCodeCatalogUpsert(matchingCatalogUpsert);
          }
          existingExternalIds.set(cmd.externalSessionId, {
            threadId: cmd.threadId,
            externalUpdatedAt: matchingCatalogUpsert?.externalUpdatedAt.length
              ? matchingCatalogUpsert.externalUpdatedAt
              : cmd.createdAt,
          });
          totalCreated++;
        } catch (err) {
          allErrors.push(
            `session ${cmd.externalSessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      for (const upsert of output.catalogUpserts) {
        if (createdThreadIds.has(upsert.threadId)) {
          continue;
        }
        try {
          await persistOpenCodeCatalogUpsert(upsert);
          existingExternalIds.set(upsert.externalSessionId, {
            threadId: upsert.threadId,
            externalUpdatedAt:
              upsert.externalUpdatedAt.length > 0
                ? upsert.externalUpdatedAt
                : new Date().toISOString(),
          });
        } catch (err) {
          allErrors.push(
            `catalog ${upsert.externalSessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      output.catalogUpserts
        .toSorted(
          (left, right) =>
            (Date.parse(right.externalUpdatedAt || "") || 0) -
              (Date.parse(left.externalUpdatedAt || "") || 0) ||
            right.threadId.localeCompare(left.threadId),
        )
        .slice(0, OPEN_CODE_BACKGROUND_HYDRATION_LIMIT)
        .forEach((upsert) => {
          enqueueOpenCodeThreadHydration(upsert.threadId, {
            priority: OPEN_CODE_HYDRATION_PRIORITY_BACKGROUND,
            reason: "background-sync",
          });
        });

      totalSkipped += output.result.unchanged + output.result.updated;
      for (const e of output.result.errors) {
        allErrors.push(`${worktree} / ${e.sessionId}: ${e.error}`);
      }
    };

    // --- Phase 1: sync registered OpenCode projects.
    for (const ocProject of ocProjects) {
      const worktree = ocProject.worktree;
      if (!worktree || worktree === "/") continue; // Skip invalid/root entries
      // Skip temp directories (e.g. /private/tmp/chico-boot-xxx/repo).
      if (isTemporaryWorktree(worktree)) continue;
      await syncWorktreeProject(worktree);
    }

    // --- Phase 2: discover "orphaned" projects stored under the global OpenCode
    // project (worktree "/"). Older OpenCode versions stored all sessions there
    // instead of registering per-worktree project entries. We query the global
    // project's sessions, extract unique directory values, and treat any that
    // aren't already covered by a registered project as additional projects to
    // sync.
    const registeredWorktrees = new Set(ocProjects.map((p) => p.worktree));
    let orphanedDirectories: string[] = [];
    try {
      orphanedDirectories = await discovery.discoverOrphanedDirectories();
    } catch (err) {
      allErrors.push(`orphan discovery: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const dir of orphanedDirectories) {
      if (registeredWorktrees.has(dir)) continue; // already handled in Phase 1
      if (isTemporaryWorktree(dir)) continue;
      await syncWorktreeProject(dir);
    }

    return {
      created: totalCreated,
      skipped: totalSkipped,
      projectsCreated,
      errors: allErrors,
    };
  };

  // ── OpenCode thread mirror refresh ─────────────────────────────────
  // Opening a discovered OpenCode thread never blocks on remote history.
  // We always render the local mirror first, then queue a background refresh.

  /**
   * Extract display text from an OpenCode message's parts.
   *
   * For user messages: concatenate text parts.
   * For assistant messages: concatenate text + reasoning parts, annotate
   * tool calls inline so the user can see what happened.
   */
  function extractTextFromParts(parts: ReadonlyArray<OpenCodePart>, role: string): string {
    const chunks: string[] = [];
    for (const part of parts) {
      if (part.type === "text" && "text" in part && typeof part.text === "string") {
        chunks.push(part.text);
      } else if (part.type === "reasoning" && "text" in part && typeof part.text === "string") {
        // Include reasoning/thinking as a block
        chunks.push(part.text);
      } else if (part.type === "tool" && role === "assistant") {
        const toolPart = part as OpenCodePart & {
          type: "tool";
          tool?: string;
          state?: {
            status?: string;
            title?: string;
            input?: Record<string, unknown>;
            output?: string;
          };
        };
        const toolName = toolPart.tool ?? "unknown";
        const state = toolPart.state;
        if (state?.status === "completed") {
          const title = state.title ?? toolName;
          chunks.push(`\n\n---\n**Tool: ${title}**\n`);
          if (state.output && state.output.length > 0) {
            // Truncate very long tool outputs for readability
            const maxLen = 2000;
            const output =
              state.output.length > maxLen
                ? `${state.output.slice(0, maxLen)}\n… (truncated)`
                : state.output;
            chunks.push(`\`\`\`\n${output}\n\`\`\``);
          }
        } else if (state?.status === "error") {
          const errorStr =
            "error" in state && typeof state.error === "string" ? state.error : "unknown error";
          chunks.push(`\n\n---\n**Tool: ${toolName}** (error: ${errorStr})\n`);
        }
        // Skip pending/running tool parts — they're intermediate states
      }
      // Ignore step-start, step-finish, snapshot, patch, etc.
    }
    return chunks.join("").trim();
  }

  const loadOpenCodeThreadMessages = async (
    threadIdStr: string,
  ): Promise<{ queued: boolean; threadId: string }> => ({
    queued: enqueueOpenCodeThreadHydration(threadIdStr, {
      priority: OPEN_CODE_HYDRATION_PRIORITY_OPEN,
      reason: "thread-opened",
    }),
    threadId: threadIdStr,
  });

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    pushBus.publishAll(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.streamChanges, (event) =>
    providerHealth.getStatuses.pipe(
      Effect.flatMap((providerStatuses) =>
        pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: event.issues,
          providers: providerStatuses,
        }),
      ),
    ),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
  yield* readiness.markOrchestrationSubscriptionsReady;

  // Subscribe to remote host connection status and push to all WS clients
  yield* Stream.runForEach(remoteHostService.subscribeToStatus(), (status) =>
    pushBus.publishAll(WS_CHANNELS.serverRemoteConnectionStatus, status),
  ).pipe(Effect.forkIn(subscriptionsScope));

  // Push live OS metrics to all connected clients every 5 seconds.
  // cpuPercent is approximated from the 1-minute load average divided by CPU
  // count, so it can briefly exceed 100 under heavy load — we clamp it.
  // On Windows os.loadavg() always returns [0,0,0], so cpuPercent is 0 there.
  yield* Effect.gen(function* () {
    const cpuList = os.cpus();
    const loadAvg1 = os.loadavg()[0] ?? 0;
    const cpuPercent =
      cpuList.length > 0 ? Math.min(100, Math.round((loadAvg1 / cpuList.length) * 100)) : 0;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPercent = totalMem > 0 ? Math.round((1 - freeMem / totalMem) * 100) : 0;
    yield* pushBus.publishAll(WS_CHANNELS.serverMetrics, { cpuPercent, memPercent, loadAvg1 });
  }).pipe(Effect.repeat(Schedule.fixed(Duration.seconds(5))), Effect.forkIn(subscriptionsScope));

  // Restore remote host config from persistent state and reconnect if enabled
  yield* Effect.gen(function* () {
    const savedEntry = yield* uiStateRepository.getByKey({ key: "remoteHostConfig" });
    if (savedEntry._tag === "Some") {
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(RemoteHostConfig))(
        savedEntry.value.valueJson,
      );
      if (decoded._tag === "Some" && decoded.value.enabled) {
        yield* remoteHostService.applyConfig(decoded.value).pipe(Effect.forkIn(subscriptionsScope));
      }
    }
  }).pipe(Effect.orElseSucceed(() => undefined));

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  // Ensure OpenCode is available as soon as T3 Code boots, then sync any
  // existing OpenCode sessions into the projection. Fire-and-forget so OpenCode
  // failures do not block the main server from accepting connections.
  void openCodeServerControl
    .start()
    .then(() =>
      syncOpenCodeSessions().then((result) => {
        if (result.created > 0 || result.skipped > 0) {
          logger.info("Auto-synced OpenCode sessions on startup", {
            created: result.created,
            skipped: result.skipped,
          });
        }
      }),
    )
    .catch((err) => {
      logger.warn("OpenCode startup failed during server boot", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const stopManagedOpenCodeServer = Effect.tryPromise({
    try: () => (openCodeServerControl.canStop ? openCodeServerControl.stop() : Promise.resolve()),
    catch: (cause) => new ServerLifecycleError({ operation: "stopManagedOpenCodeServer", cause }),
  }).pipe(Effect.ignoreCause({ log: true }));

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.terminalEvent, event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));
  yield* readiness.markTerminalSubscriptionsReady;

  // Wire dev server manager events → push bus
  const onDevServerStatusChanged = (info: import("@t3tools/contracts").DevServerInfo) =>
    void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.devServerStatusChanged, info));
  const onDevServerLogLine = (payload: import("@t3tools/contracts").DevServerLogLinePayload) =>
    void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.devServerLogLine, payload));
  devServerManager.on("statusChanged", onDevServerStatusChanged);
  devServerManager.on("logLine", onDevServerLogLine);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      devServerManager.off("statusChanged", onDevServerStatusChanged);
      devServerManager.off("logLine", onDevServerLogLine);
    }),
  );

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );
  yield* readiness.markHttpListening;

  yield* Effect.addFinalizer(() =>
    Effect.all([
      closeAllClients,
      closeWebSocketServer.pipe(Effect.ignoreCause({ log: true })),
      stopManagedOpenCodeServer,
    ]),
  );

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSummarySnapshot();

      case ORCHESTRATION_WS_METHODS.getThreadMessages:
        return yield* projectionReadModelQuery.getThreadMessages(stripRequestTag(request.body));

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        return yield* orchestrationEngine.dispatch(normalizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem
          .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to prepare workspace path: ${String(cause)}`,
                }),
            ),
          );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitResolvePullRequest: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.resolvePullRequest(body);
      }

      case WS_METHODS.gitPreparePullRequestThread: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.preparePullRequestThread(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        const providerStatuses = yield* providerHealth.getStatuses;
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors,
        };

      case WS_METHODS.serverGetUiState: {
        const body = stripRequestTag(request.body);
        const rowOption = yield* uiStateRepository.getByKey(body);
        return {
          valueJson: rowOption._tag === "Some" ? rowOption.value.valueJson : null,
        };
      }

      case WS_METHODS.devServerStart: {
        const body = stripRequestTag(request.body);
        const info = yield* Effect.tryPromise({
          try: () => devServerManager.start(body.projectId, body.cwd),
          catch: (cause) => new RouteRequestError({ message: String(cause) }),
        });
        return info;
      }

      case WS_METHODS.devServerStop: {
        const body = stripRequestTag(request.body);
        devServerManager.stop(body.projectId);
        return;
      }

      case WS_METHODS.devServerGetStatus: {
        const body = stripRequestTag(request.body);
        return devServerManager.getStatus(body.projectId);
      }

      case WS_METHODS.devServerGetStatuses: {
        return devServerManager.getAllStatuses();
      }

      case WS_METHODS.devServerGetLogs: {
        const body = stripRequestTag(request.body);
        return devServerManager.getLogs(body.projectId, body.limit);
      }

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      case WS_METHODS.serverUpsertUiState: {
        const body = stripRequestTag(request.body);
        yield* uiStateRepository.upsert({
          key: body.key,
          valueJson: body.valueJson,
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      case WS_METHODS.serverSetRemoteHostConfig: {
        const body = stripRequestTag(request.body);
        // Persist config to server-side UI state (not localStorage — may contain key paths)
        const valueJson =
          body.config !== null
            ? Schema.encodeSync(Schema.fromJsonString(RemoteHostConfig))(body.config)
            : "null";
        yield* uiStateRepository.upsert({
          key: "remoteHostConfig",
          valueJson,
          updatedAt: new Date().toISOString(),
        });
        yield* remoteHostService.applyConfig(body.config).pipe(Effect.forkIn(subscriptionsScope));
        return;
      }

      case WS_METHODS.serverTestRemoteConnection: {
        const body = stripRequestTag(request.body);
        return yield* testConnection(body.config, null);
      }

      case WS_METHODS.syncGetThreadManifest: {
        const threads = yield* syncService.getThreadManifest();
        return { threads };
      }

      case WS_METHODS.syncExportThreadEvents: {
        const body = stripRequestTag(request.body);
        const events = yield* syncService.exportThreadEvents(body.threadId);
        return { events };
      }

      case WS_METHODS.syncReceiveEvents: {
        const body = stripRequestTag(request.body);
        return yield* syncService.receiveEvents(Array.from(body.events));
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const sendWsResponse = (response: WsResponseMessage) =>
      encodeWsResponse(response).pipe(
        Effect.tap((encodedResponse) => Effect.sync(() => ws.send(encodedResponse))),
        Effect.asVoid,
      );

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
    }

    const request = decodeWebSocketRequest(messageText);
    if (Result.isFailure(request)) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${formatSchemaError(request.failure)}` },
      });
    }

    const result = yield* Effect.exit(routeRequest(request.success));
    if (Exit.isFailure(result)) {
      return yield* sendWsResponse({
        id: request.success.id,
        error: { message: Cause.pretty(result.cause) },
      });
    }

    return yield* sendWsResponse({
      id: request.success.id,
      result: result.value,
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcomeData = {
      cwd,
      projectName,
      ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
      ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
    };
    // Send welcome before adding to broadcast set so publishAll calls
    // cannot reach this client before the welcome arrives.
    void runPromise(
      readiness.awaitServerReady.pipe(
        Effect.flatMap(() => pushBus.publishClient(ws, WS_CHANNELS.serverWelcome, welcomeData)),
        Effect.flatMap((delivered) =>
          delivered ? Ref.update(clients, (clients) => clients.add(ws)) : Effect.void,
        ),
      ),
    );

    ws.on("message", (raw) => {
      void runPromise(handleMessage(ws, raw).pipe(Effect.ignoreCause({ log: true })));
    });

    ws.on("close", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
