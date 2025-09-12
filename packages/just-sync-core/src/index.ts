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

export type MutatorDef<Args, Result> = {
  args: unknown;
  handler(ctx: { db: DatabaseAdapter; ctx: Record<string, unknown> }, args: Args): Promise<Result>;
};

export type Mutators = Record<string, MutatorDef<any, any>>;

import { SseRingBuffer, sseHeaders } from './sse.js';
import { IdempotencyCache } from './idempotency.js';

export function createSync(opts: {
  schema: unknown;
  database: DatabaseAdapter;
  mutators?: Mutators;
}) {
  const ring = new SseRingBuffer();
  const idem = new IdempotencyCache<any>();

  async function handleEvents(req: Request): Promise<Response> {
    const last = req.headers.get('last-event-id') || undefined;
    const stream = new ReadableStream({
      start(controller) {
        const headersText = `:` + 'keepalive' + `\n\n`;
        controller.enqueue(new TextEncoder().encode(headersText));
        const replay = ring.getSince(last);
        for (const evt of replay) {
          const frame = `id: ${evt.id}\n` + `event: mutation\n` + `data: ${evt.data}\n\n`;
          controller.enqueue(new TextEncoder().encode(frame));
        }
        // No live push loop in MVP minimal impl; emitted via emitEvent helper
      }
    });
    return new Response(stream, { headers: sseHeaders() });
  }

  function emitEvent(event: SseEvent) {
    ring.push(event);
  }

  async function handleSelect(req: Request): Promise<Response> {
    const body = await req.json() as SelectRequest;
    const { table, select, orderBy, limit, cursor } = body;
    const res = await opts.database.selectWindow(table, { select, orderBy, limit, cursor, where: body.where });
    return json(res);
  }

  async function handleMutate(req: Request): Promise<Response> {
    const body = await req.json() as MutationRequest;
    if (body.clientOpId) {
      const prior = idem.get(body.clientOpId);
      if (prior) return json(prior);
    }
    let response: MutationResponse;
    await opts.database.begin();
    try {
      switch (body.op) {
        case 'insert': {
          const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
          const results = [] as Record<string, unknown>[];
          for (const r of rows) {
            results.push(await opts.database.insert(body.table, r));
          }
          response = Array.isArray(body.rows) ? { rows: results } : { row: results[0] };
          break;
        }
        case 'update': {
          const row = await opts.database.updateByPk(body.table, body.pk, body.set, { ifVersion: body.ifVersion });
          response = { row };
          break;
        }
        case 'delete': {
          await opts.database.deleteByPk(body.table, body.pk);
          response = { ok: true };
          break;
        }
        case 'upsert': {
          const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
          const results = [] as Record<string, unknown>[];
          for (const r of rows) {
            const hasId = typeof (r as any).id !== 'undefined';
            if (hasId) {
              try {
                results.push(await opts.database.updateByPk(body.table, (r as any).id, r as any));
              } catch (e: any) {
                if (e?.code === 'NOT_FOUND') results.push(await opts.database.insert(body.table, r));
                else throw e;
              }
            } else {
              results.push(await opts.database.insert(body.table, r));
            }
          }
          response = Array.isArray(body.rows) ? { rows: results } : { row: results[0] };
          break;
        }
        default:
          return error({ code: 'BAD_REQUEST', message: 'Unsupported op' });
      }
      await opts.database.commit();
    } catch (e: any) {
      await opts.database.rollback();
      const code = e?.code || 'INTERNAL';
      return error({ code, message: e?.message || 'Internal error', details: e?.details });
    }
    if ((body as any).clientOpId) idem.set((body as any).clientOpId, response);
    // Emit mutation event (minimal, per spec example)
    emitEvent({ eventId: '', txId: '', tables: [{ name: (body as any).table, type: 'mutation', pks: [], rowVersions: {}, diffs: {} }] });
    return json(response);
  }

  async function handleMutators(_req: Request, _name: string): Promise<Response> {
    return error({ code: 'BAD_REQUEST', message: 'Mutators not implemented in MVP cut' });
  }

  async function router(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.endsWith('/events')) return handleEvents(req);
    if (req.method === 'POST' && url.pathname.endsWith('/select')) return handleSelect(req);
    if (req.method === 'POST' && url.pathname.endsWith('/mutate')) return handleMutate(req);
    if (req.method === 'POST' && url.pathname.includes('/mutators/')) {
      const name = url.pathname.split('/').pop() as string;
      return handleMutators(req, name);
    }
    return new Response('Not Found', { status: 404 });
  }

  function json(obj: unknown, init?: ResponseInit) {
    return new Response(JSON.stringify(obj), { ...(init || {}), headers: { 'Content-Type': 'application/json' } });
  }
  function error(err: { code: string; message: string; details?: unknown }, status = 400) {
    return json(err, { status });
  }

  return {
    handler: router,
    fetch: router,
    nextHandlers() {
      return { GET: router, POST: router } as unknown as { GET: any; POST: any };
    }
  } as const;
}
