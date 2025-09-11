/**
 * better-sync — framework-agnostic, DB-agnostic sync engine.
 * @example
 * import { createClient } from "better-sync";
 * const sync = createClient({ baseUrl: "http://localhost:3000" });
 */
export { createClient, createSyncClient } from "./public/client.js";
export { betterSync, createSyncServer } from "./public/server.js";
export * from "./public/types.js";
/**
 * Helper to define a typed schema mapping model names to row types.
 * Works with plain TS types, ORM-generated types, or schema libraries (e.g. Zod) via their inferred types.
 */
export function defineSchema<T extends Record<string, unknown>>(s: T): T { return s; }
export { syncError } from "./public/errors.js";
export * as storage from "./storage/index.js";
export * as transport from "./transport/index.js";
export * as auth from "./auth/index.js";
export { rateLimit } from "./plugins/rate-limit.js";
export { getSyncJsonMeta } from "./public/sync-json.js";
export * as serializers from "./public/serializers.js";
