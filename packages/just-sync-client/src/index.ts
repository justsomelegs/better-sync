import { ulid } from 'ulid';

type PrimaryKey = string | number | Record<string, string | number>;

export type ClientOptions<TApp = any> = {
  baseURL: string,
  realtime?: 'sse' | 'poll' | 'off',
  pollIntervalMs?: number,
  datastore?: ClientDatastore,
};

type OrderBy = Record<string, 'asc' | 'desc'>;

type SelectWindowReq = { select?: string[]; orderBy?: OrderBy; limit?: number; cursor?: string | null; where?: unknown };

export interface ClientDatastore {
  apply(table: string, pk: PrimaryKey, diff: { set?: Record<string, unknown>; unset?: string[] }): Promise<void>;
  reconcile(table: string, pk: PrimaryKey, row: Record<string, unknown> & { version: number }): Promise<void>;
  readByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
  readWindow(table: string, req: SelectWindowReq): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }>;
}

class MemoryDatastore implements ClientDatastore {
  private tables = new Map<string, Map<string, any>>();
  private key(pk: PrimaryKey) {
    if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
    return Object.keys(pk).sort().map(k => `${k}=${String((pk as any)[k])}`).join('|');
  }
  private getTable(t: string) { if (!this.tables.has(t)) this.tables.set(t, new Map()); return this.tables.get(t)!; }
  async apply(table: string, pk: PrimaryKey, diff: { set?: Record<string, unknown>; unset?: string[] }) {
    const key = this.key(pk);
    const map = this.getTable(table);
    const prev = map.get(key) || {};
    const next = { ...prev, ...(diff.set || {}) };
    for (const k of diff.unset || []) delete (next as any)[k];
    map.set(key, next);
  }
  async reconcile(table: string, pk: PrimaryKey, row: Record<string, unknown> & { version: number }) {
    const key = this.key(pk);
    const map = this.getTable(table);
    const prev = map.get(key);
    if (!prev || typeof prev.version !== 'number' || (row.version as number) >= (prev.version as number)) {
      map.set(key, row);
    }
  }
  async readByPk(table: string, pk: PrimaryKey, select?: string[]) {
    const key = this.key(pk);
    const map = this.getTable(table);
    const full = map.get(key) || null;
    if (!full) return null;
    if (!select || select.length === 0) return full;
    const partial: Record<string, unknown> = {};
    for (const f of select) if (f in full) partial[f] = full[f];
    return partial;
  }
  async readWindow(table: string, req: SelectWindowReq) {
    const map = this.getTable(table);
    const all = Array.from(map.values());
    const sorted = [...all].sort((a, b) => {
      const av = a.updatedAt ?? 0; const bv = b.updatedAt ?? 0;
      if (av === bv) return String(a.id).localeCompare(String(b.id));
      return (req.orderBy?.updatedAt ?? 'desc') === 'desc' ? bv - av : av - bv;
    });
    const limit = Math.min(1000, Math.max(1, req.limit ?? 100));
    const slice = sorted.slice(0, limit);
    const data = slice.map((r) => {
      if (!req.select || req.select.length === 0) return r;
      const partial: Record<string, unknown> = {};
      for (const f of req.select) if (f in r) partial[f] = r[f];
      return partial;
    });
    return { data, nextCursor: null };
  }
}

type WatchHandle<T> = { unsubscribe(): void, status: 'connecting' | 'live' | 'retrying', error?: Error, getSnapshot(): T };

async function http<T>(baseURL: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, baseURL), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export function createClient<TApp = any>(opts: ClientOptions<TApp>) {
  const datastore = opts.datastore ?? new MemoryDatastore();
  const baseURL = opts.baseURL;
  const realtime = opts.realtime ?? 'sse';
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;

  function collection(table: string) {
    return {
      async select(arg: PrimaryKey | SelectWindowReq, extra?: { select?: string[] }) {
        if (typeof arg === 'string' || typeof arg === 'number' || (arg && typeof arg === 'object' && ('id' in (arg as any)))) {
          const resp = await http<{ data: any[]; nextCursor?: string | null }>(baseURL, '/select', { table, pk: arg, select: extra?.select });
          return resp;
        }
        const req = arg as SelectWindowReq;
        return await http<{ data: any[]; nextCursor?: string | null }>(baseURL, '/select', { table, ...req });
      },
      watch(arg: PrimaryKey | SelectWindowReq, cb: (payload: any) => void, opts?: { select?: string[] }): WatchHandle<any> {
        let status: WatchHandle<any>["status"] = 'connecting';
        let lastError: Error | undefined;
        let snapshot: any = null;
        let closed = false;
        const handle: WatchHandle<any> = {
          unsubscribe() { closed = true; es?.close(); clearInterval(poller as any); },
          getSnapshot() { return snapshot; },
          get status() { return status; },
        } as any;
        let es: EventSource | null = null;
        let poller: any = null;
        const start = async () => {
          // initial fetch
          try {
            const res = await (typeof arg === 'string' || typeof arg === 'number' || ('id' in (arg as any))
              ? http<{ data: any[] }>(baseURL, '/select', { table, pk: arg, select: opts?.select })
              : http<{ data: any[] }>(baseURL, '/select', { table, ...(arg as any) }));
            snapshot = Array.isArray(res.data) && (typeof arg !== 'string' && typeof arg !== 'number') ? res.data : (res.data?.[0] ?? null);
            cb(typeof arg === 'string' || typeof arg === 'number' ? { item: snapshot } : { data: snapshot });
            status = 'live';
          } catch (e: any) {
            lastError = e;
          }
          if (realtime === 'sse' && typeof EventSource !== 'undefined') {
            es = new EventSource(new URL('/events', baseURL));
            es.onmessage = async () => {
              // naive reselect upon any mutation for MVP
              const res = await (typeof arg === 'string' || typeof arg === 'number' || ('id' in (arg as any))
                ? http<{ data: any[] }>(baseURL, '/select', { table, pk: arg, select: opts?.select })
                : http<{ data: any[] }>(baseURL, '/select', { table, ...(arg as any) }));
              snapshot = Array.isArray(res.data) && (typeof arg !== 'string' && typeof arg !== 'number') ? res.data : (res.data?.[0] ?? null);
              cb(typeof arg === 'string' || typeof arg === 'number' ? { item: snapshot } : { data: snapshot });
            };
            es.onerror = () => { status = 'retrying'; };
          } else if (realtime === 'poll') {
            poller = setInterval(async () => {
              const res = await (typeof arg === 'string' || typeof arg === 'number' || ('id' in (arg as any))
                ? http<{ data: any[] }>(baseURL, '/select', { table, pk: arg, select: opts?.select })
                : http<{ data: any[] }>(baseURL, '/select', { table, ...(arg as any) }));
              snapshot = Array.isArray(res.data) && (typeof arg !== 'string' && typeof arg !== 'number') ? res.data : (res.data?.[0] ?? null);
              cb(typeof arg === 'string' || typeof arg === 'number' ? { item: snapshot } : { data: snapshot });
            }, pollIntervalMs);
          }
        };
        start();
        return handle;
      },
      async insert(row: Record<string, unknown>) {
        const res = await http<any>(baseURL, '/mutate', { op: 'insert', table, rows: row });
        return (res.row ?? res.rows?.[0]);
      },
      async update(pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }) {
        const res = await http<any>(baseURL, '/mutate', { op: 'update', table, pk, set, ifVersion: opts?.ifVersion });
        return res.row;
      },
      async delete(pk: PrimaryKey) {
        await http<any>(baseURL, '/mutate', { op: 'delete', table, pk });
        return { ok: true } as const;
      }
    };
  }

  return new Proxy({}, {
    get(_t, prop: string) { return collection(prop); }
  }) as any;
}
