import { ulid } from "ulid";

export type PrimaryKey = string | number | Record<string, string | number>;

export type OrderBy = Record<string, "asc" | "desc">;

export type SelectWindow = {
  select?: string[];
  orderBy?: OrderBy;
  limit?: number;
  cursor?: string | null;
};

export type MutationOp =
  | { op: "insert"; table: string; rows: Record<string, unknown> | Record<string, unknown>[] }
  | { op: "update"; table: string; pk: PrimaryKey; set: Record<string, unknown>; ifVersion?: number }
  | { op: "delete"; table: string; pk: PrimaryKey }
  | { op: "upsert"; table: string; rows: Record<string, unknown> | Record<string, unknown>[]; merge?: string[] };

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
    type: "mutation";
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
  args?: unknown; // runtime validator (e.g., zod schema) – not enforced in MVP
  handler(ctx: { db: DatabaseAdapter; ctx: Record<string, unknown> }, args: Args): Promise<Result>;
};

type Mutators = Record<string, MutatorDef<any, any>>;

type CreateSyncOptions = {
  schema: Record<string, unknown>;
  database: DatabaseAdapter;
  mutators?: Mutators;
  eventBufferSec?: number;
};

class EventBuffer {
  private buffer: Array<{ id: string; event: SseEvent; at: number }> = [];
  private subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private keepaliveInterval: NodeJS.Timeout | null = null;
  constructor(private retentionMs: number) {}

  startKeepalive() {
    if (this.keepaliveInterval) return;
    this.keepaliveInterval = setInterval(() => {
      const line = new TextEncoder().encode(`:keepalive\n\n`);
      for (const sub of this.subscribers) sub.enqueue(line);
    }, 15000);
  }

  stopKeepalive() {
    if (this.keepaliveInterval) clearInterval(this.keepaliveInterval);
    this.keepaliveInterval = null;
  }

  emit(event: SseEvent) {
    const id = event.eventId;
    const now = Date.now();
    this.buffer.push({ id, event, at: now });
    // prune
    const cutoff = now - this.retentionMs;
    while (this.buffer.length && this.buffer[0]!.at < cutoff) this.buffer.shift();
    const line = this.format(event);
    for (const sub of this.subscribers) sub.enqueue(line);
  }

  private format(event: SseEvent) {
    const payload = JSON.stringify(event);
    const txt = `id: ${event.eventId}\nevent: mutation\ndata: ${payload}\n\n`;
    return new TextEncoder().encode(txt);
  }

  stream(sinceId?: string) {
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self.subscribers.add(controller);
        // replay
        if (sinceId) {
          let startIdx = self.buffer.findIndex((e) => e.id === sinceId);
          if (startIdx >= 0) {
            for (let i = startIdx + 1; i < self.buffer.length; i++) controller.enqueue(self.format(self.buffer[i]!.event));
          } else {
            // if sinceId not found, do nothing; client should fetch snapshot
          }
        }
      },
      cancel() {
        // no-op; handled in finally of GET /events
      }
    });
    return stream;
  }

  attach(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.subscribers.add(controller);
    return () => this.subscribers.delete(controller);
  }
}

export function createSync(opts: CreateSyncOptions) {
  const { database: db, schema, mutators = {}, eventBufferSec = 60 } = opts;
  const buffer = new EventBuffer(eventBufferSec * 1000);
  buffer.startKeepalive();

  const idempotency = new Map<string, { at: number; response: unknown }>();
  const IDEMPOTENCY_TTL = 10 * 60 * 1000;

  async function handleMutate(req: Request): Promise<Response> {
    const body = (await req.json()) as MutationRequest;
    if (body.clientOpId && idempotency.has(body.clientOpId)) {
      const cached = idempotency.get(body.clientOpId)!;
      return json(cached.response as MutationResponse);
    }
    await db.begin();
    try {
      let res: MutationResponse;
      const txId = ulid();
      if (body.op === "insert") {
        const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
        const inserted: Record<string, unknown>[] = [];
        for (const r of rows) inserted.push(await db.insert(body.table, r));
        res = Array.isArray(body.rows) ? { rows: inserted } : { row: inserted[0]! };
        const pks = inserted.map((r) => (r as any).id);
        emitMutation(body.table, pks, txId);
      } else if (body.op === "update") {
        const updated = await db.updateByPk(body.table, body.pk, body.set, { ifVersion: body.ifVersion });
        res = { row: updated };
        emitMutation(body.table, [body.pk], txId);
      } else if (body.op === "delete") {
        await db.deleteByPk(body.table, body.pk);
        res = { ok: true };
        emitMutation(body.table, [body.pk], txId);
      } else if (body.op === "upsert") {
        const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
        const upserted: Record<string, unknown>[] = [];
        for (const r of rows) {
          const pk = (r as any).id;
          if (pk !== undefined && pk !== null) {
            try {
              const updated = await db.updateByPk(body.table, pk as any, r as any);
              upserted.push(updated);
            } catch {
              upserted.push(await db.insert(body.table, r));
            }
          } else {
            upserted.push(await db.insert(body.table, r));
          }
        }
        res = Array.isArray(body.rows) ? { rows: upserted } : { row: upserted[0]! };
        const pks = upserted.map((r) => (r as any).id);
        emitMutation(body.table, pks, txId);
      } else {
        return jsonError("BAD_REQUEST", "Unsupported op");
      }
      await db.commit();
      if (body.clientOpId) {
        idempotency.set(body.clientOpId, { at: Date.now(), response: res });
        // prune old
        const cutoff = Date.now() - IDEMPOTENCY_TTL;
        for (const [k, v] of idempotency) if (v.at < cutoff) idempotency.delete(k);
      }
      return json(res);
    } catch (e) {
      await db.rollback();
      return jsonError("INTERNAL", e instanceof Error ? e.message : "Unknown error");
    }
  }

  function emitMutation(table: string, pks: PrimaryKey[], txId: string) {
    const event: SseEvent = {
      eventId: ulid(),
      txId,
      tables: [
        {
          name: table,
          type: "mutation",
          pks
        }
      ]
    };
    buffer.emit(event);
  }

  async function handleSelect(req: Request): Promise<Response> {
    const body = (await req.json()) as SelectRequest;
    const { table, select, orderBy, limit, cursor, where } = body;
    const data = await db.selectWindow(table, { select, orderBy, limit, cursor, where });
    return json(data);
  }

  async function handleSelectByPk(req: Request): Promise<Response> {
    const body = (await req.json()) as { table: string; pk: PrimaryKey; select?: string[] };
    const row = await db.selectByPk(body.table, body.pk, body.select);
    return json({ row });
  }

  async function handleMutator(req: Request, name: string, ctx: Record<string, unknown>): Promise<Response> {
    const m = mutators[name];
    if (!m) return jsonError("NOT_FOUND", `Mutator ${name} not found`);
    const body = (await req.json()) as { args: unknown; clientOpId?: string };
    await db.begin();
    // Collect writes during mutator execution to emit a single SSE tx
    const writes = new Map<string, PrimaryKey[]>();
    const collect = (table: string, pk: PrimaryKey) => {
      const list = writes.get(table) ?? [];
      list.push(pk);
      writes.set(table, list);
    };
    const txDb: DatabaseAdapter = {
      begin: () => db.begin(),
      commit: () => db.commit(),
      rollback: () => db.rollback(),
      async insert(table, row) {
        const res = await db.insert(table, row);
        collect(table, (res as any).id);
        return res;
      },
      async updateByPk(table, pk, set, opts) {
        const res = await db.updateByPk(table, pk, set, opts);
        collect(table, pk);
        return res;
      },
      async deleteByPk(table, pk) {
        const res = await db.deleteByPk(table, pk);
        collect(table, pk);
        return res;
      },
      selectByPk: (table, pk, select) => db.selectByPk(table, pk, select),
      selectWindow: (table, req) => db.selectWindow(table, req)
    };
    try {
      // Skipping runtime validation for MVP; users can pass zod schema in args
      const result = await m.handler({ db: txDb, ctx }, body.args as any);
      await db.commit();
      if (writes.size > 0) {
        const txId = ulid();
        for (const [table, pks] of writes) emitMutation(table, pks, txId);
      }
      return json({ result });
    } catch (e) {
      await db.rollback();
      return jsonError("INTERNAL", e instanceof Error ? e.message : "Mutator failed");
    }
  }

  function toPath(req: Request) {
    const u = new URL(req.url);
    return u.pathname.replace(/\/*$/, "");
  }

  async function fetch(req: Request, ctx: Record<string, unknown> = {}): Promise<Response> {
    const path = toPath(req);
    if (req.method === "GET" && /\/events$/.test(path)) {
      const url = new URL(req.url);
      const since = req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? undefined;
      const stream = buffer.stream(since);
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    }
    if (req.method === "POST" && /\/mutate$/.test(path)) return handleMutate(req);
    if (req.method === "POST" && /\/select$/.test(path)) return handleSelect(req);
    if (req.method === "POST" && /\/selectByPk$/.test(path)) return handleSelectByPk(req);
    const m = path.match(/\/mutators\/(.+)$/);
    if (req.method === "POST" && m) return handleMutator(req, decodeURIComponent(m[1]!), ctx);
    return jsonError("NOT_FOUND", "Route not found");
  }

  function defineMutators<M extends Mutators>(defs: M): M {
    Object.assign(mutators, defs);
    return defs;
  }

  return {
    schema,
    db,
    fetch,
    handler: (req: Request) => fetch(req),
    nextHandlers: () => ({
      GET: (req: Request) => fetch(req),
      POST: (req: Request) => fetch(req)
    }),
    defineMutators
  } as const;
}

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init
  });
}

function jsonError(code: string, message: string, details?: unknown, init?: ResponseInit) {
  return json({ code, message, details }, { status: code === "NOT_FOUND" ? 404 : code === "BAD_REQUEST" ? 400 : 500, ...init });
}

