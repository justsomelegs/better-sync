type CacheEntry<T> = { value: T; expiresAt: number };

export class IdempotencyCache<T> {
  private ttlMs: number;
  private map = new Map<string, CacheEntry<T>>();
  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }
  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: T) {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
