import type { DatabaseAdapter, PrimaryKey } from '../shared/types';
import { monotonicFactory } from 'ulid';
import initSqlJs from 'sql.js';
import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export function sqliteAdapter(_config: { url: string }): DatabaseAdapter {
  // In-memory SQLite via sql.js (sufficient for MVP & tests)
  const filePath = _config.url?.startsWith('file:') ? resolvePath(_config.url.slice('file:'.length)) : null;
  const ready = initSqlJs({ locateFile: (f: string) => `node_modules/sql.js/dist/${f}` }).then(async (SQL) => {
    if (filePath) {
      try {
        const buf = await fs.readFile(filePath);
        return new SQL.Database(new Uint8Array(buf));
      } catch {
        return new SQL.Database();
      }
    }
    return new SQL.Database();
  });
  let txDepth = 0;
  async function ensureTable(db: any, table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row).filter((c) => c !== 'version');
    if (cols.length === 0) return;
    const defs = cols.map((c) => c === 'id' ? `${c} TEXT PRIMARY KEY` : `${c} TEXT`).join(',');
    db.run(`CREATE TABLE IF NOT EXISTS ${table} (${defs})`);
  }
  async function ensureMinimalTable(db: any, table: string) {
    db.run(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, updatedAt INTEGER)`);
  }
  return {
    async ensureMeta() { const db = await ready; db.run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`); },
    async begin() { const db = await ready; if (txDepth === 0) db.run('BEGIN'); txDepth++; },
    async commit() { const db = await ready; if (txDepth > 0) { txDepth--; if (txDepth === 0) { db.run('COMMIT'); if (filePath) { const data = db.export(); await fs.mkdir(resolvePath(filePath, '..'), { recursive: true }).catch(() => { }); await fs.writeFile(filePath, Buffer.from(data)); } } } },
    async rollback() { const db = await ready; if (txDepth > 0) { db.run('ROLLBACK'); txDepth = 0; } },
    async insert(table: string, row: Record<string, any>) {
      const db = await ready;
      db.run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
      await ensureTable(db, table, row);
      // Unique check on id
      if (row.id != null) {
        const s = db.prepare(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`);
        s.bind([String(row.id)]);
        const exists = s.step();
        s.free();
        if (exists) { const e: any = new Error('duplicate'); e.code = 'CONFLICT'; e.details = { constraint: 'unique', column: 'id' }; throw e; }
      }
      const cols = Object.keys(row).filter((c) => c !== 'version');
      const placeholders = cols.map(() => '?').join(',');
      db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(k => (row as any)[k]));
      // mirror version into meta if provided
      if (row.id != null && typeof row.version === 'number') {
        const pk = String(row.id);
        db.run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (?, ?, ?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version = excluded.version`, [table, pk, row.version]);
      }
      return { ...row };
    },
    async updateByPk(table: string, pk: PrimaryKey, set: Record<string, any>, opts?: { ifVersion?: number }) {
      const db = await ready;
      db.run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
      const key = canonicalPk(pk);
      let g: any;
      try { g = db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`); }
      catch (err: any) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
      g.bind([key]); const cur = g.step() ? g.getAsObject() : null; g.free();
      if (!cur) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
      if (opts?.ifVersion != null) {
        const v = db.prepare(`SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`);
        v.bind([table, key]); const has = v.step(); const metaVer = has ? (v.getAsObject() as any).version : null; v.free();
        if (metaVer != null && metaVer !== opts.ifVersion) { const e: any = new Error('Version mismatch'); e.code = 'CONFLICT'; e.details = { expectedVersion: opts.ifVersion, actualVersion: metaVer }; throw e; }
      }
      const next: any = { ...set };
      const cols = Object.keys(next).filter((c) => c !== 'version');
      if (cols.length > 0) {
        const assigns = cols.map(c => `${c} = ?`).join(',');
        db.run(`UPDATE ${table} SET ${assigns} WHERE id = ?`, [...cols.map(c => next[c]), key]);
      }
      if (typeof next.version === 'number') {
        db.run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (?, ?, ?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version = excluded.version`, [table, key, next.version]);
      }
      const out = db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`);
      out.bind([key]); const row = out.step() ? out.getAsObject() : null; out.free();
      if (!row) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
      // augment with version from meta
      const v2 = db.prepare(`SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`);
      v2.bind([table, key]); const has2 = v2.step(); const verOut = has2 ? (v2.getAsObject() as any).version : undefined; v2.free();
      return { ...(row as any), ...(verOut != null ? { version: verOut } : {}) } as any;
    },
    async deleteByPk(table: string, pk: PrimaryKey) {
      const db = await ready;
      const key = canonicalPk(pk);
      let s: any;
      try { s = db.prepare(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`); }
      catch (err: any) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
      s.bind([key]); const existed = s.step(); s.free();
      if (!existed) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
      db.run(`DELETE FROM ${table} WHERE id = ?`, [key]);
      db.run(`DELETE FROM _sync_versions WHERE table_name = ? AND pk_canonical = ?`, [table, key]);
      return { ok: true } as const;
    },
    async selectByPk(table: string, pk: PrimaryKey, select?: string[]) {
      const db = await ready;
      await ensureMinimalTable(db, table);
      const key = canonicalPk(pk);
      const s = db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`);
      s.bind([key]); const row = s.step() ? s.getAsObject() : null; s.free();
      if (!row) return null;
      const v = db.prepare(`SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`);
      v.bind([table, key]); const has = v.step(); const ver = has ? (v.getAsObject() as any).version : undefined; v.free();
      const full: any = { ...(row as any) };
      if (ver != null) full.version = ver;
      if (!select || select.length === 0) return full as any;
      const out: any = {}; for (const f of select) out[f] = full[f]; return out;
    },
    async selectWindow(table: string, req: any) {
      const db = await ready;
      await ensureMinimalTable(db, table);
      const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? { updatedAt: 'desc' };
      const keys = Object.keys(orderBy);
      let sql = `SELECT t.*, v.version AS __ver FROM ${table} t LEFT JOIN _sync_versions v ON v.table_name = ? AND v.pk_canonical = t.id`;
      const params: any[] = [table];
      if (req.cursor) {
        try {
          const c = JSON.parse(Buffer.from(String(req.cursor), 'base64').toString('utf8')) as { last?: { id: string } };
          if (c?.last?.id) { sql += ` WHERE t.id > ?`; params.push(c.last.id); }
        } catch { }
      }
      if (keys.length > 0) {
        const ord = keys.map(k => `t.${k} ${(orderBy[k] ?? 'asc').toUpperCase()}`).join(', ');
        sql += ` ORDER BY ${ord}, t.id ASC`;
      } else {
        sql += ` ORDER BY t.id ASC`;
      }
      const limit = typeof req.limit === 'number' ? req.limit : 100;
      sql += ` LIMIT ?`; params.push(limit);
      const stmt = db.prepare(sql); stmt.bind(params);
      const out: any[] = []; while (stmt.step()) { const r = stmt.getAsObject() as any; const { __ver, ...rest } = r; out.push(__ver != null ? { ...rest, version: __ver } : rest); } stmt.free();
      let nextCursor: string | null = null;
      if (out.length === limit) {
        const last = out[out.length - 1];
        const lastKeys: Record<string, string | number> = {};
        for (const k of keys) lastKeys[k] = (last as any)[k];
        nextCursor = Buffer.from(JSON.stringify({ table, orderBy, last: { keys: lastKeys, id: String((last as any).id) } }), 'utf8').toString('base64');
      }
      return { data: out, nextCursor };
    }
  };
}

function canonicalPk(pk: PrimaryKey): string {
  if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
  const parts = Object.keys(pk).sort().map((k) => `${k}=${String(pk[k] as any)}`);
  return parts.join('|');
}

export function memoryAdapter(): DatabaseAdapter {
  const tables = new Map<string, Map<string, any>>();
  const ulid = monotonicFactory();
  return {
    async begin() { },
    async commit() { },
    async rollback() { },
    async insert(table: string, row: Record<string, any>) {
      const t = tables.get(table) ?? (tables.set(table, new Map()), tables.get(table)!);
      const id = row.id ?? ulid();
      const key = String(id);
      const existing = t.get(key);
      if (existing) {
        const e: any = new Error('duplicate'); e.code = 'CONFLICT'; e.details = { constraint: 'unique', column: 'id' }; throw e;
      }
      const now = Date.now();
      const out = { ...row, id, updatedAt: (row as any).updatedAt ?? now, version: (row as any).version ?? 1 };
      t.set(key, out);
      return out;
    },
    async updateByPk(table: string, pk: PrimaryKey, set: Record<string, any>, opts?: { ifVersion?: number }) {
      const t = tables.get(table);
      const key = canonicalPk(pk);
      if (!t || !t.has(key)) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
      const cur = t.get(key);
      if (opts?.ifVersion && cur.version !== opts.ifVersion) { const e: any = new Error('Version mismatch'); e.code = 'CONFLICT'; e.details = { expectedVersion: opts.ifVersion, actualVersion: cur.version }; throw e; }
      const now = Date.now();
      const out = { ...cur, ...set, updatedAt: now, version: (cur.version ?? 0) + 1 };
      t.set(key, out);
      return out;
    },
    async deleteByPk(table: string, pk: PrimaryKey) {
      const t = tables.get(table);
      const key = canonicalPk(pk);
      if (!t || !t.has(key)) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
      t.delete(key);
      return { ok: true } as const;
    },
    async selectByPk(table: string, pk: PrimaryKey, select?: string[]) {
      const t = tables.get(table);
      const key = canonicalPk(pk);
      const row = t?.get(key) ?? null;
      if (!row) return null;
      if (!select || select.length === 0) return row;
      const out: any = {};
      for (const f of select) out[f] = row[f];
      return out;
    },
    async selectWindow(table: string, req: any) {
      const t = tables.get(table) ?? new Map<string, any>();
      let rows = Array.from(t.values());
      const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? { updatedAt: 'desc' };
      const keys = Object.keys(orderBy);
      rows.sort((a, b) => {
        for (const k of keys) {
          const dir = orderBy[k];
          const va = a[k];
          const vb = b[k];
          if (va === vb) continue;
          const cmp = va > vb ? 1 : -1;
          return dir === 'asc' ? cmp : -cmp;
        }
        const ia = String(a.id);
        const ib = String(b.id);
        return ia.localeCompare(ib);
      });
      const limit = typeof req.limit === 'number' ? req.limit : 100;
      let start = 0;
      type CursorJson = { table: string; orderBy: Record<string, 'asc' | 'desc'>; last?: { keys: Record<string, string | number>; id: string } };
      if (req.cursor) {
        try {
          const json = JSON.parse(Buffer.from(String(req.cursor), 'base64').toString('utf8')) as CursorJson;
          const lastId = json?.last?.id;
          if (lastId) {
            const idx = rows.findIndex(r => String(r.id) === String(lastId));
            if (idx >= 0) start = idx + 1;
          }
        } catch { }
      }
      const page = rows.slice(start, start + limit);
      let nextCursor: string | null = null;
      if ((start + limit) < rows.length && page.length > 0) {
        const last = page[page.length - 1];
        const lastKeys: Record<string, string | number> = {};
        for (const k of keys) lastKeys[k] = last[k];
        const c: CursorJson = { table, orderBy, last: { keys: lastKeys, id: String(last.id) } };
        nextCursor = Buffer.from(JSON.stringify(c), 'utf8').toString('base64');
      }
      return { data: page, nextCursor };
    }
  };
}
