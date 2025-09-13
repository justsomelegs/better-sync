import { ulid } from 'ulidx';
class MemoryDatastore {
    constructor() {
        this.tables = new Map();
    }
    getTable(name) {
        let t = this.tables.get(name);
        if (!t) {
            t = new Map();
            this.tables.set(name, t);
        }
        return t;
    }
    key(pk) { return typeof pk === 'string' || typeof pk === 'number' ? String(pk) : Object.keys(pk).sort().map(k => `${k}=${String(pk[k])}`).join('|'); }
    async apply(table, pk, diff) {
        const t = this.getTable(table);
        const k = this.key(pk);
        const cur = t.get(k) ?? {};
        const next = { ...cur, ...(diff.set ?? {}) };
        for (const u of diff.unset ?? [])
            delete next[u];
        t.set(k, next);
    }
    async reconcile(table, pk, row) {
        const t = this.getTable(table);
        const k = this.key(pk);
        const cur = t.get(k);
        if (!cur || (cur.version ?? 0) <= row.version) {
            t.set(k, row);
        }
    }
    async readByPk(table, pk, select) {
        const t = this.getTable(table);
        const k = this.key(pk);
        const row = t.get(k) ?? null;
        if (!row)
            return null;
        if (!select || !select.length)
            return row;
        const out = {};
        for (const f of select)
            out[f] = row[f];
        return out;
    }
    async readWindow(table, req) {
        const t = this.getTable(table);
        const rows = Array.from(t.values());
        const order = req.orderBy ?? { updatedAt: 'desc' };
        rows.sort((a, b) => {
            const dir = order.updatedAt === 'asc' ? 1 : -1;
            if ((a.updatedAt ?? 0) === (b.updatedAt ?? 0))
                return (a.id ?? '').localeCompare(b.id ?? '') * dir;
            return ((a.updatedAt ?? 0) - (b.updatedAt ?? 0)) * dir;
        });
        const limit = Math.min(1000, Math.max(1, req.limit ?? 100));
        const slice = rows.slice(0, limit);
        const selected = (req.select && req.select.length) ? slice.map(r => {
            const o = {};
            for (const f of req.select)
                o[f] = r[f];
            return o;
        }) : slice;
        return { data: selected, nextCursor: null };
    }
}
export function memory() { return new MemoryDatastore(); }
export function createClient(options) {
    const baseURL = options.baseURL.replace(/\/$/, '');
    const datastore = options.datastore ?? memory();
    const realtime = options.realtime ?? 'sse';
    const pollIntervalMs = options.pollIntervalMs ?? 1500;
    let sse = null;
    const subscriptions = new Map();
    let subSeq = 1;
    async function post(path, payload) {
        const res = await fetch(baseURL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
    function applyWhere(rows, where) {
        if (!where)
            return rows;
        return rows.filter(r => {
            try {
                return !!where(r);
            }
            catch {
                return false;
            }
        });
    }
    async function selectAllPages(table, req) {
        let cursor = req.cursor ?? null;
        const all = [];
        for (;;) {
            const res = await post('/select', { table, select: req.select, orderBy: req.orderBy, limit: req.limit, cursor });
            const page = res.data ?? [];
            all.push(...page);
            cursor = res.nextCursor ?? null;
            if (!cursor)
                break;
        }
        return { data: all, nextCursor: null };
    }
    function startSseIfNeeded() {
        if (realtime !== 'sse' || sse)
            return;
        try {
            sse = new EventSource(baseURL + '/events');
            sse.addEventListener('mutation', async (ev) => {
                try {
                    const payload = JSON.parse(String(ev.data));
                    const tables = payload.tables;
                    for (const [id, sub] of subscriptions) {
                        for (const t of tables) {
                            if (t.name === sub.table) {
                                if (sub.kind === 'row') {
                                    const rowRes = await post('/select', { table: sub.table, pk: sub.pk });
                                    sub.cb({ item: rowRes.row ?? null });
                                }
                                else {
                                    const win = sub.query;
                                    const res = await post('/select', { table: sub.table, select: win.select, orderBy: win.orderBy, limit: win.limit, cursor: win.cursor });
                                    const data = applyWhere((res.data ?? []), win.where);
                                    sub.cb({ data, cursor: res.nextCursor ?? null });
                                }
                                break;
                            }
                        }
                    }
                }
                catch { }
            });
            sse.onerror = () => {
                try {
                    sse?.close();
                }
                catch { }
                sse = null;
                setTimeout(startSseIfNeeded, 1000);
            };
        }
        catch {
            if (realtime === 'sse' || realtime === 'poll')
                startPolling();
        }
    }
    let pollTimer = null;
    function startPolling() {
        if (realtime !== 'poll' || pollTimer)
            return;
        pollTimer = setInterval(async () => {
            for (const [, sub] of subscriptions) {
                if (sub.kind === 'row') {
                    const rowRes = await post('/select', { table: sub.table, pk: sub.pk });
                    sub.cb({ item: rowRes.row ?? null });
                }
                else {
                    const win = sub.query;
                    const res = await post('/select', { table: sub.table, select: win.select, orderBy: win.orderBy, limit: win.limit, cursor: win.cursor });
                    const data = applyWhere((res.data ?? []), win.where);
                    sub.cb({ data, cursor: res.nextCursor ?? null });
                }
            }
        }, pollIntervalMs);
    }
    async function insert(table, rows) {
        const opId = ulid();
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) {
            const tempId = r.id ?? `temp_${ulid()}`;
            await datastore.apply(table, tempId, { set: { ...r, id: tempId } });
        }
        const res = await post('/mutate', { op: 'insert', table, rows: arr, clientOpId: opId });
        const ins = (Array.isArray(rows) ? res.rows : [res.row]);
        for (const row of ins) {
            await datastore.reconcile(table, row.id, row);
        }
        return Array.isArray(rows) ? ins : ins[0];
    }
    async function update(table, pk, set, opts) {
        const opId = ulid();
        await datastore.apply(table, pk, { set });
        try {
            const res = await post('/mutate', { op: 'update', table, pk, set, ifVersion: opts?.ifVersion, clientOpId: opId });
            await datastore.reconcile(table, pk, res.row);
            return res.row;
        }
        catch (e) {
            const rowRes = await post('/select', { table, pk });
            if (rowRes.row)
                await datastore.reconcile(table, pk, rowRes.row);
            throw e;
        }
    }
    async function _delete(table, pk) {
        const opId = ulid();
        await datastore.apply(table, pk, { unset: ['id'] });
        try {
            await post('/mutate', { op: 'delete', table, pk, clientOpId: opId });
            return { ok: true };
        }
        catch (e) {
            const rowRes = await post('/select', { table, pk });
            if (rowRes.row)
                await datastore.reconcile(table, pk, rowRes.row);
            throw e;
        }
    }
    async function upsert(table, rows, opts) {
        const opId = ulid();
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) {
            const id = r.id ?? `temp_${ulid()}`;
            await datastore.apply(table, id, { set: { ...r, id } });
        }
        const res = await post('/mutate', { op: 'upsert', table, rows: arr, merge: opts?.merge, clientOpId: opId });
        const ret = Array.isArray(rows) ? res.rows : [res.row];
        for (const row of ret)
            await datastore.reconcile(table, row.id, row);
        return Array.isArray(rows) ? ret : ret[0];
    }
    async function updateWhere(table, where, set) {
        const { data } = await selectAllPages(table, { orderBy: { updatedAt: 'desc' }, limit: 100 });
        const targets = applyWhere(data, where);
        const failed = [];
        let ok = 0;
        const pks = [];
        for (const row of targets) {
            try {
                const updated = await update(table, row.id, set);
                pks.push(row.id);
                ok++;
            }
            catch (e) {
                failed.push({ pk: row.id, error: { code: 'INTERNAL', message: String(e?.message ?? e) } });
            }
        }
        return { ok, failed, pks };
    }
    async function deleteWhere(table, where) {
        const { data } = await selectAllPages(table, { orderBy: { updatedAt: 'desc' }, limit: 100 });
        const targets = applyWhere(data, where);
        const failed = [];
        let ok = 0;
        const pks = [];
        for (const row of targets) {
            try {
                await _delete(table, row.id);
                pks.push(row.id);
                ok++;
            }
            catch (e) {
                failed.push({ pk: row.id, error: { code: 'INTERNAL', message: String(e?.message ?? e) } });
            }
        }
        return { ok, failed, pks };
    }
    function watchRow(table, pk, cb, opts) {
        const id = subSeq++;
        subscriptions.set(id, { table, kind: 'row', pk, cb });
        post('/select', { table, pk, select: opts?.select }).then(res => cb({ item: res.row ?? null }));
        startSseIfNeeded();
        if (realtime === 'poll')
            startPolling();
        return {
            unsubscribe() { subscriptions.delete(id); },
            status: 'live',
            error: undefined,
            getSnapshot: () => datastore.readByPk(table, pk, opts?.select)
        };
    }
    function watchQuery(table, query, cb) {
        const id = subSeq++;
        subscriptions.set(id, { table, kind: 'query', query, cb });
        post('/select', { table, select: query.select, orderBy: query.orderBy, limit: query.limit, cursor: query.cursor }).then(res => {
            const data = applyWhere((res.data ?? []), query.where);
            cb({ data, cursor: res.nextCursor ?? null });
        });
        startSseIfNeeded();
        if (realtime === 'poll')
            startPolling();
        return {
            unsubscribe() { subscriptions.delete(id); },
            status: 'live',
            error: undefined,
            getSnapshot: async () => (await datastore.readWindow(table, query)).data
        };
    }
    function tableApi(name) {
        return {
            select(arg1, arg2) {
                if (typeof arg1 === 'string' || typeof arg1 === 'number' || (arg1 && typeof arg1 === 'object' && !('where' in arg1))) {
                    return post('/select', { table: name, pk: arg1, select: arg2?.select }).then(r => r.row ?? null);
                }
                const req = arg1;
                return post('/select', { table: name, select: req.select, orderBy: req.orderBy, limit: req.limit, cursor: req.cursor }).then(r => ({ data: applyWhere(r.data, req.where), nextCursor: r.nextCursor ?? null }));
            },
            watch(arg1, arg2, arg3) {
                if (typeof arg1 === 'string' || typeof arg1 === 'number' || (arg1 && typeof arg1 === 'object' && !('where' in arg1))) {
                    return watchRow(name, arg1, arg2, arg3);
                }
                return watchQuery(name, arg1, arg2);
            },
            insert: (row) => insert(name, row),
            update: (first, second, third) => {
                if (first && typeof first === 'object' && 'where' in first) {
                    return updateWhere(name, first.where, second.set);
                }
                return update(name, first, second, third);
            },
            delete: (first) => {
                if (first && typeof first === 'object' && 'where' in first) {
                    return deleteWhere(name, first.where);
                }
                return _delete(name, first);
            },
            upsert: (row, opts) => upsert(name, row, opts),
            $infer: {}
        };
    }
    const client = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'close')
                return () => { try {
                    sse?.close();
                }
                catch { } ; if (pollTimer)
                    clearInterval(pollTimer); };
            if (prop === 'mutators')
                return new Proxy({}, { get: (_t2, name) => (args) => post(`/mutators/${name}`, { args }) });
            return tableApi(prop);
        }
    });
    return client;
}
