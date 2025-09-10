import type { SyncError, SyncErrorCode } from "./types.js";

/**
 * Create a SyncError object with stable SYNC:* code and optional metadata.
 * @example
 * const err = syncError("SYNC:UNAUTHORIZED", "Missing token", { path: "/api/sync" });
 */
export function syncError(code: SyncErrorCode, message: string, meta?: Record<string, unknown>, helpUrl?: string): SyncError {
  return { code, message, helpUrl, meta };
}
