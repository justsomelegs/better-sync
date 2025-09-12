import { ulid } from 'ulidx';

type PrimaryKey = string | number | Record<string, string | number>;
type OrderBy = Record<string, 'asc' | 'desc'>;
type SelectWindow = { select?: string[]; orderBy?: OrderBy; limit?: number; cursor?: string | null };

type SelectRequest = { table: string; where?: unknown; select?: string[]; orderBy?: OrderBy; limit?: number; cursor?: string | null; pk?: PrimaryKey };
type SelectResponse = { data: Record<string, unknown>[]; nextCursor?: string | null; row?: Record<string, unknown> | null };
type MutationRequest =
  | { op: 'insert'; table: string; rows: Record<string, unknown> | Record<string, unknown>[]; clientOpId?: string }
  | { op: 'update'; table: string; pk: PrimaryKey; set: Record<string, unknown>; ifVersion?: number; clientOpId?: string }
  | { op: 'delete'; table: string; pk: PrimaryKey; clientOpId?: string }
  | { op: 'upsert'; table: string; rows: Record<string, unknown> | Record<string, unknown>[]; merge?: string[]; clientOpId?: string };

type ClientOptions<TApp = any> = {
  baseURL: string;
  realtime?: 'sse' | 'poll' | 'off';
  pollIntervalMs?: number;
  datastore?: ClientDatastore;
};

export interface ClientDatastore {
  apply(table: string, pk: PrimaryKey, diff: { set?: Record<string, unknown>; unset?: string[] }): Promise<void>;
  reconcile(table: string, pk: PrimaryKey, row: Record<string, unknown> & { version: number }): Promise<void>;
  readByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
  readWindow(table: string, req: SelectWindow & { where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }>;
}

class MemoryDatastore implements ClientDatastore {
  private tables = new Map<string, Map<string, any>>();
  private getTable(name: string) {
    let t = this.tables.get(name);
    if (!t) { t = new Map(); this.tables.set(name, t); }
    return t;
  }
  private key(pk: PrimaryKey) { return typeof pk === 'string' || typeof pk === 'number' ? String(pk) : Object.keys(pk).sort().map(k => `${k}=${String((pk as any)[k])}`).join('|'); }
  async apply(table: string, pk: PrimaryKey, diff: { set?: Record<string, unknown>; unset?: string[] }): Promise<void> {
    const t = this.getTable(table);
    const k = this.key(pk);
    const cur = t.get(k) ?? {};
    const next = { ...cur, ...(diff.set ?? {}) };
    for (const u of diff.unset ?? []) delete (next as any)[u];
    t.set(k, next);
  }
  async reconcile(table: string, pk: PrimaryKey, row: Record<string, unknown> & { version: number }): Promise<void> {
    const t = this.getTable(table);
    const k = this.key(pk);
    const cur = t.get(k);
    if (!cur || (cur.version ?? 0) <= row.version) {
      t.set(k, row);
    }
  }
  async readByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null> {
    const t = this.getTable(table);
    const k = this.key(pk);
    const row = t.get(k) ?? null;
    if (!row) return null;
    if (!select || !select.length) return row;
    const out: Record<string, unknown> = {};
    for (const f of select) out[f] = row[f];
    return out;
  }
  async readWindow(table: string, req: SelectWindow & { where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }> {
    const t = this.getTable(table);
    const rows = Array.from(t.values());
    const order = req.orderBy ?? { updatedAt: 'desc' as const };
    rows.sort((a, b) => {
      const dir = order.updatedAt === 'asc' ? 1 : -1;
      if ((a.updatedAt ?? 0) === (b.updatedAt ?? 0)) return (a.id ?? '').localeCompare(b.id ?? '') * dir;
      return ((a.updatedAt ?? 0) - (b.updatedAt ?? 0)) * dir;
    });
    const limit = Math.min(1000, Math.max(1, req.limit ?? 100));
    const slice = rows.slice(0, limit);
    const selected = (req.select && req.select.length) ? slice.map(r => {
      const o: Record<string, unknown> = {}; for (const f of req.select!) o[f] = r[f]; return o;
    }) : slice;
    return { data: selected, nextCursor: null };
  }
}

type WatchCallbackRow = (payload: { item: any | null; change?: { type: 'inserted' | 'updated' | 'deleted'; item?: any }; cursor?: string | null }) => void;
type WatchCallbackQuery = (payload: { data: any[]; changes?: { inserted: any[]; updated: any[]; deleted: Array<string | Record<string, unknown>> }; cursor?: string | null }) => void;

export function memory(): ClientDatastore { return new MemoryDatastore(); }

export function createClient<TApp = any>(options: ClientOptions<TApp>) {
  const baseURL = options.baseURL.replace(/\/$/, '');
  const datastore = options.datastore ?? memory();
  const realtime: 'sse' | 'poll' | 'off' = options.realtime ?? 'sse';
  const pollIntervalMs = options.pollIntervalMs ?? 1500;

  let sse: EventSource | null = null;
  const subscriptions = new Map<number, { table: string; kind: 'row' | 'query'; pk?: PrimaryKey; query?: SelectWindow & { where?: (row: any) => boolean }; cb: WatchCallbackRow | WatchCallbackQuery }>();
  let subSeq = 1;

  async function post(path: string, payload: unknown) {
    const res = await fetch(baseURL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function applyWhere<T extends Record<string, unknown>>(rows: T[], where?: (row: T) => boolean): T[] {
    if (!where) return rows;
    return rows.filter(r => {
      try { return !!where(r); } catch { return false; }
    });
  }

  async function selectAllPages(table: string, req: SelectWindow): Promise<{ data: any[]; nextCursor: string | null }> {
    let cursor: string | null | undefined = req.cursor ?? null;
    const all: any[] = [];
    for (;;) {
      const res: SelectResponse = await post('/select', { table, select: req.select, orderBy: req.orderBy, limit: req.limit, cursor });
      const page = res.data ?? [];
      all.push(...page);
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
    }
    return { data: all, nextCursor: null };
  }

  function startSseIfNeeded() {
    if (realtime !== 'sse' || sse) return;
    try {
      sse = new EventSource(baseURL + '/events');
      sse.addEventListener('mutation', async (ev: MessageEvent) => {
        try {
          const payload = JSON.parse(String((ev as any).data));
          const tables = payload.tables as Array<{ name: string }>;
          for (const [id, sub] of subscriptions) {
            for (const t of tables) {
              if (t.name === sub.table) {
                if (sub.kind === 'row') {
                  const rowRes = await post('/select', { table: sub.table, pk: sub.pk });
                  (sub.cb as WatchCallbackRow)({ item: rowRes.row ?? null });
                } else {
                  const win = sub.query!;
                  const res: SelectResponse = await post('/select', { table: sub.table, select: win.select, orderBy: win.orderBy, limit: win.limit, cursor: win.cursor });
                  const data = applyWhere((res.data ?? []) as any[], win.where as any);
                  (sub.cb as WatchCallbackQuery)({ data, cursor: res.nextCursor ?? null });
                }
                break;
              }
            }
          }
        } catch {}
      });
      sse.onerror = () => {
        try { sse?.close(); } catch {}
        sse = null;
        setTimeout(startSseIfNeeded, 1000);
      };
    } catch {
      if (realtime === 'sse' || realtime === 'poll') startPolling();
    }
  }

  let pollTimer: any = null;
  function startPolling() {
    if (realtime !== 'poll' || pollTimer) return;
    pollTimer = setInterval(async () => {
      for (const [, sub] of subscriptions) {
        if (sub.kind === 'row') {
          const rowRes = await post('/select', { table: sub.table, pk: sub.pk });
          (sub.cb as WatchCallbackRow)({ item: rowRes.row ?? null });
        } else {
          const win = sub.query!;
          const res: SelectResponse = await post('/select', { table: sub.table, select: win.select, orderBy: win.orderBy, limit: win.limit, cursor: win.cursor });
          const data = applyWhere((res.data ?? []) as any[], win.where as any);
          (sub.cb as WatchCallbackQuery)({ data, cursor: res.nextCursor ?? null });
        }
      }
    }, pollIntervalMs);
  }

  async function insert(table: string, rows: any | any[]) {
    const opId = ulid();
    const arr = Array.isArray(rows) ? rows : [rows];
    for (const r of arr) {
      const tempId = r.id ?? `temp_${ulid()}`;
      await datastore.apply(table, tempId, { set: { ...r, id: tempId } });
    }
    const res = await post('/mutate', { op: 'insert', table, rows: arr, clientOpId: opId });
    const ins = (Array.isArray(rows) ? (res.rows as any[]) : [res.row]);
    for (const row of ins) {
      await datastore.reconcile(table, row.id, row);
    }
    return Array.isArray(rows) ? ins : ins[0];
  }

  async function update(table: string, pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }) {
    const opId = ulid();
    await datastore.apply(table, pk, { set });
    try {
      const res = await post('/mutate', { op: 'update', table, pk, set, ifVersion: opts?.ifVersion, clientOpId: opId });
      await datastore.reconcile(table, pk, res.row);
      return res.row;
    } catch (e) {
      const rowRes = await post('/select', { table, pk });
      if (rowRes.row) await datastore.reconcile(table, pk, rowRes.row);
      throw e;
    }
  }

  async function _delete(table: string, pk: PrimaryKey) {
    const opId = ulid();
    await datastore.apply(table, pk, { unset: ['id'] });
    try {
      await post('/mutate', { op: 'delete', table, pk, clientOpId: opId });
      return { ok: true as const };
    } catch (e) {
      const rowRes = await post('/select', { table, pk });
      if (rowRes.row) await datastore.reconcile(table, pk, rowRes.row);
      throw e;
    }
  }

  async function upsert(table: string, rows: any | any[], opts?: { merge?: string[] }) {
    const opId = ulid();
    const arr = Array.isArray(rows) ? rows : [rows];
    for (const r of arr) {
      const id = r.id ?? `temp_${ulid()}`;
      await datastore.apply(table, id, { set: { ...r, id } });
    }
    const res = await post('/mutate', { op: 'upsert', table, rows: arr, merge: opts?.merge, clientOpId: opId });
    const ret = Array.isArray(rows) ? (res.rows as any[]) : [res.row];
    for (const row of ret) await datastore.reconcile(table, row.id, row);
    return Array.isArray(rows) ? ret : ret[0];
  }

  async function updateWhere(table: string, where: (row: any) => boolean, set: Record<string, unknown>) {
    const { data } = await selectAllPages(table, { orderBy: { updatedAt: 'desc' }, limit: 100 });
    const targets = applyWhere(data, where);
    const failed: Array<{ pk: PrimaryKey; error: { code: string; message: string } }> = [];
    let ok = 0;
    const pks: PrimaryKey[] = [];
    for (const row of targets) {
      try {
        const updated = await update(table, (row as any).id, set);
        pks.push((row as any).id);
        ok++;
      } catch (e: any) {
        failed.push({ pk: (row as any).id, error: { code: 'INTERNAL', message: String(e?.message ?? e) } });
      }
    }
    return { ok, failed, pks };
  }

  async function deleteWhere(table: string, where: (row: any) => boolean) {
    const { data } = await selectAllPages(table, { orderBy: { updatedAt: 'desc' }, limit: 100 });
    const targets = applyWhere(data, where);
    const failed: Array<{ pk: PrimaryKey; error: { code: string; message: string } }> = [];
    let ok = 0;
    const pks: PrimaryKey[] = [];
    for (const row of targets) {
      try {
        await _delete(table, (row as any).id);
        pks.push((row as any).id);
        ok++;
      } catch (e: any) {
        failed.push({ pk: (row as any).id, error: { code: 'INTERNAL', message: String(e?.message ?? e) } });
      }
    }
    return { ok, failed, pks };
  }

  function watchRow(table: string, pk: PrimaryKey, cb: WatchCallbackRow, opts?: { select?: string[] }) {
    const id = subSeq++;
    subscriptions.set(id, { table, kind: 'row', pk, cb });
    post('/select', { table, pk, select: opts?.select }).then(res => (cb as WatchCallbackRow)({ item: res.row ?? null }));
    startSseIfNeeded();
    if (realtime === 'poll') startPolling();
    return {
      unsubscribe() { subscriptions.delete(id); },
      status: 'live' as const,
      error: undefined,
      getSnapshot: () => datastore.readByPk(table, pk, opts?.select)
    };
  }

  function watchQuery(table: string, query: SelectWindow & { where?: (row: any) => boolean }, cb: WatchCallbackQuery) {
    const id = subSeq++;
    subscriptions.set(id, { table, kind: 'query', query, cb });
    post('/select', { table, select: query.select, orderBy: query.orderBy, limit: query.limit, cursor: query.cursor }).then(res => {
      const data = applyWhere(((res as SelectResponse).data ?? []) as any[], query.where as any);
      (cb as WatchCallbackQuery)({ data, cursor: res.nextCursor ?? null });
    });
    startSseIfNeeded();
    if (realtime === 'poll') startPolling();
    return {
      unsubscribe() { subscriptions.delete(id); },
      status: 'live' as const,
      error: undefined,
      getSnapshot: async () => (await datastore.readWindow(table, query)).data
    };
  }

  function tableApi(name: string) {
    return {
      select(arg1: any, arg2?: any) {
        if (typeof arg1 === 'string' || typeof arg1 === 'number' || (arg1 && typeof arg1 === 'object' && !('where' in arg1))) {
          return post('/select', { table: name, pk: arg1, select: arg2?.select }).then(r => r.row ?? null);
        }
        const req = arg1 as SelectWindow & { where?: (row: any) => boolean };
        return post('/select', { table: name, select: req.select, orderBy: req.orderBy, limit: req.limit, cursor: req.cursor }).then(r => ({ data: applyWhere(r.data, req.where), nextCursor: r.nextCursor ?? null }));
      },
      watch(arg1: any, arg2: any, arg3?: any) {
        if (typeof arg1 === 'string' || typeof arg1 === 'number' || (arg1 && typeof arg1 === 'object' && !('where' in arg1))) {
          return watchRow(name, arg1, arg2, arg3);
        }
        return watchQuery(name, arg1, arg2);
      },
      insert: (row: any | any[]) => insert(name, row),
      update: (first: any, second?: any, third?: any) => {
        if (first && typeof first === 'object' && 'where' in first) {
          return updateWhere(name, (first as any).where, (second as any).set);
        }
        return update(name, first as PrimaryKey, second as any, third as any);
      },
      delete: (first: any) => {
        if (first && typeof first === 'object' && 'where' in first) {
          return deleteWhere(name, (first as any).where);
        }
        return _delete(name, first as PrimaryKey);
      },
      upsert: (row: any | any[], opts?: { merge?: string[] }) => upsert(name, row, opts),
      $infer: {} as any
    };
  }

  const client: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'close') return () => { try { sse?.close(); } catch {}; if (pollTimer) clearInterval(pollTimer); };
      if (prop === 'mutators') return new Proxy({}, { get: (_t2, name: string) => (args: unknown) => post(`/mutators/${name}`, { args }) });
      return tableApi(prop);
    }
  });

  return client;
}

export type { ClientOptions, SelectWindow, OrderBy, PrimaryKey };
