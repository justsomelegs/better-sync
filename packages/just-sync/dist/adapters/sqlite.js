import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
export function sqliteAdapter(opts) {
    try {
        const require = createRequire(import.meta.url);
        const BetterSqlite3 = require("better-sqlite3");
        const db = new BetterSqlite3(opts.url.replace(/^file:/, ""));
        let inTx = false;
        function ensureTxStart() {
            if (inTx)
                throw new Error("INTERNAL: nested transaction not supported");
            inTx = true;
            db.prepare("BEGIN").run();
        }
        function ensureTxCommit() {
            if (!inTx)
                return;
            db.prepare("COMMIT").run();
            inTx = false;
        }
        function ensureTxRollback() {
            if (!inTx)
                return;
            db.prepare("ROLLBACK").run();
            inTx = false;
        }
        function canonicalPk(pk) {
            if (typeof pk === "string" || typeof pk === "number")
                return String(pk);
            return Object.keys(pk)
                .sort()
                .map((k) => `${k}=${String(pk[k])}`)
                .join("|");
        }
        return {
            async begin() {
                ensureTxStart();
            },
            async commit() {
                ensureTxCommit();
            },
            async rollback() {
                ensureTxRollback();
            },
            async insert(table, row) {
                // For MVP we assume a generic table with JSON payloads
                db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, updatedAt INTEGER, version INTEGER, data TEXT)`).run();
                const now = Date.now();
                const versionRow = db.prepare(`SELECT COALESCE(MAX(version),0) as v FROM ${table}`).get();
                const version = (versionRow?.v ?? 0) + 1;
                const id = row.id ?? cryptoRandomId();
                const record = { ...row, id, updatedAt: now, version };
                db.prepare(`INSERT INTO ${table} (id, updatedAt, version, data) VALUES (@id, @updatedAt, @version, @data)`).run({
                    id,
                    updatedAt: now,
                    version,
                    data: JSON.stringify(record)
                });
                return record;
            },
            async updateByPk(table, pk, set) {
                const id = canonicalPk(pk);
                const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
                if (!row?.data)
                    throw new Error("NOT_FOUND: row");
                const existing = JSON.parse(row.data);
                const now = Date.now();
                const versionRow = db.prepare(`SELECT COALESCE(MAX(version),0) as v FROM ${table}`).get();
                const version = (versionRow?.v ?? 0) + 1;
                const next = { ...existing, ...set, updatedAt: now, version };
                db.prepare(`UPDATE ${table} SET updatedAt=@updatedAt, version=@version, data=@data WHERE id=@id`).run({
                    id,
                    updatedAt: now,
                    version,
                    data: JSON.stringify(next)
                });
                return next;
            },
            async deleteByPk(table, pk) {
                const id = canonicalPk(pk);
                db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
                return { ok: true };
            },
            async selectByPk(table, pk, select) {
                const id = canonicalPk(pk);
                const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
                if (!row?.data)
                    return null;
                const parsed = JSON.parse(row.data);
                if (!select || select.length === 0)
                    return parsed;
                const out = {};
                for (const k of select)
                    out[k] = parsed[k];
                return out;
            },
            async selectWindow(table, req) {
                db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, updatedAt INTEGER, version INTEGER, data TEXT)`).run();
                const limit = Math.max(1, Math.min(req.limit ?? 100, 1000));
                const orderBy = req.orderBy ?? { updatedAt: "desc" };
                const orderClause = Object.entries(orderBy)
                    .map(([k, v]) => `${k} ${v.toUpperCase()}`)
                    .concat(["id ASC"]) // tie-breaker
                    .join(", ");
                const rows = db.prepare(`SELECT data FROM ${table} ORDER BY ${orderClause} LIMIT ?`).all(limit);
                const data = rows.map((r) => JSON.parse(r.data));
                if (!req.select || req.select.length === 0)
                    return { data, nextCursor: null };
                const projected = data.map((row) => {
                    const out = {};
                    for (const k of req.select)
                        out[k] = row[k];
                    return out;
                });
                return { data: projected, nextCursor: null };
            }
        };
    }
    catch {
        throw new Error("better-sqlite3 is required for sqliteAdapter in this environment. Install it or use memoryAdapter for tests.");
    }
}
function cryptoRandomId() {
    return randomUUID();
}
//# sourceMappingURL=sqlite.js.map