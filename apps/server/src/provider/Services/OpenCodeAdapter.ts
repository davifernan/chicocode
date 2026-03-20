/**
 * OpenCodeAdapter - OpenCode implementation of the generic provider adapter contract.
 *
 * This service owns OpenCode server HTTP/SSE semantics and emits OpenCode
 * provider events. It does not perform cross-provider routing, shared event
 * fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "opencode"` context.
 *
 * @module OpenCodeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenCodeAdapterShape - Service API for the OpenCode provider adapter.
 */
export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

/**
 * OpenCodeAdapter - Service tag for OpenCode provider adapter operations.
 */
export class OpenCodeAdapter extends ServiceMap.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Services/OpenCodeAdapter",
) {}
