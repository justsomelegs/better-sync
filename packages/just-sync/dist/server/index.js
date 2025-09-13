import { ulid } from "ulid";
class EventBuffer {
    constructor(retentionMs) {
        this.retentionMs = retentionMs;
        this.buffer = [];
        this.subscribers = new Set();
        this.keepaliveInterval = null;
    }
    startKeepalive() {
        if (this.keepaliveInterval)
            return;
        this.keepaliveInterval = setInterval(() => {
            const line = new TextEncoder().encode(`:keepalive\n\n`);
            for (const sub of this.subscribers)
                sub.enqueue(line);
        }, 15000);
    }
    stopKeepalive() {
        if (this.keepaliveInterval)
            clearInterval(this.keepaliveInterval);
        this.keepaliveInterval = null;
    }
    emit(event) {
        const id = event.eventId;
        const now = Date.now();
        this.buffer.push({ id, event, at: now });
        // prune
        const cutoff = now - this.retentionMs;
        while (this.buffer.length && this.buffer[0].at < cutoff)
            this.buffer.shift();
        const line = this.format(event);
        for (const sub of this.subscribers)
            sub.enqueue(line);
    }
    format(event) {
        const payload = JSON.stringify(event);
        const txt = `id: ${event.eventId}\nevent: mutation\ndata: ${payload}\n\n`;
        return new TextEncoder().encode(txt);
    }
    stream(sinceId) {
        const self = this;
        const stream = new ReadableStream({
            start(controller) {
                self.subscribers.add(controller);
                // replay
                if (sinceId) {
                    let startIdx = self.buffer.findIndex((e) => e.id === sinceId);
                    if (startIdx >= 0) {
                        for (let i = startIdx + 1; i < self.buffer.length; i++)
                            controller.enqueue(self.format(self.buffer[i].event));
                    }
                    else {
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
    attach(controller) {
        this.subscribers.add(controller);
        return () => this.subscribers.delete(controller);
    }
}
export function createSync(opts) {
    const { database: db, schema, mutators = {}, eventBufferSec = 60 } = opts;
    const buffer = new EventBuffer(eventBufferSec * 1000);
    buffer.startKeepalive();
    const idempotency = new Map();
    const IDEMPOTENCY_TTL = 10 * 60 * 1000;
    async function handleMutate(req) {
        const body = (await req.json());
        if (body.clientOpId && idempotency.has(body.clientOpId)) {
            const cached = idempotency.get(body.clientOpId);
            return json(cached.response);
        }
        await db.begin();
        try {
            let res;
            const txId = ulid();
            if (body.op === "insert") {
                const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
                const inserted = [];
                for (const r of rows)
                    inserted.push(await db.insert(body.table, r));
                res = Array.isArray(body.rows) ? { rows: inserted } : { row: inserted[0] };
                const pks = inserted.map((r) => r.id);
                emitMutation(body.table, pks, txId);
            }
            else if (body.op === "update") {
                const updated = await db.updateByPk(body.table, body.pk, body.set, { ifVersion: body.ifVersion });
                res = { row: updated };
                emitMutation(body.table, [body.pk], txId);
            }
            else if (body.op === "delete") {
                await db.deleteByPk(body.table, body.pk);
                res = { ok: true };
                emitMutation(body.table, [body.pk], txId);
            }
            else if (body.op === "upsert") {
                const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
                const upserted = [];
                for (const r of rows) {
                    const pk = r.id;
                    if (pk !== undefined && pk !== null) {
                        try {
                            const updated = await db.updateByPk(body.table, pk, r);
                            upserted.push(updated);
                        }
                        catch {
                            upserted.push(await db.insert(body.table, r));
                        }
                    }
                    else {
                        upserted.push(await db.insert(body.table, r));
                    }
                }
                res = Array.isArray(body.rows) ? { rows: upserted } : { row: upserted[0] };
                const pks = upserted.map((r) => r.id);
                emitMutation(body.table, pks, txId);
            }
            else {
                return jsonError("BAD_REQUEST", "Unsupported op");
            }
            await db.commit();
            if (body.clientOpId) {
                idempotency.set(body.clientOpId, { at: Date.now(), response: res });
                // prune old
                const cutoff = Date.now() - IDEMPOTENCY_TTL;
                for (const [k, v] of idempotency)
                    if (v.at < cutoff)
                        idempotency.delete(k);
            }
            return json(res);
        }
        catch (e) {
            await db.rollback();
            return jsonError("INTERNAL", e instanceof Error ? e.message : "Unknown error");
        }
    }
    function emitMutation(table, pks, txId) {
        const event = {
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
    async function handleSelect(req) {
        const body = (await req.json());
        const { table, select, orderBy, limit, cursor, where } = body;
        const data = await db.selectWindow(table, { select, orderBy, limit, cursor, where });
        return json(data);
    }
    async function handleSelectByPk(req) {
        const body = (await req.json());
        const row = await db.selectByPk(body.table, body.pk, body.select);
        return json({ row });
    }
    async function handleMutator(req, name, ctx) {
        const m = mutators[name];
        if (!m)
            return jsonError("NOT_FOUND", `Mutator ${name} not found`);
        const body = (await req.json());
        await db.begin();
        // Collect writes during mutator execution to emit a single SSE tx
        const writes = new Map();
        const collect = (table, pk) => {
            const list = writes.get(table) ?? [];
            list.push(pk);
            writes.set(table, list);
        };
        const txDb = {
            begin: () => db.begin(),
            commit: () => db.commit(),
            rollback: () => db.rollback(),
            async insert(table, row) {
                const res = await db.insert(table, row);
                collect(table, res.id);
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
            const result = await m.handler({ db: txDb, ctx }, body.args);
            await db.commit();
            if (writes.size > 0) {
                const txId = ulid();
                for (const [table, pks] of writes)
                    emitMutation(table, pks, txId);
            }
            return json({ result });
        }
        catch (e) {
            await db.rollback();
            return jsonError("INTERNAL", e instanceof Error ? e.message : "Mutator failed");
        }
    }
    function toPath(req) {
        const u = new URL(req.url);
        return u.pathname.replace(/\/*$/, "");
    }
    async function fetch(req, ctx = {}) {
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
        if (req.method === "POST" && /\/mutate$/.test(path))
            return handleMutate(req);
        if (req.method === "POST" && /\/select$/.test(path))
            return handleSelect(req);
        if (req.method === "POST" && /\/selectByPk$/.test(path))
            return handleSelectByPk(req);
        const m = path.match(/\/mutators\/(.+)$/);
        if (req.method === "POST" && m)
            return handleMutator(req, decodeURIComponent(m[1]), ctx);
        return jsonError("NOT_FOUND", "Route not found");
    }
    function defineMutators(defs) {
        Object.assign(mutators, defs);
        return defs;
    }
    return {
        schema,
        db,
        fetch,
        handler: (req) => fetch(req),
        nextHandlers: () => ({
            GET: (req) => fetch(req),
            POST: (req) => fetch(req)
        }),
        defineMutators
    };
}
function json(body, init) {
    return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
        ...init
    });
}
function jsonError(code, message, details, init) {
    return json({ code, message, details }, { status: code === "NOT_FOUND" ? 404 : code === "BAD_REQUEST" ? 400 : 500, ...init });
}
//# sourceMappingURL=index.js.map