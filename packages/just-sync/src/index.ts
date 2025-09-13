export type PrimaryKey = string | number | Record<string, string | number>;
export type OrderBy = Record<string, 'asc' | 'desc'>;
export type SelectWindow = {
  select?: string[];
  orderBy?: OrderBy;
  limit?: number;
  cursor?: string | null;
};

export type MutationOp =
  | { op: 'insert'; table: string; rows: Record<string, unknown> | Record<string, unknown>[] }
  | { op: 'update'; table: string; pk: PrimaryKey; set: Record<string, unknown>; ifVersion?: number }
  | { op: 'updateWhere'; table: string; where: unknown; set: Record<string, unknown> }
  | { op: 'delete'; table: string; pk: PrimaryKey }
  | { op: 'deleteWhere'; table: string; where: unknown }
  | { op: 'upsert'; table: string; rows: Record<string, unknown> | Record<string, unknown>[]; merge?: string[] };

export type MutationRequest = MutationOp & { clientOpId?: string };
export type MutationResponse =
  | { row: Record<string, unknown> }
  | { rows: Record<string, unknown>[] }
  | { ok: true }
  | { ok: number; failed: Array<{ pk: PrimaryKey; error: { code: string; message: string } }>; pks: PrimaryKey[] };

export type SelectRequest = {
  table: string;
  where?: unknown;
  select?: string[];
  orderBy?: OrderBy;
  limit?: number;
  cursor?: string | null;
};
export type SelectResponse = { data: Record<string, unknown>[]; nextCursor?: string | null };

export type SseEvent = {
  eventId: string;
  txId: string;
  tables: Array<{
    name: string;
    type: 'mutation';
    pks: PrimaryKey[];
    rowVersions?: Record<string, number>;
    diffs?: Record<string, { set?: Record<string, unknown>; unset?: string[] }>;
  }>;
};

export interface DatabaseAdapter {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateByPk(table: string, pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }): Promise<Record<string, unknown>>;
  deleteByPk(table: string, pk: PrimaryKey): Promise<{ ok: true }>;
  selectByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
  selectWindow(table: string, req: SelectWindow & { where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }>;
}

export interface ClientDatastore {
  apply(table: string, pk: PrimaryKey, diff: { set?: Record<string, unknown>; unset?: string[] }): Promise<void>;
  reconcile(table: string, pk: PrimaryKey, row: Record<string, unknown> & { version: number }): Promise<void>;
  readByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
  readWindow(table: string, req: SelectWindow & { where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }>;
}

export interface IdempotencyStore {
  get(key: string): Promise<{ status: 'hit'; response: unknown } | { status: 'miss' }>;
  set(key: string, response: unknown, ttlMs: number): Promise<void>;
  acquire?(key: string, ttlMs: number): Promise<{ ok: true } | { ok: false }>;
  release?(key: string): Promise<void>;
}

export type MutatorDef<Args, Result> = {
  args?: unknown;
  handler(ctx: { db: DatabaseAdapter; ctx: Record<string, unknown> }, args: Args): Promise<Result>;
};
export type Mutators = Record<string, MutatorDef<any, any>>;

export type CreateSyncOptions = {
  schema: Record<string, unknown>;
  database: DatabaseAdapter;
  mutators?: Mutators;
  idempotency?: IdempotencyStore;
  sse?: { bufferSeconds?: number; bufferMaxEvents?: number; heartbeatMs?: number };
};

export type SyncInstance = {
  handler: (req: Request) => Promise<Response>;
  fetch: (req: Request) => Promise<Response>;
  defineMutators(m: Mutators): Mutators;
  $mutators: Mutators;
};

// Simple ULID fallbacks for event/tx ids
import { ulid } from 'ulid';

class RingBuffer<T> {
  private buffer: Array<{ id: string; value: T }> = [];
  constructor(private maxAgeMs: number, private maxEvents: number) {}
  push(value: T) {
    const id = ulid();
    const now = Date.now();
    this.buffer.push({ id, value });
    // drop old by time
    const cutoff = now - this.maxAgeMs;
    // nothing to check by timestamp inside T; we prune by count and age using insertion time approximated by ulid monotonicity
    while (this.buffer.length > this.maxEvents) this.buffer.shift();
    // no precise timestamp; keep size-based for MVP
    return id;
  }
  since(lastId?: string) {
    if (!lastId) return this.buffer.slice();
    const idx = this.buffer.findIndex((e) => e.id === lastId);
    if (idx === -1) return this.buffer.slice();
    return this.buffer.slice(idx + 1);
  }
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function error(code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL', message: string, details?: unknown, init?: ResponseInit) {
  return json({ code, message, details }, { status: init?.status ?? (code === 'BAD_REQUEST' ? 400 : code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : 500) });
}

export function createSync(opts: CreateSyncOptions): SyncInstance {
  const mutators: Mutators = { ...(opts.mutators ?? {}) };
  const idStore: IdempotencyStore = opts.idempotency ?? {
    async get() { return { status: 'miss' }; },
    async set() { return; },
  };
  const buffer = new RingBuffer<SseEvent>(
    (opts.sse?.bufferSeconds ?? 60) * 1000,
    opts.sse?.bufferMaxEvents ?? 10000
  );

  async function handleEvents(req: Request): Promise<Response> {
    const last = req.headers.get('last-event-id') || undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        // send backlog
        const back = buffer.since(last);
        for (const e of back) {
          controller.enqueue(enc.encode(`id: ${e.id}\n`));
          controller.enqueue(enc.encode(`event: mutation\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify((e as any).value ?? e)}\n\n`));
        }
        const heartbeatMs = opts.sse?.heartbeatMs ?? 15000;
        const iv = setInterval(() => controller.enqueue(enc.encode(`:keepalive\n\n`)), heartbeatMs);
        (controller as any)._iv = iv;
      },
      cancel() {
        const iv = (this as any)._iv as ReturnType<typeof setInterval> | undefined;
        if (iv) clearInterval(iv);
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  async function handleSelect(body: SelectRequest): Promise<Response> {
    try {
      const limit = Math.min(1000, Math.max(1, body.limit ?? 100));
      const orderBy = body.orderBy ?? { updatedAt: 'desc' };
      const res = await opts.database.selectWindow(body.table, { select: body.select, orderBy, limit, cursor: body.cursor ?? null, where: body.where });
      return json({ data: res.data, nextCursor: res.nextCursor ?? null });
    } catch (e) {
      return error('INTERNAL', 'Unhandled select error');
    }
  }

  async function runMutation(op: MutationRequest): Promise<MutationResponse> {
    switch (op.op) {
      case 'insert': {
        const rows = Array.isArray(op.rows) ? op.rows : [op.rows];
        const inserted: Record<string, unknown>[] = [];
        await opts.database.begin();
        try {
          for (const r of rows) {
            inserted.push(await opts.database.insert(op.table, r));
          }
          await opts.database.commit();
        } catch (e) {
          await opts.database.rollback();
          throw e;
        }
        if (Array.isArray(op.rows)) return { rows: inserted };
        return { row: inserted[0]! };
      }
      case 'update': {
        const row = await opts.database.updateByPk(op.table, op.pk, op.set, { ifVersion: op.ifVersion });
        return { row };
      }
      case 'delete': {
        await opts.database.deleteByPk(op.table, op.pk);
        return { ok: true };
      }
      case 'upsert': {
        const rows = Array.isArray(op.rows) ? op.rows : [op.rows];
        const results: Record<string, unknown>[] = [];
        await opts.database.begin();
        try {
          for (const r of rows) {
            // naive: try insert, on conflict update by pk via updateByPk if pk exists
            try {
              results.push(await opts.database.insert(op.table, r));
            } catch {
              // fallback requires pk in payload
              const pk = (r as any).id ?? r;
              results.push(await opts.database.updateByPk(op.table, pk, r, {}));
            }
          }
          await opts.database.commit();
        } catch (e) {
          await opts.database.rollback();
          throw e;
        }
        if (Array.isArray(op.rows)) return { rows: results };
        return { row: results[0]! };
      }
      case 'updateWhere':
      case 'deleteWhere': {
        // MVP: client should resolve where -> pks; server returns not implemented
        throw Object.assign(new Error('updateWhere/deleteWhere require client-resolved PKs in MVP'), { code: 'BAD_REQUEST' });
      }
      default:
        throw Object.assign(new Error('Unknown op'), { code: 'BAD_REQUEST' });
    }
  }

  async function handleMutate(body: MutationRequest): Promise<Response> {
    const idemKey = body.clientOpId ? `op:${body.clientOpId}` : null;
    if (idemKey) {
      const g = await idStore.get(idemKey);
      if (g.status === 'hit') return json(g.response);
    }
    try {
      const res = await runMutation(body);
      // emit minimal SSE event without diffs for MVP
      const event: SseEvent = {
        eventId: '',
        txId: ulid(),
        tables: [{ name: body.table, type: 'mutation', pks: 'pk' in body ? [body.pk] : [] }],
      } as any;
      const eid = buffer.push(event);
      event.eventId = eid;
      if (idemKey) await idStore.set(idemKey, res, 10 * 60 * 1000);
      return json(res);
    } catch (e: any) {
      if (e && e.code === 'BAD_REQUEST') return error('BAD_REQUEST', e.message);
      if (e && e.code === 'CONFLICT') return error('CONFLICT', e.message, e.details);
      return error('INTERNAL', 'Unhandled mutate error');
    }
  }

  async function handleMutator(name: string, body: { args: unknown; clientOpId?: string }): Promise<Response> {
    const m = mutators[name];
    if (!m) return error('NOT_FOUND', `Mutator ${name} not found`);
    // no runtime validator in MVP core; user can pass zod schema in args field for future enhancement
    try {
      const result = await m.handler({ db: opts.database, ctx: {} }, body.args as any);
      // emit no event by default; mutators should write via db to trigger events
      return json({ result });
    } catch (e: any) {
      return error('INTERNAL', e?.message || 'Mutator error');
    }
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.endsWith('/events')) return handleEvents(req);
    if (req.method === 'POST' && url.pathname.endsWith('/select')) {
      const body = (await req.json()) as SelectRequest;
      return handleSelect(body);
    }
    if (req.method === 'POST' && url.pathname.endsWith('/mutate')) {
      const body = (await req.json()) as MutationRequest;
      return handleMutate(body);
    }
    if (req.method === 'POST' && url.pathname.includes('/mutators/')) {
      const name = url.pathname.split('/').pop()!;
      const body = (await req.json()) as { args: unknown; clientOpId?: string };
      return handleMutator(name, body);
    }
    return error('NOT_FOUND', 'Route not found');
  }

  return {
    handler,
    fetch: handler,
    defineMutators(m) {
      Object.assign(mutators, m);
      return mutators;
    },
    $mutators: mutators,
  };
}

export type CreateClientOptions<AppTypes extends { Schema?: any; Mutators?: any } | undefined = undefined> = {
  baseURL: string;
  realtime?: 'sse' | 'poll' | 'off';
  pollIntervalMs?: number;
  datastore?: ClientDatastore;
};

type InferTables<S> = S extends Record<string, any> ? keyof S : string;

export function createClient<AppTypes extends { Schema?: any; Mutators?: any } | undefined = undefined>(opts: CreateClientOptions<AppTypes>) {
  const baseURL = opts.baseURL.replace(/\/$/, '');
  const datastore: ClientDatastore = opts.datastore ?? createMemoryDatastore();
  const realtime = opts.realtime ?? 'sse';

  async function post(path: string, body: unknown) {
    const res = await fetch(`${baseURL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function table(name: string) {
    return {
      async select(pkOrQuery: PrimaryKey | SelectRequest) {
        if (typeof pkOrQuery === 'string' || typeof pkOrQuery === 'number' || (pkOrQuery && typeof pkOrQuery === 'object' && !('table' in pkOrQuery))) {
          const row = await datastore.readByPk(name, pkOrQuery as PrimaryKey);
          if (row) return row;
          const res: SelectResponse = await post('/select', { table: name, where: undefined, select: undefined, orderBy: { updatedAt: 'desc' }, limit: 1 });
          return res.data[0] ?? null;
        }
        const req = pkOrQuery as SelectRequest;
        const res: SelectResponse = await post('/select', { ...req, table: name });
        return res;
      },
      async insert(row: Record<string, unknown>) {
        // optimistic apply with temp id
        const clientOpId = ulid();
        const tempId = `temp_${clientOpId}`;
        await datastore.apply(name, tempId, { set: row });
        try {
          const res: any = await post('/mutate', { op: 'insert', table: name, rows: row, clientOpId });
          const inserted = (res.row ?? (res.rows && res.rows[0])) as Record<string, unknown> & { version: number };
          await datastore.reconcile(name, (inserted as any).id ?? tempId, inserted);
          return inserted;
        } catch (e) {
          await datastore.apply(name, tempId, { unset: Object.keys(row) });
          throw e;
        }
      },
      async update(pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }) {
        const clientOpId = ulid();
        await datastore.apply(name, pk, { set });
        try {
          const res: any = await post('/mutate', { op: 'update', table: name, pk, set, ifVersion: opts?.ifVersion, clientOpId });
          const row = res.row as Record<string, unknown> & { version: number };
          await datastore.reconcile(name, pk, row);
          return row;
        } catch (e) {
          // best-effort rollback: not tracking previous value in MVP
          throw e;
        }
      },
      async delete(pk: PrimaryKey) {
        const clientOpId = ulid();
        await datastore.apply(name, pk, { unset: ['__deleted__'] });
        try {
          await post('/mutate', { op: 'delete', table: name, pk, clientOpId });
          return { ok: true } as const;
        } catch (e) {
          throw e;
        }
      },
      async upsert(rowOrRows: any, options?: { merge?: string[] }) {
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        const clientOpId = ulid();
        for (const r of rows) {
          const pk = (r && (r.id ?? r)) as PrimaryKey;
          await datastore.apply(name, pk, { set: r });
        }
        const res: any = await post('/mutate', { op: 'upsert', table: name, rows, merge: options?.merge, clientOpId });
        const payload = res.rows ?? [res.row];
        for (const r of payload as Array<Record<string, unknown> & { version: number }>) {
          await datastore.reconcile(name, (r as any).id, r);
        }
        return Array.isArray(rowOrRows) ? payload : payload[0];
      },
      watch(pkOrQuery: PrimaryKey | SelectRequest, cb: (arg: any) => void) {
        const state = { status: 'connecting' as 'connecting' | 'live' | 'retrying', error: undefined as any, snapshot: null as any };
        let es: EventSource | null = null;
        let stopped = false;
        const base = baseURL;
        const startSse = () => {
          es = new EventSource(`${base}/events`);
          es.onopen = () => { state.status = 'live'; };
          es.onerror = () => { state.status = 'retrying'; };
          es.onmessage = async (ev) => {
            try {
              const data = JSON.parse(ev.data);
              // naive: on any event for this table, refresh
              const res = await post('/select', typeof pkOrQuery === 'object' && 'table' in (pkOrQuery as any) ? pkOrQuery : { table: name });
              state.snapshot = res;
              cb(res);
            } catch {}
          };
        };
        if (realtime === 'sse') startSse();
        else if (realtime === 'poll') {
          const iv = setInterval(async () => {
            if (stopped) return clearInterval(iv);
            const res = await post('/select', typeof pkOrQuery === 'object' && 'table' in (pkOrQuery as any) ? pkOrQuery : { table: name });
            cb(res);
          }, opts.pollIntervalMs ?? 1500);
        }
        return {
          unsubscribe() {
            stopped = true;
            if (es) es.close();
          },
          get status() { return state.status; },
          get error() { return state.error; },
          getSnapshot() { return state.snapshot; },
        };
      },
    };
  }

  const client: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'mutators') {
        return new Proxy({}, {
          get(_t2, name) {
            return async (args: unknown) => post(`/mutators/${String(name)}`, { args });
          }
        });
      }
      return table(String(prop));
    }
  });
  return client as any;
}

// Minimal in-memory datastore for MVP
export function createMemoryDatastore(): ClientDatastore {
  type Canon = string;
  const store = new Map<string, Map<Canon, any>>();
  function canon(pk: PrimaryKey): Canon {
    if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
    return Object.keys(pk).sort().map((k) => `${k}=${String((pk as any)[k])}`).join('|');
  }
  function ensure(table: string) { if (!store.has(table)) store.set(table, new Map()); return store.get(table)!; }
  return {
    async apply(table, pk, diff) {
      const m = ensure(table);
      const key = canon(pk);
      const current = m.get(key) ?? {};
      if (diff.set) Object.assign(current, diff.set);
      if (diff.unset) for (const f of diff.unset) delete current[f];
      m.set(key, current);
    },
    async reconcile(table, pk, row) {
      const m = ensure(table);
      const key = canon(pk);
      const existing = m.get(key);
      if (!existing || typeof existing.version !== 'number' || row.version >= existing.version) {
        m.set(key, row);
      }
    },
    async readByPk(table, pk) {
      const m = ensure(table);
      return m.get(canon(pk)) ?? null;
    },
    async readWindow(table, req) {
      const m = ensure(table);
      const data = Array.from(m.values());
      return { data, nextCursor: null };
    }
  };
}

