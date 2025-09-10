import type { SyncError, SyncErrorCode } from "./types.js";

/**
 * Create a SyncError object with stable SYNC:* code and optional metadata.
 * @example
 * const err = syncError("SYNC:UNAUTHORIZED", "Missing token", { path: "/api/sync" });
 */
export const ERROR_DOCS_BASE = "https://docs.better-sync.dev/errors#" as const;
export function helpUrlFor(code: SyncErrorCode): string {
  // ensure colon encoded in fragment for readability; keep raw code
  return `${ERROR_DOCS_BASE}${code}`;
}
export function syncError(code: SyncErrorCode, message: string, meta?: Record<string, unknown>, helpUrl?: string): SyncError {
  return { code, message, helpUrl: helpUrl ?? helpUrlFor(code), meta };
}
