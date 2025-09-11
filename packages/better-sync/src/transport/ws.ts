/**
 * WebSocket transport factory.
 *
 * @example
 * import { ws } from "better-sync/transport";
 * const t = ws({ url: "ws://localhost:3000/api/sync", heartbeatMs: 30_000 });
 */
export function ws(options: { url: string; heartbeatMs?: number }) {
  return { type: "ws", options } as const;
}
