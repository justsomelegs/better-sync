import BetterSqlite3, { Database as BetterSqlite3Database } from 'better-sqlite3';
import { ulid } from 'ulidx';
import type { DatabaseAdapter, PrimaryKey, SelectWindow, OrderBy } from '@sync/core';

type SqliteAdapterOptions = { url: string };

function nowMs() { return Date.now(); }

function ensureMeta(db: BetterSqlite3Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_versions (
      table_name TEXT NOT NULL,
      pk TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (table_name, pk)
    );
    CREATE TABLE IF NOT EXISTS _sync_seq (
      table_name TEXT PRIMARY KEY,
      seq INTEGER NOT NULL
    );
  `);
}

function canonicalPk(pk: PrimaryKey): string {
  if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
  const keys = Object.keys(pk).sort();
  return keys.map(k => `${k}=${String((pk as any)[k])}`).join('|');
}

function tableName(name: string) { return name; }

function ensureUserTable(db: BetterSqlite3Database, table: string) {
  const info = db.prepare(`PRAGMA table_info(${tableName(table)})`).all();
  if (info.length === 0) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${tableName(table)} (
      id TEXT PRIMARY KEY,
      updatedAt INTEGER NOT NULL,
      data TEXT NOT NULL
    );`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_updatedAt ON ${tableName(table)}(updatedAt DESC)`);
  }
}

function bumpVersion(db: BetterSqlite3Database, table: string, pk: string): number {
  const sel = db.prepare(`SELECT seq FROM _sync_seq WHERE table_name=?`).get(table) as { seq: number } | undefined;
  const next = (sel?.seq ?? 0) + 1;
  if (sel) db.prepare(`UPDATE _sync_seq SET seq=? WHERE table_name=?`).run(next, table);
  else db.prepare(`INSERT INTO _sync_seq(table_name, seq) VALUES(?,?)`).run(table, next);
  db.prepare(`INSERT INTO _sync_versions(table_name, pk, version) VALUES(?,?,?) ON CONFLICT(table_name, pk) DO UPDATE SET version=excluded.version`).run(table, pk, next);
  return next;
}

function getVersion(db: BetterSqlite3Database, table: string, pk: string): number | null {
  const row = db.prepare(`SELECT version FROM _sync_versions WHERE table_name=? AND pk=?`).get(table, pk) as { version: number } | undefined;
  return row?.version ?? null;
}

function encodeCursor(table: string, orderBy: OrderBy | undefined, last: { updatedAt: number; id: string } | null): string | null {
  if (!last) return null;
  const obj = { table, orderBy: orderBy ?? { updatedAt: 'desc' as const }, last };
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function decodeCursor(cursor: string | null | undefined): { last: { updatedAt: number; id: string } | null } {
  if (!cursor) return { last: null };
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    return { last: obj.last ?? null };
  } catch {
    return { last: null };
  }
}

export function sqliteAdapter(options: SqliteAdapterOptions): DatabaseAdapter {
  const db = new BetterSqlite3(options.url);
  db.pragma('journal_mode = WAL');
  ensureMeta(db);
  let txActive = false;

  return {
    async begin() {
      if (txActive) throw new Error('INTERNAL: nested transaction not supported');
      db.exec('BEGIN');
      txActive = true;
    },
    async commit() {
      if (!txActive) return;
      db.exec('COMMIT');
      txActive = false;
    },
    async rollback() {
      if (!txActive) return;
      db.exec('ROLLBACK');
      txActive = false;
    },
    async insert(table, row) {
      ensureUserTable(db, table);
      const id = (row as any).id ?? ulid();
      const updatedAt = nowMs();
      const pk = String(id);
      const version = bumpVersion(db, table, pk);
      const merged = { ...(row as any), id, updatedAt, version };
      const data = JSON.stringify(merged);
      try {
        db.prepare(`INSERT INTO ${tableName(table)}(id, updatedAt, data) VALUES(?,?,?)`).run(id, updatedAt, data);
      } catch (e: any) {
        if (String(e?.message ?? '').includes('UNIQUE')) throw new Error('CONFLICT: unique constraint');
        throw e;
      }
      return merged as any;
    },
    async updateByPk(table, pkInput, set, opts) {
      ensureUserTable(db, table);
      const pk = canonicalPk(pkInput);
      const existing = db.prepare(`SELECT data FROM ${tableName(table)} WHERE id=?`).get(pk) as { data: string } | undefined;
      if (!existing) throw new Error('NOT_FOUND: row not found');
      const row = JSON.parse(existing.data);
      const expected = opts?.ifVersion;
      const actualVersion = getVersion(db, table, pk) ?? row.version ?? 0;
      if (expected !== undefined && expected !== actualVersion) {
        throw new Error(`version mismatch: expected ${expected} got ${actualVersion}`);
      }
      const updatedAt = nowMs();
      const nextVersion = bumpVersion(db, table, pk);
      const merged = { ...row, ...set, id: pk, updatedAt, version: nextVersion };
      const data = JSON.stringify(merged);
      db.prepare(`UPDATE ${tableName(table)} SET updatedAt=?, data=? WHERE id=?`).run(updatedAt, data, pk);
      return merged as any;
    },
    async deleteByPk(table, pkInput) {
      ensureUserTable(db, table);
      const pk = canonicalPk(pkInput);
      db.prepare(`DELETE FROM ${tableName(table)} WHERE id=?`).run(pk);
      // bump version for delete to allow watchers to notice change
      bumpVersion(db, table, pk);
      return { ok: true } as const;
    },
    async selectByPk(table, pkInput, select) {
      ensureUserTable(db, table);
      const pk = canonicalPk(pkInput);
      const row = db.prepare(`SELECT data FROM ${tableName(table)} WHERE id=?`).get(pk) as { data: string } | undefined;
      if (!row) return null;
      const obj = JSON.parse(row.data);
      if (select && select.length) {
        const out: Record<string, unknown> = {};
        for (const k of select) out[k] = obj[k];
        return out as any;
      }
      return obj as any;
    },
    async selectWindow(table, req) {
      ensureUserTable(db, table);
      const orderBy = req.orderBy ?? { updatedAt: 'desc' };
      const orderDir = orderBy.updatedAt === 'asc' ? 'ASC' : 'DESC';
      const limit = Math.max(1, Math.min(1000, req.limit ?? 100));
      const { last } = decodeCursor(req.cursor);
      let sql = `SELECT id, updatedAt, data FROM ${tableName(table)}`;
      const params: any[] = [];
      if (last) {
        if (orderDir === 'DESC') {
          sql += ` WHERE (updatedAt < ?) OR (updatedAt = ? AND id < ?)`;
        } else {
          sql += ` WHERE (updatedAt > ?) OR (updatedAt = ? AND id > ?)`;
        }
        params.push(last.updatedAt, last.updatedAt, last.id);
      }
      sql += ` ORDER BY updatedAt ${orderDir}, id ${orderDir} LIMIT ?`;
      params.push(limit);
      const rows = db.prepare(sql).all(...params) as Array<{ id: string; updatedAt: number; data: string }>;
      const data = rows.map(r => JSON.parse(r.data));
      const nextLast = rows.length ? { updatedAt: rows[rows.length - 1].updatedAt, id: rows[rows.length - 1].id } : null;
      const nextCursor = encodeCursor(table, orderBy, nextLast);
      if (req.select && req.select.length) {
        const selected = data.map(obj => {
          const out: Record<string, unknown> = {};
          for (const k of req.select!) out[k] = obj[k];
          return out;
        });
        return { data: selected, nextCursor };
      }
      return { data, nextCursor };
    }
  } satisfies DatabaseAdapter as DatabaseAdapter;
}

export type { SqliteAdapterOptions };
