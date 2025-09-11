/** Minimal sync.json metadata helper (dev tooling). */
export interface SyncJsonMeta {
  protocolVersion: number;
  features: string[];
  basePath: string;
  methods: string[];
  wire?: { encoding: "json" | "msgpack"; compression?: ("gzip" | "brotli")[] };
}

/**
 * Create the default SyncJsonMeta used by dev tooling.
 *
 * Returns a SyncJsonMeta object describing the server sync metadata:
 * - protocolVersion: 1
 * - features: ["ws", "http-fallback", "shapes", "since-cursor", "idempotency"]
 * - methods: ["apply", "registerShape", "pull"]
 * - wire: { encoding: "json", compression: ["gzip"] }
 *
 * @param basePath - Base HTTP path for sync endpoints (defaults to "/api/sync")
 * @returns The constructed SyncJsonMeta literal
 */
export function getSyncJsonMeta(basePath: string = "/api/sync"): SyncJsonMeta {
  return {
    protocolVersion: 1,
    features: ["ws", "http-fallback", "shapes", "since-cursor", "idempotency"],
    basePath,
    methods: ["apply", "registerShape", "pull"],
    wire: { encoding: "json", compression: ["gzip"] },
  };
}
