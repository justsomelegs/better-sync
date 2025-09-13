import { ulid } from 'ulidx';
import { z } from 'zod';
class SseBuffer {
    constructor(maxSeconds, maxEvents) {
        this.maxSeconds = maxSeconds;
        this.maxEvents = maxEvents;
        this.events = [];
    }
    push(id, data) {
        const now = Date.now();
        this.events.push({ id, data: JSON.stringify(data), time: now });
        this.gc();
    }
    gc() {
        const threshold = Date.now() - this.maxSeconds * 1000;
        while (this.events.length && (this.events.length > this.maxEvents || this.events[0].time < threshold)) {
            this.events.shift();
        }
    }
    readSince(sinceId) {
        if (!sinceId)
            return this.events.slice();
        const idx = this.events.findIndex(e => e.id === sinceId);
        if (idx === -1)
            return this.events.slice();
        return this.events.slice(idx + 1);
    }
}
function json(data, init) {
    return new Response(JSON.stringify(data), {
        headers: { 'content-type': 'application/json' },
        ...init
    });
}
function error(code, message, details, init) {
    return json({ code, message, details }, { status: code === 'BAD_REQUEST' ? 400 : code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : 500, ...init });
}
function isZodType(value) {
    return !!value && typeof value === 'object' && value instanceof z.ZodType;
}
function normalizeTableConfig(tableName, def) {
    const config = {
        table: tableName,
        primaryKey: ['id'],
        updatedAt: 'updatedAt',
        merge: [],
        schema: undefined
    };
    if (def && typeof def === 'object' && 'schema' in def) {
        const t = def;
        return { ...config, ...t, table: t.table ?? tableName };
    }
    if (isZodType(def)) {
        return { ...config, schema: def };
    }
    return config;
}
function canonicalizePk(pk) {
    if (typeof pk === 'string' || typeof pk === 'number')
        return String(pk);
    const parts = Object.keys(pk).sort().map(k => `${k}=${String(pk[k])}`);
    return parts.join('|');
}
export function createSync(opts) {
    const { database, sseBufferMax = 10000, sseBufferSeconds = 60 } = opts;
    const tablesConfig = {};
    for (const [name, def] of Object.entries(opts.schema)) {
        tablesConfig[name] = normalizeTableConfig(name, def);
    }
    const sseBuffer = new SseBuffer(sseBufferSeconds, sseBufferMax);
    const sseClients = new Set();
    const idempotency = new Map();
    const IDEMP_TTL_MS = 10 * 60 * 1000;
    function gcIdempotency(now) {
        for (const [key, val] of idempotency) {
            if (now - val.time > IDEMP_TTL_MS)
                idempotency.delete(key);
        }
    }
    function hashPayload(obj) {
        try {
            return JSON.stringify(obj);
        }
        catch {
            return String(obj);
        }
    }
    async function withTx(fn) {
        await database.begin();
        try {
            const res = await fn();
            await database.commit();
            return res;
        }
        catch (e) {
            try {
                await database.rollback();
            }
            catch { }
            throw e;
        }
    }
    function emitMutation(tables) {
        const eventId = ulid();
        const txId = ulid();
        const event = { eventId, txId, tables: tables.map(t => ({ name: t.name, type: 'mutation', pks: t.pks, rowVersions: t.rowVersions, diffs: t.diffs })) };
        sseBuffer.push(eventId, event);
        const data = JSON.stringify(event);
        for (const client of sseClients) {
            try {
                client.send(eventId, 'mutation', data);
            }
            catch { /* ignore */ }
        }
    }
    async function handleMutate(request) {
        let body;
        try {
            body = await request.json();
        }
        catch {
            return error('BAD_REQUEST', 'Invalid JSON');
        }
        const { clientOpId } = body;
        const now = Date.now();
        gcIdempotency(now);
        const currentHash = clientOpId ? hashPayload(body) : '';
        if (clientOpId && idempotency.has(clientOpId)) {
            const cached = idempotency.get(clientOpId);
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
                        const inserted = [];
                        const table = body.table;
                        // runtime validate if schema provided
                        const config = tablesConfig[table];
                        const validator = config?.schema;
                        for (const r of rows) {
                            if (validator && typeof validator.parse === 'function') {
                                try {
                                    validator.parse({ ...r, id: r.id ?? ulid(), updatedAt: Date.now() });
                                }
                                catch (e) {
                                    throw new Error('BAD_REQUEST: ' + (e?.message ?? 'validation failed'));
                                }
                            }
                            const row = await database.insert(table, r);
                            inserted.push(row);
                        }
                        const pks = inserted.map(r => r.id);
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
                        return { ok: true };
                    }
                    case 'upsert': {
                        const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
                        const upserted = [];
                        const table = body.table;
                        const config = tablesConfig[table];
                        const validator = config?.schema;
                        for (const r of rows) {
                            const hasPk = 'id' in r && r.id != null;
                            if (hasPk) {
                                try {
                                    const row = await database.updateByPk(table, r.id, r);
                                    upserted.push(row);
                                }
                                catch {
                                    if (validator && typeof validator.parse === 'function') {
                                        try {
                                            validator.parse({ ...r, updatedAt: Date.now() });
                                        }
                                        catch (e) {
                                            throw new Error('BAD_REQUEST: ' + (e?.message ?? 'validation failed'));
                                        }
                                    }
                                    const row = await database.insert(table, r);
                                    upserted.push(row);
                                }
                            }
                            else {
                                if (validator && typeof validator.parse === 'function') {
                                    try {
                                        validator.parse({ ...r, id: ulid(), updatedAt: Date.now() });
                                    }
                                    catch (e) {
                                        throw new Error('BAD_REQUEST: ' + (e?.message ?? 'validation failed'));
                                    }
                                }
                                const row = await database.insert(table, r);
                                upserted.push(row);
                            }
                        }
                        const pks = upserted.map(r => r.id);
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
        }
        catch (e) {
            const msg = e?.message ?? 'Internal error';
            if (msg.startsWith('BAD_REQUEST:'))
                return error('BAD_REQUEST', msg.slice('BAD_REQUEST:'.length).trim());
            if (msg.includes('version mismatch'))
                return error('CONFLICT', msg);
            if (msg.startsWith('NOT_FOUND:'))
                return error('NOT_FOUND', msg.slice('NOT_FOUND:'.length).trim());
            if (msg.startsWith('CONFLICT:'))
                return error('CONFLICT', msg.slice('CONFLICT:'.length).trim());
            return error('INTERNAL', msg);
        }
    }
    async function handleSelect(request) {
        let body;
        try {
            body = await request.json();
        }
        catch {
            return error('BAD_REQUEST', 'Invalid JSON');
        }
        const table = body.table;
        if (body.pk !== undefined) {
            const row = await database.selectByPk(table, body.pk, body.select);
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
    async function handleEvents(request) {
        const url = new URL(request.url);
        const since = request.headers.get('Last-Event-ID') || url.searchParams.get('since');
        const stream = new ReadableStream({
            start(controller) {
                const enc = new TextEncoder();
                const send = (id, event, data) => {
                    let frame = '';
                    frame += `id: ${id}\n`;
                    if (event)
                        frame += `event: ${event}\n`;
                    frame += `data: ${data}\n\n`;
                    controller.enqueue(enc.encode(frame));
                };
                // replay first
                for (const e of sseBuffer.readSince(since)) {
                    send(e.id, 'mutation', e.data);
                }
                const hb = setInterval(() => controller.enqueue(enc.encode(`:keepalive\n\n`)), 15000);
                const client = { send, close: () => { try {
                        clearInterval(hb);
                    }
                    catch { } } };
                sseClients.add(client);
                controller._client = client;
            },
            cancel() {
                const client = this._client;
                if (client) {
                    try {
                        client.close();
                    }
                    catch { }
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
    function route(req) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname.endsWith('/events'))
            return handleEvents(req);
        if (req.method === 'POST' && url.pathname.endsWith('/mutate'))
            return handleMutate(req);
        if (req.method === 'POST' && url.pathname.endsWith('/select'))
            return handleSelect(req);
        if (req.method === 'POST' && url.pathname.includes('/mutators/'))
            return handleMutator(req);
        return Promise.resolve(error('NOT_FOUND', 'Route not found'));
    }
    const mutators = { ...(opts.mutators ?? {}) };
    function defineMutators(defs) {
        Object.assign(mutators, defs);
        return defs;
    }
    async function handleMutator(request) {
        const url = new URL(request.url);
        const name = url.pathname.split('/').pop();
        const def = mutators[name];
        if (!def)
            return error('NOT_FOUND', 'Mutator not found');
        let body;
        try {
            body = await request.json();
        }
        catch {
            return error('BAD_REQUEST', 'Invalid JSON');
        }
        try {
            const validator = def.args;
            let args = body.args;
            if (validator && typeof validator.parse === 'function') {
                try {
                    args = validator.parse(body.args);
                }
                catch (e) {
                    return error('BAD_REQUEST', e?.message ?? 'Validation failed');
                }
            }
            const result = await withTx(async () => def.handler({ db: database, ctx: {} }, args));
            return json({ result });
        }
        catch (e) {
            return error('INTERNAL', e?.message ?? 'Internal error');
        }
    }
    return {
        handler: route,
        fetch: route,
        nextHandlers() {
            return { GET: route, POST: route };
        },
        defineMutators
    };
}
export { z };
