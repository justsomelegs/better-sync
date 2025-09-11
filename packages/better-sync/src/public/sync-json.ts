/** Minimal sync.json metadata helper (dev tooling). */
export interface SyncJsonMeta {
  protocolVersion: number;
  features: string[];
  basePath: string;
  methods: string[];
  wire?: { encoding: "json" | "msgpack"; compression?: ("gzip" | "brotli")[] };
}

export function getSyncJsonMeta(basePath: string = "/api/sync"): SyncJsonMeta {
  return {
    protocolVersion: 1,
    features: ["ws", "http-fallback", "shapes", "since-cursor", "idempotency"],
    basePath,
    methods: ["apply", "registerShape", "pull"],
    wire: { encoding: "json", compression: ["gzip"] },
  };
}
