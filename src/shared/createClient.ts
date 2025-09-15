type OrderBy = Record<string, 'asc' | 'desc'>;

type SelectArgs = {
  table: string;
  where?: unknown;
  select?: string[];
  orderBy?: OrderBy;
  limit?: number;
  cursor?: string | null;
};

type MutationResult = any;

import type { LocalStore } from '../storage/client';
import type { ClientMutatorsFromServer, ServerMutatorsSpec, AppSchema, RowOf, AppMutators, PrimaryKey } from './types';

export function createClient<TServerMutators extends ServerMutatorsSpec = AppMutators>(config: { baseURL: string; fetch?: typeof fetch; datastore?: LocalStore | Promise<LocalStore>; mutators?: TServerMutators }) {
  const baseURL = config.baseURL.replace(/\/$/, '');
  const fetchImpl = config.fetch ?? fetch;
  let storePromise: Promise<LocalStore> | null = null;
  if (config.datastore) storePromise = Promise.resolve(config.datastore);
  async function getStore(): Promise<LocalStore | null> { return storePromise ? storePromise : null; }

  // simple per-table cache and watchers
  const cache = new Map<string, Map<string, any>>();
  const watchers = new Map<string, Set<(evt: { table: string; pks?: any[]; rowVersions?: Record<string, number> }) => void>>();
  function getTable(table: string) {
    let t = cache.get(table);
    if (!t) { t = new Map(); cache.set(table, t); }
    return t;
  }
  function notify(table: string, evt: { table: string; pks?: any[]; rowVersions?: Record<string, number> }) {
    const set = watchers.get(table);
    if (set) for (const fn of set) { try { fn(evt); } catch { } }
  }

  async function postJson(path: string, body: unknown) {
    const res = await fetchImpl(`${baseURL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  async function selectAll(table: string, opts?: { select?: string[]; orderBy?: OrderBy; pageLimit?: number }) {
    const out: any[] = [];
    let cursor: string | null | undefined = undefined;
    const pageLimit = opts?.pageLimit ?? 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await postJson('/select', { table, select: opts?.select, orderBy: opts?.orderBy, limit: pageLimit, cursor });
      const json = await res.json();
      out.push(...(json.data || []));
      cursor = json.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  async function select(args: SelectArgs): Promise<{ data: any[]; nextCursor: string | null }> {
    // try local first if present and no filters
    const ds = await getStore();
    if (ds && !args.where) {
      const win = await ds.readWindow(args.table, { limit: args.limit, orderBy: args.orderBy, cursor: args.cursor ?? null });
      return { data: win.data, nextCursor: win.nextCursor };
    }
    const res = await postJson('/select', args);
    const json = await res.json();
    if (!args.cursor && !args.where) {
      const t = getTable(args.table);
      for (const row of json.data) t.set(String(row.id), row);
      if (ds) await ds.apply(json.data.map((r: any) => ({ table: args.table, type: 'insert', row: r })));
    }
    return json;
  }

  async function insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[], opts?: { clientOpId?: string }) {
    // optimistic single-row insert
    let tempId: string | null = null;
    if (!Array.isArray(rows)) {
      const provided = (rows as any)?.id;
      tempId = (typeof provided === 'string' || typeof provided === 'number') ? String(provided) : cryptoRandomId();
      const t = getTable(table);
      const key = String(tempId);
      t.set(key, { ...(rows as any), id: key, updatedAt: Date.now(), __optimistic: true });
      notify(table, { table, pks: [key] });
      const ds = await getStore();
      if (ds) await ds.apply([{ table, type: 'insert', row: { ...(rows as any), id: key } }]);
    }
    try {
      const clientOpId = opts?.clientOpId ?? cryptoRandomId();
      const res = await postJson('/mutate', { op: 'insert', table, rows, clientOpId });
      const json = await res.json();
      if (!Array.isArray(rows)) {
        const serverRow = (json as any).row ?? (Array.isArray((json as any).rows) ? (json as any).rows[0] : null);
        if (serverRow) {
          const t = getTable(table);
          if (tempId) t.delete(tempId);
          t.set(String(serverRow.id), serverRow);
          notify(table, { table, pks: [serverRow.id], rowVersions: serverRow.version ? { [serverRow.id]: serverRow.version } : undefined });
          const ds = await getStore();
          if (ds) await ds.apply([{ table, type: 'insert', row: serverRow }]);
        }
      }
      return json as MutationResult;
    } catch (e) {
      if (tempId) {
        const t = getTable(table);
        t.delete(tempId);
        notify(table, { table, pks: [tempId] });
        const ds = await getStore();
        if (ds) await ds.apply([{ table, type: 'delete', pk: tempId }]);
      }
      throw e;
    }
  }

  async function update(table: string, pk: string | number | Record<string, string | number>, set: Record<string, unknown>, opts?: { ifVersion?: number; clientOpId?: string }) {
    const key = typeof pk === 'object' ? JSON.stringify(pk) : String(pk);
    const t = getTable(table);
    const prev = t.get(key);
    if (prev) {
      t.set(key, { ...prev, ...set, __optimistic: true });
      notify(table, { table, pks: [key] });
    }
    try {
      const res = await postJson('/mutate', { op: 'update', table, pk, set, ifVersion: opts?.ifVersion, clientOpId: opts?.clientOpId });
      const json = await res.json();
      if (json?.row) {
        t.set(String(json.row.id ?? key), json.row);
        notify(table, { table, pks: [json.row.id ?? key], rowVersions: json.row.version ? { [json.row.id]: json.row.version } : undefined });
        const ds = await getStore();
        if (ds) await ds.apply([{ table, type: 'update', row: json.row }]);
      }
      return json as MutationResult;
    } catch (e) {
      if (prev) {
        t.set(key, prev);
        notify(table, { table, pks: [key] });
        const ds = await getStore();
        if (ds) await ds.apply([{ table, type: 'update', row: prev }]);
      }
      throw e;
    }
  }

  async function updateWhere(table: string, where: (row: any) => boolean, changes: { set: Record<string, unknown> }, opts?: { clientOpId?: string }) {
    const rows = await selectAll(table);
    const targets = rows.filter(where).map((r: any) => r.id);
    const results: any[] = [];
    for (const id of targets) {
      // best-effort sequential to preserve version ordering
      // eslint-disable-next-line no-await-in-loop
      const r = await update(table, id, changes.set, { clientOpId: opts?.clientOpId });
      results.push(r);
    }
    return { ok: results.length, pks: targets, failed: [] as any[] };
  }

  async function del(table: string, pk: string | number | Record<string, string | number>, opts?: { clientOpId?: string }) {
    const key = typeof pk === 'object' ? JSON.stringify(pk) : String(pk);
    const t = getTable(table);
    const prev = t.get(key);
    if (prev) {
      t.delete(key);
      notify(table, { table, pks: [key] });
      const ds = await getStore();
      if (ds) await ds.apply([{ table, type: 'delete', pk: key }]);
    }
    try {
      const res = await postJson('/mutate', { op: 'delete', table, pk, clientOpId: opts?.clientOpId });
      return res.json() as Promise<{ ok: true }>;
    } catch (e) {
      if (prev) {
        t.set(key, prev);
        notify(table, { table, pks: [key] });
        const ds = await getStore();
        if (ds) await ds.apply([{ table, type: 'insert', row: prev }]);
      }
      throw e;
    }
  }

  async function deleteWhere(table: string, where: (row: any) => boolean, opts?: { clientOpId?: string }) {
    const rows = await selectAll(table);
    const targets = rows.filter(where).map((r: any) => r.id);
    const failed: any[] = [];
    for (const id of targets) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await del(table, id, { clientOpId: opts?.clientOpId });
      } catch (e: any) {
        failed.push({ pk: id, error: { code: 'INTERNAL', message: String(e?.message || e) } });
      }
    }
    return { ok: targets.length - failed.length, pks: targets, failed };
  }

  async function mutator<K extends keyof TServerMutators>(name: K, args: TServerMutators[K] extends { handler: (ctx: any, args: infer A) => any } ? A : unknown): Promise<TServerMutators[K] extends { handler: (...a: any) => infer R } ? Awaited<R> : unknown> {
    const res = await postJson(`/mutators/${encodeURIComponent(String(name))}`, { args });
    const json = await res.json();
    return json.result as any;
  }

  function watch(table: string, onChange: (evt: { table: string; pks?: (string | number | Record<string, unknown>)[]; rowVersions?: Record<string, number> }) => void) {
    // register local watcher
    let set = watchers.get(table);
    if (!set) { set = new Set(); watchers.set(table, set); }
    set.add(onChange as any);

    const ac = new AbortController();
    let backoffMs = 500;
    let lastEventId: string | null = null;
    let stopped = false;

    async function start() {
      try {
        const headers: Record<string, string> = {};
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;
        const res = await fetchImpl(`${baseURL}/events`, { signal: ac.signal, headers });
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
        const reader = res.body.getReader();
        const td = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += td.decode(value);
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const f of frames) {
            if (f.startsWith(':')) continue; // keepalive
            const idLine = f.split('\n').find((l) => l.startsWith('id: '));
            if (idLine) lastEventId = idLine.slice(4).trim();
            if (f.includes('event: mutation')) {
              const lines = f.split('\n');
              const dataLine = lines.find((l) => l.startsWith('data: ')) || '';
              const json = dataLine.slice(6);
              try {
                const payload = JSON.parse(json) as { tables: { name: string; pks?: any[]; rowVersions?: Record<string, number> }[] };
                for (const t of payload.tables) {
                  if (t.name === table) onChange({ table: t.name, pks: t.pks, rowVersions: t.rowVersions });
                }
              } catch { }
            }
          }
        }
        // normal end -> retry
        if (!stopped) scheduleRetry();
      } catch {
        if (!stopped) scheduleRetry();
      }
    }

    function scheduleRetry() {
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 5000);
      setTimeout(() => { if (!stopped) start(); }, delay);
    }

    start();
    return () => { stopped = true; ac.abort(); set!.delete(onChange as any); };
  }

  const local = {
    async readByPk(table: string, pk: string | number | Record<string, unknown>) {
      const ds = await getStore();
      if (!ds) return null;
      return ds.readByPk(table, pk);
    },
    async readWindow(table: string, q?: { limit?: number; orderBy?: Record<string, 'asc' | 'desc'>; cursor?: string | null }) {
      const ds = await getStore();
      if (!ds) return { data: [], nextCursor: null };
      return ds.readWindow(table, q);
    }
  };

  const api = { config: { baseURL }, select, insert, update, updateWhere, delete: del, deleteWhere, upsert: (table: string, row: Record<string, unknown>, opts?: { merge?: string[]; clientOpId?: string }) => postJson('/mutate', { op: 'upsert', table, row, merge: opts?.merge, clientOpId: opts?.clientOpId }).then(r => r.json()), mutator, watch, local, table: (name: string): TableApi => tableApiFor(name) } as const;
  type TableApi = {
    select(args: Omit<SelectArgs, 'table'>): Promise<{ data: any[]; nextCursor: string | null }>;
    insert(row: Record<string, unknown>, opts?: { clientOpId?: string }): Promise<MutationResult>;
    update(pk: string | number | Record<string, string | number>, set: Record<string, unknown>, opts?: { ifVersion?: number; clientOpId?: string }): Promise<MutationResult>;
    delete(pk: string | number | Record<string, string | number>, opts?: { clientOpId?: string }): Promise<{ ok: true }>;
    upsert(row: Record<string, unknown>, opts?: { merge?: string[]; clientOpId?: string }): Promise<any>;
    watch(onChange: (evt: { table: string; pks?: any[]; rowVersions?: Record<string, number> }) => void): () => void;
    updateWhere(where: (row: any) => boolean, changes: { set: Record<string, unknown> }, opts?: { clientOpId?: string }): Promise<{ ok: number; pks: any[]; failed: any[] }>;
    deleteWhere(where: (row: any) => boolean, opts?: { clientOpId?: string }): Promise<{ ok: number; pks: any[]; failed: any[] }>;
  };
  type TypedTableApi<Row extends Record<string, unknown>> = {
    select(args: Omit<SelectArgs, 'table'>): Promise<{ data: Row[]; nextCursor: string | null }>;
    insert(row: Partial<Row>, opts?: { clientOpId?: string }): Promise<MutationResult>;
    update(pk: PrimaryKey, set: Partial<Row>, opts?: { ifVersion?: number; clientOpId?: string }): Promise<MutationResult>;
    delete(pk: PrimaryKey, opts?: { clientOpId?: string }): Promise<{ ok: true }>;
    upsert(row: Partial<Row>, opts?: { merge?: (keyof Row & string)[]; clientOpId?: string }): Promise<any>;
    watch(onChange: (evt: { table: string; pks?: PrimaryKey[]; rowVersions?: Record<string, number> }) => void): () => void;
    updateWhere(where: (row: Row) => boolean, changes: { set: Partial<Row> }, opts?: { clientOpId?: string }): Promise<{ ok: number; pks: PrimaryKey[]; failed: any[] }>;
    deleteWhere(where: (row: Row) => boolean, opts?: { clientOpId?: string }): Promise<{ ok: number; pks: PrimaryKey[]; failed: any[] }>;
  };
  function tableApiFor(name: string): TableApi {
    return {
      select(args) { return select({ table: name, ...args }); },
      insert(row, opts) { return insert(name, row, opts); },
      update(pk, set, opts) { return update(name, pk, set, opts); },
      delete(pk, opts) { return del(name, pk, opts); },
      upsert(row, opts) { return api.upsert(name, row, opts); },
      watch(onChange) { return watch(name, onChange); },
      updateWhere(where, changes, opts) { return updateWhere(name, where, changes, opts); },
      deleteWhere(where, opts) { return deleteWhere(name, where, opts); }
    };
  }
  type Api = typeof api
    & { mutators: ClientMutatorsFromServer<TServerMutators> & { call: (name: string, args: unknown) => Promise<unknown> } }
    & { [K in keyof AppSchema]: TypedTableApi<RowOf<AppSchema, K>> };
  // Build typed mutators proxy that infers keys/types from config.mutators when provided, and expose a dynamic call
  const mutators = new Proxy({ call: (name: string, args: any) => mutator(name as any, args) }, {
    get(target, prop: string) {
      if (prop === 'call') return (target as any).call;
      return (args: any) => mutator(prop as any, args);
    }
  }) as any as ClientMutatorsFromServer<TServerMutators> & { call: (name: string, args: unknown) => Promise<unknown> };
  const root = new Proxy({ ...api, mutators } as any, {
    get(target, prop: string) {
      if (prop in target) return (target as any)[prop];
      if (typeof prop === 'string') return tableApiFor(prop);
      return (target as any)[prop];
    }
  });
  return root as Api;
}


function cryptoRandomId() {
  if (typeof (globalThis as any).crypto?.randomUUID === 'function') return (globalThis as any).crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
