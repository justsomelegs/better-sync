import Database from 'better-sqlite3';
import { ulid } from 'ulid';

export type SqliteAdapterOptions = { url: string };

export type PrimaryKey = string | number | Record<string, string | number>;

function canonicalizePrimaryKey(pk: PrimaryKey): string {
  if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
  const keys = Object.keys(pk).sort();
  return keys.map((k) => `${k}=${String(pk[k] as string | number)}`).join('|');
}

type OrderBy = Record<string, 'asc' | 'desc'>;

function decodeCursor(cursor: string): { orderBy: OrderBy; last: { updatedAt: number; id: string } } | null {
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return obj;
  } catch {
    return null;
  }
}

function encodeCursor(payload: { orderBy: OrderBy; last: { updatedAt: number; id: string } }): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function sqliteAdapter(_opts: SqliteAdapterOptions) {
  const file = _opts.url.replace(/^file:/, '');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_rows (
      table_name TEXT NOT NULL,
      id TEXT NOT NULL,
      pk TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY (table_name, pk)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_rows_table_updated ON sync_rows(table_name, updatedAt DESC, id ASC);
    CREATE TABLE IF NOT EXISTS sync_versions (
      table_name TEXT NOT NULL,
      pk TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (table_name, pk)
    );
    CREATE TABLE IF NOT EXISTS sync_counters (
      table_name TEXT PRIMARY KEY,
      last_version INTEGER NOT NULL
    );
  `);

  let inTx = false;

  function nextVersion(table: string): number {
    const get = db.prepare('SELECT last_version FROM sync_counters WHERE table_name = ?');
    const row = get.get(table) as { last_version: number } | undefined;
    if (!row) {
      db.prepare('INSERT INTO sync_counters (table_name, last_version) VALUES (?, 0)').run(table);
    }
    const upd = db.prepare('UPDATE sync_counters SET last_version = last_version + 1 WHERE table_name = ?');
    upd.run(table);
    const after = get.get(table) as { last_version: number };
    return after.last_version;
  }

  return {
    async begin() {
      if (inTx) throw Object.assign(new Error('Nested transactions not supported'), { code: 'INTERNAL' });
      db.exec('BEGIN');
      inTx = true;
    },
    async commit() {
      if (!inTx) return;
      db.exec('COMMIT');
      inTx = false;
    },
    async rollback() {
      if (!inTx) return;
      db.exec('ROLLBACK');
      inTx = false;
    },
    async insert(table: string, row: Record<string, unknown>) {
      const id = typeof row.id === 'string' && row.id.length ? (row.id as string) : ulid();
      const updatedAt = Date.now();
      const pk = canonicalizePrimaryKey(id);
      const version = nextVersion(table);
      const rowWithMeta = { ...row, id, updatedAt, version } as Record<string, unknown>;
      try {
        db.prepare('INSERT INTO sync_rows (table_name, id, pk, updatedAt, row_json) VALUES (?,?,?,?,?)')
          .run(table, id, pk, updatedAt, JSON.stringify(rowWithMeta));
        db.prepare('INSERT INTO sync_versions (table_name, pk, version) VALUES (?,?,?) ON CONFLICT(table_name, pk) DO UPDATE SET version=excluded.version')
          .run(table, pk, version);
      } catch (e: any) {
        if (String(e?.message || '').includes('UNIQUE')) {
          throw Object.assign(new Error('Unique constraint violation'), { code: 'CONFLICT' });
        }
        throw Object.assign(new Error('Internal error'), { code: 'INTERNAL' });
      }
      return rowWithMeta;
    },
    async updateByPk(table: string, pkInput: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }) {
      const pk = canonicalizePrimaryKey(pkInput);
      const sel = db.prepare('SELECT row_json FROM sync_rows WHERE table_name = ? AND pk = ?');
      const existing = sel.get(table, pk) as { row_json: string } | undefined;
      if (!existing) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
      const row = JSON.parse(existing.row_json) as Record<string, unknown> & { id: string; updatedAt: number; version: number };
      if (opts?.ifVersion != null && row.version !== opts.ifVersion) {
        throw Object.assign(new Error('Version mismatch'), { code: 'CONFLICT', details: { expectedVersion: opts.ifVersion, actualVersion: row.version } });
      }
      const updatedAt = Date.now();
      const version = nextVersion(table);
      const newRow = { ...row, ...set, updatedAt, version };
      db.prepare('UPDATE sync_rows SET updatedAt = ?, row_json = ? WHERE table_name = ? AND pk = ?')
        .run(updatedAt, JSON.stringify(newRow), table, pk);
      db.prepare('INSERT INTO sync_versions (table_name, pk, version) VALUES (?,?,?) ON CONFLICT(table_name, pk) DO UPDATE SET version=excluded.version')
        .run(table, pk, version);
      return newRow as Record<string, unknown>;
    },
    async deleteByPk(table: string, pkInput: PrimaryKey) {
      const pk = canonicalizePrimaryKey(pkInput);
      const del = db.prepare('DELETE FROM sync_rows WHERE table_name = ? AND pk = ?');
      const info = del.run(table, pk);
      if (info.changes === 0) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
      const version = nextVersion(table);
      db.prepare('INSERT INTO sync_versions (table_name, pk, version) VALUES (?,?,?) ON CONFLICT(table_name, pk) DO UPDATE SET version=excluded.version')
        .run(table, pk, version);
      return { ok: true as const };
    },
    async selectByPk(table: string, pkInput: PrimaryKey, select?: string[]) {
      const pk = canonicalizePrimaryKey(pkInput);
      const sel = db.prepare('SELECT row_json FROM sync_rows WHERE table_name = ? AND pk = ?');
      const row = sel.get(table, pk) as { row_json: string } | undefined;
      if (!row) return null;
      const full = JSON.parse(row.row_json) as Record<string, unknown>;
      if (!select || select.length === 0) return full;
      const partial: Record<string, unknown> = {};
      for (const k of select) if (k in full) partial[k] = (full as any)[k];
      return partial;
    },
    async selectWindow(table: string, req: { select?: string[]; orderBy?: OrderBy; limit?: number; cursor?: string | null; where?: unknown }) {
      const order = req.orderBy ?? { updatedAt: 'desc' };
      const dir = order.updatedAt === 'asc' ? 'ASC' : 'DESC';
      const limit = Math.max(1, Math.min(1000, req.limit ?? 100));
      let baseSql = `SELECT id, updatedAt, row_json FROM sync_rows WHERE table_name = ?`;
      const params: any[] = [table];
      const cursor = typeof req.cursor === 'string' && req.cursor ? decodeCursor(req.cursor) : null;
      if (cursor) {
        // Apply seek pagination
        if (dir === 'DESC') {
          baseSql += ` AND (updatedAt < ? OR (updatedAt = ? AND id > ?))`;
          params.push(cursor.last.updatedAt, cursor.last.updatedAt, cursor.last.id);
        } else {
          baseSql += ` AND (updatedAt > ? OR (updatedAt = ? AND id > ?))`;
          params.push(cursor.last.updatedAt, cursor.last.updatedAt, cursor.last.id);
        }
      }
      baseSql += ` ORDER BY updatedAt ${dir}, id ASC LIMIT ?`;
      params.push(limit);
      const stmt = db.prepare(baseSql);
      const rows = stmt.all(...params) as Array<{ id: string; updatedAt: number; row_json: string }>;
      const data = rows.map((r) => {
        const full = JSON.parse(r.row_json) as Record<string, unknown>;
        if (!req.select || req.select.length === 0) return full;
        const partial: Record<string, unknown> = {};
        for (const k of req.select) if (k in full) partial[k] = (full as any)[k];
        return partial;
      });
      let nextCursor: string | null = null;
      if (rows.length === limit) {
        const last = rows[rows.length - 1];
        nextCursor = encodeCursor({ orderBy: order, last: { updatedAt: last.updatedAt, id: last.id } });
      }
      return { data, nextCursor };
    }
  } as const;
}
