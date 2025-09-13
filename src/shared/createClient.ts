export function createClient<_TApp = unknown>(config: { baseURL: string }) {
  return {
    config,
  } as const;
}
