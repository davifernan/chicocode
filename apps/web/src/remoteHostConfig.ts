/**
 * remoteHostConfig - Read / write RemoteHostConfig via the WS NativeApi.
 *
 * Config is stored server-side (NOT in localStorage) because it may contain
 * SSH key paths and auth tokens that should not be exposed to browser storage.
 *
 * @module remoteHostConfig
 */
import {
  RemoteHostConfig,
  type RemoteConnectionStatus,
  type TestRemoteConnectionResult,
} from "@t3tools/contracts";
import { Schema } from "effect";

import { readNativeApi } from "./nativeApi";

// ── Load ─────────────────────────────────────────────────────────────

export async function loadRemoteHostConfig(): Promise<RemoteHostConfig | null> {
  const api = readNativeApi();
  if (!api) return null;

  const { valueJson } = await api.server.getUiState({ key: "remoteHostConfig" });
  if (!valueJson || valueJson === "null") return null;

  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(RemoteHostConfig))(valueJson);
  return decoded._tag === "Some" ? decoded.value : null;
}

// ── Save ─────────────────────────────────────────────────────────────

export async function saveRemoteHostConfig(config: RemoteHostConfig | null): Promise<void> {
  const api = readNativeApi();
  if (!api) return;

  await api.remoteHost.setConfig(config);
}

// ── Test ─────────────────────────────────────────────────────────────

export async function testRemoteConnection(
  config: RemoteHostConfig,
): Promise<TestRemoteConnectionResult> {
  const api = readNativeApi();
  if (!api) {
    return { steps: [], success: false };
  }
  return api.remoteHost.testConnection(config);
}

// ── Status subscription ───────────────────────────────────────────────

export function onRemoteConnectionStatus(
  callback: (status: RemoteConnectionStatus) => void,
): () => void {
  const api = readNativeApi();
  if (!api) return () => {};
  return api.remoteHost.onConnectionStatus(callback);
}
