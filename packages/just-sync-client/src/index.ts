import { ulid } from 'ulid';

export type ClientOptions<TApp = any> = {
  baseURL: string;
  realtime?: 'sse' | 'poll' | 'off';
  pollIntervalMs?: number;
  datastore?: unknown;
};

export function createClient<TApp = any>(opts: ClientOptions<TApp>) {
  const config = {
    baseURL: opts.baseURL,
    realtime: opts.realtime ?? 'sse',
    pollIntervalMs: opts.pollIntervalMs ?? 1500
  } as const;
  return {
    config,
    _op(): string {
      return ulid();
    }
  } as const;
}
