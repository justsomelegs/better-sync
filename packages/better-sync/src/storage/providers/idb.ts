/** Minimal IndexedDB storage facade for client-side queue/state persistence (skeleton). */
export interface IdbOptions { dbName: string }
export interface IdbHandle {
  kind: "idb";
  options: IdbOptions;
  put<T>(store: string, key: string, value: T): Promise<void>;
  get<T>(store: string, key: string): Promise<T | undefined>;
  del(store: string, key: string): Promise<void>;
  list<T>(store: string, opts?: { prefix?: string; limit?: number }): Promise<Array<{ key: string; value: T }>>;
  clear(store: string): Promise<void>;
}

export function idb(options: IdbOptions): IdbHandle {
  // In tests/Node we fallback to an in-memory map; in browsers use IndexedDB
  const mem = new Map<string, any>();
  const keyOf = (store: string, key: string) => `${options.dbName}:${store}:${key}`;
  return {
    kind: "idb",
    options,
    async put(store, key, value) { mem.set(keyOf(store, key), value); },
    async get(store, key) { return mem.get(keyOf(store, key)); },
    async del(store, key) { mem.delete(keyOf(store, key)); },
    async list(store, opts) {
      const out: Array<{ key: string; value: any }> = [];
      const prefix = `${options.dbName}:${store}:${opts?.prefix ?? ""}`;
      for (const [k, v] of mem) {
        if (k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), value: v });
        if (opts?.limit && out.length >= opts.limit) break;
      }
      return out;
    },
    async clear(store) {
      const prefix = `${options.dbName}:${store}:
`;
      for (const k of Array.from(mem.keys())) if (k.startsWith(prefix)) mem.delete(k);
    },
  } as const;
}
