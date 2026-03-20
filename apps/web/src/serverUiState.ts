import type { ServerUiStateKey } from "@t3tools/contracts";

import { readNativeApi } from "./nativeApi";

const PERSIST_DELAY_MS = 250;

const pendingValues = new Map<ServerUiStateKey, string>();
const pendingTimers = new Map<ServerUiStateKey, ReturnType<typeof setTimeout>>();

function flushPersist(key: ServerUiStateKey): void {
  const valueJson = pendingValues.get(key);
  if (valueJson === undefined) {
    return;
  }

  pendingValues.delete(key);
  pendingTimers.delete(key);

  const api = readNativeApi();
  if (!api) {
    return;
  }

  void api.server.upsertUiState({ key, valueJson }).catch(() => {
    pendingValues.set(key, valueJson);
    const retryTimer = setTimeout(() => flushPersist(key), PERSIST_DELAY_MS);
    pendingTimers.set(key, retryTimer);
  });
}

export function persistServerUiState(key: ServerUiStateKey, valueJson: string): void {
  pendingValues.set(key, valueJson);

  const existingTimer = pendingTimers.get(key);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => flushPersist(key), PERSIST_DELAY_MS);
  pendingTimers.set(key, timer);
}

interface HydrateServerUiStateOptions {
  readonly key: ServerUiStateKey;
  readonly readLegacyValue: () => string | null;
  readonly onHydrate: (valueJson: string | null) => void;
}

export async function hydrateServerUiState(options: HydrateServerUiStateOptions): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    options.onHydrate(options.readLegacyValue());
    return;
  }

  let valueJson: string | null = null;
  try {
    valueJson = (await api.server.getUiState({ key: options.key })).valueJson;
  } catch {
    valueJson = null;
  }

  if (valueJson === null) {
    const legacyValue = options.readLegacyValue();
    if (legacyValue !== null) {
      valueJson = legacyValue;
      persistServerUiState(options.key, legacyValue);
    }
  }

  options.onHydrate(valueJson);
}
