export interface AbsurdOptions { dbName: string }

export function absurd(options: AbsurdOptions) {
  // Minimal facade matching ClientStorage; uses in-memory map in Node tests.
  const mem = new Map<string, any>();
  const keyOf = (store: string, key: string) => `${options.dbName}:${store}:${key}`;
  return {
    kind: "absurd" as const,
    options,
    async put(store: string, key: string, value: any) { mem.set(keyOf(store, key), value); },
    async get<T>(store: string, key: string): Promise<T | undefined> { return mem.get(keyOf(store, key)); },
    async del(store: string, key: string) { mem.delete(keyOf(store, key)); },
    async list<T>(store: string, opts?: { prefix?: string; limit?: number }) {
      const out: Array<{ key: string; value: T }> = [];
      const prefix = `${options.dbName}:${store}:${opts?.prefix ?? ""}`;
      for (const [k, v] of mem) {
        if (k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), value: v });
        if (opts?.limit && out.length >= opts.limit) break;
      }
      return out;
    },
    async clear(store: string) {
      const prefix = `${options.dbName}:${store}:`;
      for (const k of Array.from(mem.keys())) if (k.startsWith(prefix)) mem.delete(k);
    },
  };
}