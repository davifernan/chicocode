/**
 * RemoteHostServiceLive - Live Effect Layer for RemoteHostService.
 *
 * Provides SshTunnelManager as an inline implementation (no separate Layer
 * needed because SshTunnelManager is stateful and must be scoped per session).
 *
 * @module RemoteHostServiceLive
 */
import { Layer } from "effect";

import { makeSshTunnelManager, SshTunnelManager } from "../Services/SshTunnelManager.ts";
import { makeRemoteHostService, RemoteHostService } from "../Services/RemoteHostService.ts";

const SshTunnelManagerLive = Layer.sync(SshTunnelManager, makeSshTunnelManager);

export const RemoteHostServiceLive = Layer.effect(RemoteHostService, makeRemoteHostService).pipe(
  Layer.provide(SshTunnelManagerLive),
);
