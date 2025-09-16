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
import type { ClientMutators, MutatorsSpec, ServerMutatorsSpec, ClientMutatorsFromServer } from './types';

type WatchArgs = string | { table: string; where?: (row: any) => boolean; select?: string[]; orderBy?: OrderBy; limit?: number };
type WatchEvent = { table: string; pks?: (string | number | Record<string, unknown>)[]; rowVersions?: Record<string, number>; data?: any[]; error?: { code: string; message: string } };

type WatchOptions = { initialSnapshot?: boolean; debounceMs?: number };

type RealtimeMode = 'sse' | 'poll' | 'off';

export function createClient<_TApp = unknown, TServerMutators extends ServerMutatorsSpec = {}>(config: { baseURL: string; fetch?: typeof fetch; datastore?: LocalStore | Promise<LocalStore>; mutators?: TServerMutators; realtime?: RealtimeMode; pollIntervalMs?: number }) {
  const baseURL = config.baseURL.replace(/\/$/, '');
  const fetchImpl = config.fetch ?? fetch;
  const realtimeMode: RealtimeMode = config.realtime ?? 'sse';
  const pollIntervalMs = config.pollIntervalMs ?? 1500;
  let storePromise: Promise<LocalStore> | null = null;
  if (config.datastore) storePromise = Promise.resolve(config.datastore);
  async function getStore(): Promise<LocalStore | null> { return storePromise ? storePromise : null; }

  // per-table cache and watchers with options
  const cache = new Map<string, Map<string, any>>();
  const watchers = new Map<string, Set<{ fn: (evt: WatchEvent) => void; opts: WatchOptions; args: { where?: (row: any) => boolean; select?: string[]; orderBy?: OrderBy; limit?: number } }>>();
  function getTable(table: string) {
    let t = cache.get(table);
    if (!t) { t = new Map(); cache.set(table, t); }
    return t;
  }
  function notify(table: string, evt: WatchEvent) {
    const set = watchers.get(table);
    if (set) for (const { fn } of set) { try { fn(evt); } catch { } }
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
    const ds = await getStore();
    if (!args.where) {
      if (ds) {
        const win = await ds.readWindow(args.table, { limit: args.limit, orderBy: args.orderBy, cursor: args.cursor ?? null });
        return { data: win.data, nextCursor: win.nextCursor };
      }
      const res = await postJson('/select', args);
      const json = await res.json();
      if (!args.cursor) {
        const t = getTable(args.table);
        for (const row of json.data) t.set(String(row.id), row);
        if (ds) await ds.apply(json.data.map((r: any) => ({ table: args.table, type: 'insert', row: r })));
      }
      return json;
    }
    // where provided: client-side filtering using paginated windows from server/datastore
    const predicate = args.where as (row: any) => boolean;
    const pageSize = args.limit ?? 100;
    const orderBy = args.orderBy;
    const collected: any[] = [];
    let cursor: string | null | undefined = args.cursor ?? undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const win = ds
        ? await ds.readWindow(args.table, { limit: pageSize, orderBy, cursor: cursor ?? null })
        : await postJson('/select', { table: args.table, select: args.select, orderBy, limit: pageSize, cursor }).then(r => r.json());
      const rows = (win as any).data as any[];
      for (const r of rows) if (predicate(r)) collected.push(r);
      if (collected.length >= pageSize) break;
      cursor = (win as any).nextCursor ?? null;
      if (!cursor) break;
    }
    const data = collected.slice(0, pageSize);
    const nextCursor = collected.length > pageSize ? String(data[data.length - 1]?.id ?? '') : (cursor ?? null);
    return { data, nextCursor };
  }

  // optimistic mutation helpers unchanged ...
  async function insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[], opts?: { clientOpId?: string }) {
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
          // suppress notify here to avoid duplicate immediate events; SSE will notify and snapshot will follow
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
        // suppress notify here; SSE mutation will trigger immediate notify + snapshot
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

  // Shared SSE connection and debounce
  let sseAC: AbortController | null = null;
  let sseRunning = false;
  let lastEventId: string | null = null;
  const seenEventIds = new Set<string>();
  const tableDebounce = new Map<string, any>();

  async function startSseIfNeeded() {
    if (sseRunning || realtimeMode !== 'sse') return;
    if (watchers.size === 0) return;
    sseAC = new AbortController();
    sseRunning = true;
    try {
      const headers: Record<string, string> = {};
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;
      const res = await fetchImpl(`${baseURL}/events`, { signal: sseAC.signal, headers });
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
          if (idLine) {
            const eid = idLine.slice(4).trim();
            lastEventId = eid;
            if (seenEventIds.has(eid)) continue;
            seenEventIds.add(eid);
          }
          if (f.includes('event: mutation')) {
            const dataLine = f.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            let payload: any = {};
            try { payload = JSON.parse(dataLine.slice(6)); } catch { }
            const tables = Array.isArray(payload.tables) ? payload.tables : [];
            for (const t of tables) {
              const tableName = t?.name as string;
              if (!tableName || !watchers.has(tableName)) continue;
              // immediate notify
              notify(tableName, { table: tableName, pks: t.pks, rowVersions: t.rowVersions });
              // debounce snapshot per table: run per watcher with its args
              if (tableDebounce.get(tableName)) continue;
              const delay =  (Array.from(watchers.get(tableName) || [])[0]?.opts?.debounceMs) ?? 20;
              tableDebounce.set(tableName, setTimeout(async () => {
                tableDebounce.delete(tableName);
                const subs = watchers.get(tableName);
                if (!subs || subs.size === 0) return;
                for (const { fn, args } of subs) {
                  try {
                    const res = await select({ table: tableName, where: args.where, select: args.select, orderBy: args.orderBy, limit: args.limit });
                    fn({ table: tableName, data: res.data });
                  } catch (e: any) {
                    fn({ table: tableName, error: { code: 'INTERNAL', message: String(e?.message || e) } });
                  }
                }
              }, delay));
            }
          }
        }
      }
    } catch (e) {
      // surface error to all watchers
      for (const [tableName, subs] of watchers) for (const { fn } of subs) fn({ table: tableName, error: { code: 'INTERNAL', message: String((e as any)?.message || e) } });
    } finally {
      sseRunning = false;
      if (watchers.size > 0 && realtimeMode === 'sse') {
        setTimeout(() => { if (!sseRunning) startSseIfNeeded(); }, 500);
      }
    }
  }

  function stopSseIfIdle() {
    if (watchers.size === 0 && sseAC) { try { sseAC.abort(); } catch { } sseAC = null; sseRunning = false; }
  }

  function watch(table: WatchArgs, onChange: (evt: WatchEvent) => void, opts?: WatchOptions) {
    const tableName = typeof table === 'string' ? table : table.table;
    let set = watchers.get(tableName);
    if (!set) { set = new Set(); watchers.set(tableName, set); }
    const entry = { fn: onChange, opts: opts ?? {}, args: typeof table === 'string' ? {} : { where: table.where, select: table.select, orderBy: table.orderBy, limit: table.limit } };
    set.add(entry);

    // initial snapshot (default true)
    const initialSnapshot = opts?.initialSnapshot !== false;
    (async () => {
      if (!initialSnapshot) return;
      try {
        if (typeof table === 'string') {
          const win = await select({ table: tableName, limit: 1 });
          onChange({ table: tableName, data: win.data });
        } else {
          const res = await select({ table: tableName, where: table.where, select: table.select, orderBy: table.orderBy, limit: table.limit });
          onChange({ table: tableName, data: res.data });
        }
      } catch (e: any) {
        onChange({ table: tableName, error: { code: 'INTERNAL', message: String(e?.message || e) } });
      }
    })();

    // subscribe based on realtime mode
    let pollTimer: any = null;
    if (realtimeMode === 'sse') {
      startSseIfNeeded();
    } else if (realtimeMode === 'poll') {
      pollTimer = setInterval(async () => {
        try {
          if (typeof table === 'string') {
            const data = await select({ table: tableName, limit: 1 });
            onChange({ table: tableName, data: data.data });
          } else {
            const data = await select({ table: tableName, where: table.where, select: table.select, orderBy: table.orderBy, limit: table.limit });
            onChange({ table: tableName, data: data.data });
          }
        } catch (e: any) {
          onChange({ table: tableName, error: { code: 'INTERNAL', message: String(e?.message || e) } });
        }
      }, pollIntervalMs);
    }

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      const s = watchers.get(tableName);
      if (s) { s.delete(entry); if (s.size === 0) watchers.delete(tableName); }
      stopSseIfIdle();
    };
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

  const api = { config: { baseURL }, select, insert, update, updateWhere, delete: del, deleteWhere, upsert: (table: string, rows: Record<string, unknown> | Record<string, unknown>[], opts?: { merge?: string[]; clientOpId?: string }) => postJson('/mutate', { op: 'upsert', table, rows, merge: opts?.merge, clientOpId: opts?.clientOpId }).then(r => r.json()), mutator, watch, local } as const;
  type TableApi = {
    select(args: Omit<SelectArgs, 'table'>): Promise<{ data: any[]; nextCursor: string | null }>;
    insert(row: Record<string, unknown>, opts?: { clientOpId?: string }): Promise<MutationResult>;
    update(pk: string | number | Record<string, string | number>, set: Record<string, unknown>, opts?: { ifVersion?: number; clientOpId?: string }): Promise<MutationResult>;
    delete(pk: string | number | Record<string, string | number>, opts?: { clientOpId?: string }): Promise<{ ok: true }>;
    upsert(rows: Record<string, unknown> | Record<string, unknown>[], opts?: { merge?: string[]; clientOpId?: string }): Promise<any>;
    watch(onChange: (evt: { table: string; pks?: any[]; rowVersions?: Record<string, number> }) => void): () => void;
    updateWhere(where: (row: any) => boolean, changes: { set: Record<string, unknown> }, opts?: { clientOpId?: string }): Promise<{ ok: number; pks: any[]; failed: any[] }>;
    deleteWhere(where: (row: any) => boolean, opts?: { clientOpId?: string }): Promise<{ ok: number; pks: any[]; failed: any[] }>;
  };
  function tableApiFor(name: string): TableApi {
    return {
      select(args) { return select({ table: name, ...args }); },
      insert(row, opts) { return insert(name, row, opts); },
      update(pk, set, opts) { return update(name, pk, set, opts); },
      delete(pk, opts) { return del(name, pk, opts); },
      upsert(rows, opts) { return api.upsert(name, rows, opts); },
      watch(onChange) { return watch(name, onChange as any); },
      updateWhere(where, changes, opts) { return updateWhere(name, where, changes, opts); },
      deleteWhere(where, opts) { return deleteWhere(name, where, opts); }
    };
  }
  type Api = typeof api & { mutators: ClientMutatorsFromServer<TServerMutators> & { call: (name: string, args: unknown) => Promise<unknown> } } & Record<string, TableApi>;
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
