import type { SyncError, SyncErrorCode } from "./types.js";

/**
 * Create a SyncError object with stable SYNC:* code and optional metadata.
 * @example
 * const err = syncError("SYNC:UNAUTHORIZED", "Missing token", { path: "/api/sync" });
 * // Map to HTTP 401 and include helpUrl for humans
 */
export const ERROR_DOCS_BASE = "https://docs.better-sync.dev/errors#" as const;
/**
 * Build a help documentation URL for the given SyncErrorCode.
 *
 * The function appends the provided `code` to the module's ERROR_DOCS_BASE to form a stable
 * documentation link (e.g. `https://docs.better-sync.dev/errors#<code>`). The `code` is used
 * verbatim when constructing the fragment.
 *
 * @param code - The SyncErrorCode to generate a help URL for
 * @returns A full URL string pointing to the error documentation for `code`
 */
export function helpUrlFor(code: SyncErrorCode): string {
  // ensure colon encoded in fragment for readability; keep raw code
  return `${ERROR_DOCS_BASE}${code}`;
}
/**
 * Create a SyncError object with a code, message, optional metadata, and a help URL.
 *
 * If `helpUrl` is not provided, it is set to the value returned by `helpUrlFor(code)`.
 *
 * @param code - Machine-readable error code
 * @param message - Human-readable error message
 * @param meta - Optional additional context to attach to the error
 * @param helpUrl - Optional override for the documentation URL; defaults to `helpUrlFor(code)`
 * @returns The constructed `SyncError` containing `code`, `message`, `helpUrl`, and `meta`
 */
export function syncError(code: SyncErrorCode, message: string, meta?: Record<string, unknown>, helpUrl?: string): SyncError {
  return { code, message, helpUrl: helpUrl ?? helpUrlFor(code), meta };
}
