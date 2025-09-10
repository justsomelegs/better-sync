export function ws(options: { url: string; heartbeatMs?: number }) {
  return { type: "ws", options } as const;
}
