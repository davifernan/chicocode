/**
 * OpenCodeAuthManager - auth.json management for OpenCode provider credentials.
 *
 * Reads and validates the OpenCode `auth.json` file which stores per-provider
 * authentication entries. Follows the same resolution logic as Chico's
 * `resolve_auth_json_path`: env override -> `~/.local/share/opencode/auth.json`.
 *
 * The auth.json schema uses a discriminated union on the `type` field:
 * - `"oauth"`     — OAuth flow credentials (refresh, access, expires)
 * - `"api"`       — Plain API key
 * - `"wellknown"` — Well-known auth (key + token)
 *
 * @module OpenCodeAuthManager
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types — matches OpenCode's auth schema exactly
// ---------------------------------------------------------------------------

/** OAuth-based authentication entry. */
export interface OpenCodeAuthOauth {
  readonly type: "oauth";
  readonly refresh: string;
  readonly access: string;
  readonly expires: number;
  readonly accountId?: string | undefined;
  readonly enterpriseUrl?: string | undefined;
}

/** API-key-based authentication entry. */
export interface OpenCodeAuthApi {
  readonly type: "api";
  readonly key: string;
}

/** Well-known authentication entry. */
export interface OpenCodeAuthWellKnown {
  readonly type: "wellknown";
  readonly key: string;
  readonly token: string;
}

/** Discriminated union of all auth entry types. */
export type OpenCodeAuthEntry = OpenCodeAuthOauth | OpenCodeAuthApi | OpenCodeAuthWellKnown;

/** Authentication status. */
export type OpenCodeAuthStatus = "authenticated" | "unauthenticated" | "unknown";

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class OpenCodeAuthManager {
  /**
   * Resolve the path to OpenCode's `auth.json`.
   *
   * Resolution order:
   * 1. `OPENCODE_AUTH_JSON_PATH` environment variable (explicit override).
   * 2. `~/.local/share/opencode/auth.json` (XDG data home default).
   */
  resolveAuthJsonPath(): string {
    const envPath = process.env.OPENCODE_AUTH_JSON_PATH?.trim();
    if (envPath) return envPath;

    return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  }

  /**
   * Read and parse `auth.json`, returning only valid entries.
   *
   * Invalid entries (wrong type discriminant, missing fields) are silently
   * dropped — mirrors OpenCode's own `Auth.all()` behavior.
   */
  async readAuthJson(): Promise<Record<string, OpenCodeAuthEntry>> {
    const filePath = this.resolveAuthJsonPath();
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return {};
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    const result: Record<string, OpenCodeAuthEntry> = {};

    for (const [key, value] of Object.entries(parsed)) {
      if (!isValidAuthEntry(value)) continue;
      result[key] = value;
    }

    return result;
  }

  /**
   * Check whether at least one valid auth entry exists.
   */
  async hasValidAuth(): Promise<boolean> {
    const entries = await this.readAuthJson();
    return Object.keys(entries).length > 0;
  }

  /**
   * Determine the overall authentication status.
   *
   * - `"authenticated"` — at least one valid entry exists.
   * - `"unauthenticated"` — file exists (or is missing) but no valid entries.
   * - `"unknown"` — unexpected error reading/parsing the file.
   */
  async getAuthStatus(): Promise<OpenCodeAuthStatus> {
    try {
      const hasAuth = await this.hasValidAuth();
      return hasAuth ? "authenticated" : "unauthenticated";
    } catch {
      return "unknown";
    }
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidAuthEntry(value: unknown): value is OpenCodeAuthEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;

  switch (obj.type) {
    case "oauth":
      return (
        typeof obj.refresh === "string" &&
        typeof obj.access === "string" &&
        typeof obj.expires === "number"
      );
    case "api":
      return typeof obj.key === "string";
    case "wellknown":
      return typeof obj.key === "string" && typeof obj.token === "string";
    default:
      return false;
  }
}
