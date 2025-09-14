import type { IdempotencyStore } from './types';

export function createMemoryIdempotencyStore<V = unknown>(opts?: { ttlMs?: number }): IdempotencyStore<V> {
  const ttlMs = opts?.ttlMs ?? 10 * 60 * 1000;
  const map = new Map<string, { value: V; expiresAt: number }>();
  function sweep(now: number) {
    for (const [k, v] of map) { if (v.expiresAt <= now) map.delete(k); }
  }
  return {
    has(key: string) {
      const now = Date.now(); sweep(now);
      const v = map.get(key); if (!v) return false;
      if (v.expiresAt <= now) { map.delete(key); return false; }
      return true;
    },
    get(key: string) {
      const now = Date.now(); sweep(now);
      const v = map.get(key); if (!v) return undefined;
      if (v.expiresAt <= now) { map.delete(key); return undefined; }
      return v.value;
    },
    set(key: string, value: V) {
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
  };
}
