import { ulid } from 'ulidx';
import { z } from 'zod';

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

type MutatorDef<Args, Result> = {
  args: unknown;
  handler: (ctx: { db: DatabaseAdapter; ctx: Record<string, unknown> }, args: Args) => Promise<Result>;
};
type Mutators = Record<string, MutatorDef<any, any>>;

type SchemaTable = {
  table?: string;
  primaryKey?: string[];
  updatedAt?: string;
  merge?: string[];
  schema?: unknown;
};
export type Schema = Record<string, SchemaTable | unknown>;

export type CreateSyncOptions = {
  schema: Schema;
  database: DatabaseAdapter;
  mutators?: Mutators;
  sseBufferSeconds?: number;
  sseBufferMax?: number;
};

type RouteHandler = (req: Request) => Promise<Response>;

class SseBuffer {
  private events: Array<{ id: string; data: string; time: number }> = [];
  constructor(private maxSeconds: number, private maxEvents: number) {}
  push(id: string, data: unknown) {
    const now = Date.now();
    this.events.push({ id, data: JSON.stringify(data), time: now });
    this.gc();
  }
  private gc() {
    const threshold = Date.now() - this.maxSeconds * 1000;
    while (this.events.length && (this.events.length > this.maxEvents || this.events[0].time < threshold)) {
      this.events.shift();
    }
  }
  readSince(sinceId?: string | null) {
    if (!sinceId) return this.events.slice();
    const idx = this.events.findIndex(e => e.id === sinceId);
    if (idx === -1) return this.events.slice();
    return this.events.slice(idx + 1);
  }
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

function error(code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL', message: string, details?: unknown, init?: ResponseInit) {
  return json({ code, message, details }, { status: code === 'BAD_REQUEST' ? 400 : code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : 500, ...init });
}

function isZodType(value: unknown): value is z.ZodTypeAny {
  return !!value && typeof value === 'object' && value instanceof z.ZodType;
}

function normalizeTableConfig(tableName: string, def: SchemaTable | unknown) {
  const config: Required<SchemaTable> = {
    table: tableName,
    primaryKey: ['id'],
    updatedAt: 'updatedAt',
    merge: [],
    schema: undefined
  } as Required<SchemaTable>;
  if (def && typeof def === 'object' && 'schema' in (def as any)) {
    const t = def as SchemaTable;
    return { ...config, ...t, table: t.table ?? tableName };
  }
  if (isZodType(def)) {
    return { ...config, schema: def };
  }
  return config;
}

function canonicalizePk(pk: PrimaryKey): string {
  if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
  const parts = Object.keys(pk).sort().map(k => `${k}=${String((pk as any)[k])}`);
  return parts.join('|');
}

export function createSync(opts: CreateSyncOptions) {
  const { database, sseBufferMax = 10000, sseBufferSeconds = 60 } = opts;
  const tablesConfig: Record<string, ReturnType<typeof normalizeTableConfig>> = {};
  for (const [name, def] of Object.entries(opts.schema)) {
    tablesConfig[name] = normalizeTableConfig(name, def as any);
  }

  const sseBuffer = new SseBuffer(sseBufferSeconds, sseBufferMax);
  const sseClients = new Set<{ send: (id: string, event: string | undefined, data: string) => void; close: () => void }>();
  const idempotency = new Map<string, { response: any; time: number; payloadHash: string }>();
  const IDEMP_TTL_MS = 10 * 60 * 1000;
  function gcIdempotency(now: number) {
    for (const [key, val] of idempotency) {
      if (now - val.time > IDEMP_TTL_MS) idempotency.delete(key);
    }
  }
  function hashPayload(obj: unknown): string {
    try { return JSON.stringify(obj); } catch { return String(obj); }
  }

  async function withTx<T>(fn: () => Promise<T>): Promise<T> {
    await database.begin();
    try {
      const res = await fn();
      await database.commit();
      return res;
    } catch (e) {
      try { await database.rollback(); } catch {}
      throw e;
    }
  }

  function emitMutation(tables: Array<{ name: string; pks: PrimaryKey[]; rowVersions?: Record<string, number>; diffs?: Record<string, { set?: Record<string, unknown>; unset?: string[] }> }>) {
    const eventId = ulid();
    const txId = ulid();
    const event: SseEvent = { eventId, txId, tables: tables.map(t => ({ name: t.name, type: 'mutation', pks: t.pks, rowVersions: t.rowVersions, diffs: t.diffs })) };
    sseBuffer.push(eventId, event);
    const data = JSON.stringify(event);
    for (const client of sseClients) {
      try { client.send(eventId, 'mutation', data); } catch { /* ignore */ }
    }
  }

  async function handleMutate(request: Request): Promise<Response> {
    let body: MutationRequest;
    try {
      body = await request.json();
    } catch {
      return error('BAD_REQUEST', 'Invalid JSON');
    }
    const { clientOpId } = body as any;
    const now = Date.now();
    gcIdempotency(now);
    const currentHash = clientOpId ? hashPayload(body) : '';
    if (clientOpId && idempotency.has(clientOpId)) {
      const cached = idempotency.get(clientOpId)!;
      if (cached.payloadHash !== currentHash) {
        return json({ ...cached.response, details: { duplicated: true } });
      }
      return json(cached.response);
    }
    try {
      const result = await withTx(async () => {
        switch (body.op) {
          case 'insert': {
            const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
            const inserted: Record<string, unknown>[] = [];
            const table = body.table;
            // runtime validate if schema provided
            const config = tablesConfig[table];
            const validator = config?.schema as any;
            for (const r of rows) {
              if (validator && typeof validator.parse === 'function') {
                try { validator.parse({ ...(r as any), id: (r as any).id ?? ulid(), updatedAt: Date.now() }); } catch (e: any) { throw new Error('BAD_REQUEST: ' + (e?.message ?? 'validation failed')); }
              }
              const row = await database.insert(table, r);
              inserted.push(row);
            }
            const pks = inserted.map(r => (r as any).id);
            emitMutation([{ name: table, pks }]);
            return Array.isArray(body.rows) ? { rows: inserted } : { row: inserted[0] };
          }
          case 'update': {
            const updated = await database.updateByPk(body.table, body.pk, body.set, { ifVersion: body.ifVersion });
            emitMutation([{ name: body.table, pks: [body.pk] }]);
            return { row: updated };
          }
          case 'delete': {
            await database.deleteByPk(body.table, body.pk);
            emitMutation([{ name: body.table, pks: [body.pk] }]);
            return { ok: true } as const;
          }
          case 'upsert': {
            const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
            const upserted: Record<string, unknown>[] = [];
            const table = body.table;
            const config = tablesConfig[table];
            const validator = config?.schema as any;
            for (const r of rows) {
              const hasPk = 'id' in r && (r as any).id != null;
              if (hasPk) {
                try {
                  const row = await database.updateByPk(table, (r as any).id, r as any);
                  upserted.push(row);
                } catch {
                  if (validator && typeof validator.parse === 'function') {
                    try { validator.parse({ ...(r as any), updatedAt: Date.now() }); } catch (e: any) { throw new Error('BAD_REQUEST: ' + (e?.message ?? 'validation failed')); }
                  }
                  const row = await database.insert(table, r);
                  upserted.push(row);
                }
              } else {
                if (validator && typeof validator.parse === 'function') {
                  try { validator.parse({ ...(r as any), id: ulid(), updatedAt: Date.now() }); } catch (e: any) { throw new Error('BAD_REQUEST: ' + (e?.message ?? 'validation failed')); }
                }
                const row = await database.insert(table, r);
                upserted.push(row);
              }
            }
            const pks = upserted.map(r => (r as any).id);
            emitMutation([{ name: table, pks }]);
            return Array.isArray(body.rows) ? { rows: upserted } : { row: upserted[0] };
          }
          case 'updateWhere':
          case 'deleteWhere': {
            return error('BAD_REQUEST', 'where-based operations must be resolved client-side in MVP');
          }
          default:
            return error('BAD_REQUEST', 'Unknown op');
        }
      });
      if (clientOpId) {
        idempotency.set(clientOpId, { response: result, time: now, payloadHash: currentHash });
      }
      return json(result);
    } catch (e: any) {
      const msg = e?.message ?? 'Internal error';
      if (msg.startsWith('BAD_REQUEST:')) return error('BAD_REQUEST', msg.slice('BAD_REQUEST:'.length).trim());
      if (msg.includes('version mismatch')) return error('CONFLICT', msg);
      if (msg.startsWith('NOT_FOUND:')) return error('NOT_FOUND', msg.slice('NOT_FOUND:'.length).trim());
      if (msg.startsWith('CONFLICT:')) return error('CONFLICT', msg.slice('CONFLICT:'.length).trim());
      return error('INTERNAL', msg);
    }
  }

  async function handleSelect(request: Request): Promise<Response> {
    let body: SelectRequest;
    try { body = await request.json(); } catch { return error('BAD_REQUEST', 'Invalid JSON'); }
    const table = (body as any).table as string;
    if ((body as any).pk !== undefined) {
      const row = await database.selectByPk(table, (body as any).pk, body.select);
      return json({ row });
    }
    const res = await database.selectWindow(table, {
      select: body.select,
      orderBy: body.orderBy,
      limit: body.limit,
      cursor: body.cursor,
      where: body.where
    });
    return json(res);
  }

  async function handleEvents(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const since = request.headers.get('Last-Event-ID') || url.searchParams.get('since');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (id: string, event: string | undefined, data: string) => {
          let frame = '';
          frame += `id: ${id}\n`;
          if (event) frame += `event: ${event}\n`;
          frame += `data: ${data}\n\n`;
          controller.enqueue(enc.encode(frame));
        };
        // replay first
        for (const e of sseBuffer.readSince(since)) {
          send(e.id, 'mutation', e.data);
        }
        const hb = setInterval(() => controller.enqueue(enc.encode(`:keepalive\n\n`)), 15000);
        const client = { send, close: () => { try { clearInterval(hb); } catch {} } };
        sseClients.add(client);
        (controller as any)._client = client;
      },
      cancel() {
        const client = (this as any)._client;
        if (client) {
          try { client.close(); } catch {}
          sseClients.delete(client);
        }
      }
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      }
    });
  }

  function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.endsWith('/events')) return handleEvents(req);
    if (req.method === 'POST' && url.pathname.endsWith('/mutate')) return handleMutate(req);
    if (req.method === 'POST' && url.pathname.endsWith('/select')) return handleSelect(req);
    if (req.method === 'POST' && url.pathname.includes('/mutators/')) return handleMutator(req);
    return Promise.resolve(error('NOT_FOUND', 'Route not found'));
  }

  const mutators: Mutators = { ...(opts.mutators ?? {}) };
  function defineMutators<T extends Mutators>(defs: T): T {
    Object.assign(mutators, defs);
    return defs;
  }
  async function handleMutator(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = url.pathname.split('/').pop()!;
    const def = mutators[name];
    if (!def) return error('NOT_FOUND', 'Mutator not found');
    let body: { args: unknown; clientOpId?: string };
    try { body = await request.json(); } catch { return error('BAD_REQUEST', 'Invalid JSON'); }
    try {
      const validator: any = (def as any).args;
      let args = body.args as any;
      if (validator && typeof validator.parse === 'function') {
        try { args = validator.parse(body.args); } catch (e: any) { return error('BAD_REQUEST', e?.message ?? 'Validation failed'); }
      }
      const result = await withTx(async () => def.handler({ db: database, ctx: {} }, args));
      return json({ result });
    } catch (e: any) {
      return error('INTERNAL', e?.message ?? 'Internal error');
    }
  }

  return {
    handler: route as RouteHandler,
    fetch: route as RouteHandler,
    nextHandlers() {
      return { GET: route as RouteHandler, POST: route as RouteHandler };
    },
    defineMutators
  };
}

export { z };
