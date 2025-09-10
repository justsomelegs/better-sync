export function rpc(options: { baseUrl: string }) {
  return { type: "rpc", options } as const;
}
