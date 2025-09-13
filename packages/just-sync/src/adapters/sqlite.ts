// Minimal SQLite adapter placeholder for MVP demos.
// Uses better-sqlite3 if available, otherwise throws on construction.
import type { DatabaseAdapter, PrimaryKey, SelectWindow } from "../server";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown> & { id: string; updatedAt: number; version: number };

export function sqliteAdapter(opts: { url: string }): DatabaseAdapter {
  try {
    const require = createRequire(import.meta.url);
    const BetterSqlite3 = require("better-sqlite3");
    const db = new BetterSqlite3(opts.url.replace(/^file:/, ""));
    let inTx = false;

    function ensureTxStart() {
      if (inTx) throw new Error("INTERNAL: nested transaction not supported");
      inTx = true;
      db.prepare("BEGIN").run();
    }
    function ensureTxCommit() {
      if (!inTx) return;
      db.prepare("COMMIT").run();
      inTx = false;
    }
    function ensureTxRollback() {
      if (!inTx) return;
      db.prepare("ROLLBACK").run();
      inTx = false;
    }

    function canonicalPk(pk: PrimaryKey): string {
      if (typeof pk === "string" || typeof pk === "number") return String(pk);
      return Object.keys(pk)
        .sort()
        .map((k) => `${k}=${String((pk as any)[k])}`)
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
      async insert(table: string, row: Record<string, unknown>) {
        // For MVP we assume a generic table with JSON payloads
        db.prepare(
          `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, updatedAt INTEGER, version INTEGER, data TEXT)`
        ).run();
        const now = Date.now();
        const versionRow = db.prepare(`SELECT COALESCE(MAX(version),0) as v FROM ${table}`).get() as { v: number };
        const version = (versionRow?.v ?? 0) + 1;
        const id = (row as any).id ?? cryptoRandomId();
        const record: Row = { ...(row as any), id, updatedAt: now, version };
        db.prepare(`INSERT INTO ${table} (id, updatedAt, version, data) VALUES (@id, @updatedAt, @version, @data)`).run({
          id,
          updatedAt: now,
          version,
          data: JSON.stringify(record)
        });
        return record;
      },
      async updateByPk(table: string, pk: PrimaryKey, set: Record<string, unknown>) {
        const id = canonicalPk(pk);
        const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data?: string } | undefined;
        if (!row?.data) throw new Error("NOT_FOUND: row");
        const existing = JSON.parse(row.data) as Row;
        const now = Date.now();
        const versionRow = db.prepare(`SELECT COALESCE(MAX(version),0) as v FROM ${table}`).get() as { v: number };
        const version = (versionRow?.v ?? 0) + 1;
        const next: Row = { ...existing, ...set, updatedAt: now, version };
        db.prepare(`UPDATE ${table} SET updatedAt=@updatedAt, version=@version, data=@data WHERE id=@id`).run({
          id,
          updatedAt: now,
          version,
          data: JSON.stringify(next)
        });
        return next;
      },
      async deleteByPk(table: string, pk: PrimaryKey) {
        const id = canonicalPk(pk);
        db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
        return { ok: true } as const;
      },
      async selectByPk(table: string, pk: PrimaryKey, select?: string[]) {
        const id = canonicalPk(pk);
        const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data?: string } | undefined;
        if (!row?.data) return null;
        const parsed = JSON.parse(row.data) as Row;
        if (!select || select.length === 0) return parsed;
        const out: Record<string, unknown> = {};
        for (const k of select) out[k] = (parsed as any)[k];
        return out;
      },
      async selectWindow(table: string, req: SelectWindow & { where?: unknown }) {
        db.prepare(
          `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, updatedAt INTEGER, version INTEGER, data TEXT)`
        ).run();
        const limit = Math.max(1, Math.min(req.limit ?? 100, 1000));
        const orderBy = req.orderBy ?? { updatedAt: "desc" };
        const orderClause = Object.entries(orderBy)
          .map(([k, v]) => `${k} ${v.toUpperCase()}`)
          .concat(["id ASC"]) // tie-breaker
          .join(", ");
        const rows = db.prepare(`SELECT data FROM ${table} ORDER BY ${orderClause} LIMIT ?`).all(limit) as Array<{ data: string }>;
        const data = rows.map((r) => JSON.parse(r.data) as Row);
        if (!req.select || req.select.length === 0) return { data, nextCursor: null };
        const projected = data.map((row) => {
          const out: Record<string, unknown> = {};
          for (const k of req.select!) out[k] = (row as any)[k];
          return out;
        });
        return { data: projected, nextCursor: null };
      }
    } as DatabaseAdapter;
  } catch {
    throw new Error(
      "better-sqlite3 is required for sqliteAdapter in this environment. Install it or use memoryAdapter for tests."
    );
  }
}

function cryptoRandomId() {
  return randomUUID();
}

