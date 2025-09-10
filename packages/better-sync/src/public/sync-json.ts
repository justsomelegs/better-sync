/** Minimal sync.json metadata helper (dev tooling). */
export interface SyncJsonMeta {
  protocolVersion: number;
  features: string[];
  basePath: string;
  methods: string[];
}

export function getSyncJsonMeta(basePath: string = "/api/sync"): SyncJsonMeta {
  return {
    protocolVersion: 1,
    features: ["ws", "http-fallback"],
    basePath,
    methods: ["apply", "registerShape"],
  };
}
