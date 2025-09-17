import type { DatabaseAdapter, PrimaryKey } from '../shared/types';
import { canonicalPk, decodeWindowCursor, encodeWindowCursor } from './utils';
import { monotonicFactory } from 'ulid';
import initSqlJs from 'sql.js';
import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { SyncError } from '../shared/errors';

// URL builder intentionally removed to keep adapter DX explicit

export function sqliteAdapter(_config: { url: string; asyncFlush?: boolean; flushMs?: number }): DatabaseAdapter {
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
  let metaEnsured = false;
  const ensuredTables = new Set<string>();
  const ensuredMinimal = new Set<string>();
  let dirtySinceExport = false;
  const ensureIndex = new Set<string>();
  const asyncFlush = !!_config.asyncFlush;
  const flushMs = typeof _config.flushMs === 'number' ? Math.max(1, _config.flushMs) : 5;
  let flushTimer: NodeJS.Timeout | null = null;
  // Prepared statement simple pool keyed by SQL
  const stmtPool = new Map<string, any[]>();
  function acquireStmt(db: any, sql: string) {
    const pool = stmtPool.get(sql);
    if (pool && pool.length > 0) {
      return pool.pop();
    }
    return db.prepare(sql);
  }
  function releaseStmt(sql: string, stmt: any) {
    try { stmt.reset(); } catch {}
    const pool = stmtPool.get(sql) ?? (stmtPool.set(sql, []), stmtPool.get(sql)!);
    if (pool.length < 16) pool.push(stmt); else { try { stmt.free(); } catch {} }
  }
  async function scheduleFlush(db: any) {
    if (!filePath) return;
    if (!dirtySinceExport) return;
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      if (!dirtySinceExport) return;
      const data = db.export();
      await fs.mkdir(resolvePath(filePath!, '..'), { recursive: true }).catch(() => { });
      await fs.writeFile(filePath!, Buffer.from(data));
      dirtySinceExport = false;
    }, flushMs);
  }
  async function ensureTable(db: any, table: string, row: Record<string, unknown>) {
    if (ensuredTables.has(table)) return;
    const cols = Object.keys(row).filter((c) => c !== 'version');
    if (cols.length === 0) return;
    const defs = cols.map((c) => c === 'id' ? `${c} TEXT PRIMARY KEY` : `${c} TEXT`).join(',');
    db.run(`CREATE TABLE IF NOT EXISTS ${table} (${defs})`);
    ensuredTables.add(table);
    // index for common pagination pattern
    if (cols.includes('updatedAt')) {
      const idxKey = `${table}::updatedAt_id`;
      if (!ensureIndex.has(idxKey)) { try { db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_updatedAt_id ON ${table}(updatedAt, id)`); } catch {} ensureIndex.add(idxKey); }
    }
  }
  async function ensureMinimalTable(db: any, table: string) {
    if (ensuredMinimal.has(table)) return;
    db.run(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, updatedAt INTEGER)`);
    ensuredMinimal.add(table);
    const idxKey = `${table}::updatedAt_id`;
    if (!ensureIndex.has(idxKey)) { try { db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_updatedAt_id ON ${table}(updatedAt, id)`); } catch {} ensureIndex.add(idxKey); }
  }
  return {
    async ensureMeta() { const db = await ready; if (!metaEnsured) { db.run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`); metaEnsured = true; } },
    async begin() { const db = await ready; if (txDepth === 0) db.run('BEGIN'); txDepth++; },
    async commit() { const db = await ready; if (txDepth > 0) { txDepth--; if (txDepth === 0) { db.run('COMMIT'); if (filePath && dirtySinceExport) { if (asyncFlush) { await scheduleFlush(db); } else { const data = db.export(); await fs.mkdir(resolvePath(filePath, '..'), { recursive: true }).catch(() => { }); await fs.writeFile(filePath, Buffer.from(data)); dirtySinceExport = false; } } } } },
    async rollback() { const db = await ready; if (txDepth > 0) { db.run('ROLLBACK'); txDepth = 0; } },
    async insert(table: string, row: Record<string, any>) {
      const db = await ready;
      if (!metaEnsured) { db.run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`); metaEnsured = true; }
      await ensureTable(db, table, row);
      const cols = Object.keys(row).filter((c) => c !== 'version');
      const placeholders = cols.map(() => '?').join(',');
      try {
        db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(k => (row as any)[k]));
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) { throw new SyncError('CONFLICT', 'duplicate', { constraint: 'unique', column: 'id' }); }
        throw e;
      }
      dirtySinceExport = dirtySinceExport || !!filePath;
      // mirror version into meta if provided
      if (row.id != null && typeof row.version === 'number') {
        const pk = String(row.id);
        db.run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (?, ?, ?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version = excluded.version`, [table, pk, row.version]);
        dirtySinceExport = dirtySinceExport || !!filePath;
      }
      return { ...row };
    },
    async updateByPk(table: string, pk: PrimaryKey, set: Record<string, any>, opts?: { ifVersion?: number }) {
      const db = await ready;
      if (!metaEnsured) { db.run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`); metaEnsured = true; }
      const key = canonicalPk(pk);
      let g: any;
      const gSQL = `SELECT * FROM ${table} WHERE id = ? LIMIT 1`;
      try { g = acquireStmt(db, gSQL); }
      catch (err: any) { throw new SyncError('NOT_FOUND', 'not found'); }
      g.bind([key]); const cur = g.step() ? g.getAsObject() : null; releaseStmt(gSQL, g);
      if (!cur) { throw new SyncError('NOT_FOUND', 'not found'); }
      if (opts?.ifVersion != null) {
        const vSQL = `SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`;
        const v = acquireStmt(db, vSQL);
        v.bind([table, key]); const has = v.step(); const metaVer = has ? (v.getAsObject() as any).version : null; releaseStmt(vSQL, v);
        if (metaVer != null && metaVer !== opts.ifVersion) { throw new SyncError('CONFLICT', 'Version mismatch', { expectedVersion: opts.ifVersion, actualVersion: metaVer }); }
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
      dirtySinceExport = dirtySinceExport || !!filePath;
      const outSQL = `SELECT * FROM ${table} WHERE id = ? LIMIT 1`;
      const out = acquireStmt(db, outSQL);
      out.bind([key]); const row = out.step() ? out.getAsObject() : null; releaseStmt(outSQL, out);
      if (!row) { throw new SyncError('NOT_FOUND', 'not found'); }
      // augment with version from meta
      const v2SQL = `SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`;
      const v2 = acquireStmt(db, v2SQL);
      v2.bind([table, key]); const has2 = v2.step(); const verOut = has2 ? (v2.getAsObject() as any).version : undefined; releaseStmt(v2SQL, v2);
      return { ...(row as any), ...(verOut != null ? { version: verOut } : {}) } as any;
    },
    async deleteByPk(table: string, pk: PrimaryKey) {
      const db = await ready;
      const key = canonicalPk(pk);
      let s: any;
      const dSQL = `SELECT id FROM ${table} WHERE id = ? LIMIT 1`;
      try { s = acquireStmt(db, dSQL); }
      catch (err: any) { throw new SyncError('NOT_FOUND', 'not found'); }
      s.bind([key]); const existed = s.step(); releaseStmt(dSQL, s);
      if (!existed) { throw new SyncError('NOT_FOUND', 'not found'); }
      db.run(`DELETE FROM ${table} WHERE id = ?`, [key]);
      if (!metaEnsured) { db.run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`); metaEnsured = true; }
      db.run(`DELETE FROM _sync_versions WHERE table_name = ? AND pk_canonical = ?`, [table, key]);
      dirtySinceExport = dirtySinceExport || !!filePath;
      return { ok: true } as const;
    },
    async selectByPk(table: string, pk: PrimaryKey, select?: string[]) {
      const db = await ready;
      await ensureMinimalTable(db, table);
      const key = canonicalPk(pk);
      const sSQL = `SELECT * FROM ${table} WHERE id = ? LIMIT 1`;
      const s = acquireStmt(db, sSQL);
      s.bind([key]); const row = s.step() ? s.getAsObject() : null; releaseStmt(sSQL, s);
      if (!row) return null;
      const vSQL = `SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`;
      const v = acquireStmt(db, vSQL);
      v.bind([table, key]); const has = v.step(); const ver = has ? (v.getAsObject() as any).version : undefined; releaseStmt(vSQL, v);
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
      const cur = decodeWindowCursor(req.cursor);
      if (cur.lastId) {
        if (keys.length === 1 && keys[0] === 'updatedAt' && (orderBy as any).updatedAt === 'desc') {
          let lastUpdated: number | null = (cur.lastKeys as any)?.updatedAt as any;
          if (lastUpdated == null) {
            const lSQL = `SELECT updatedAt FROM ${table} WHERE id = ? LIMIT 1`;
            const s = acquireStmt(db, lSQL);
            s.bind([cur.lastId]); const has = s.step(); const obj = has ? s.getAsObject() as any : {}; releaseStmt(lSQL, s);
            lastUpdated = obj.updatedAt ?? 0;
          }
          sql += ` WHERE (t.updatedAt < ?) OR (t.updatedAt = ? AND t.id > ?)`; params.push(lastUpdated, lastUpdated, cur.lastId);
        } else {
          sql += ` WHERE t.id > ?`; params.push(cur.lastId);
        }
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
        const last = out[out.length - 1] as any;
        const lastKeys: Record<string, string | number> = {};
        for (const k of keys) lastKeys[k] = last[k];
        nextCursor = encodeWindowCursor({ table, orderBy, last: { keys: lastKeys, id: String(last.id) } });
      }
      return { data: out, nextCursor };
    }
  };
}

// canonicalPk is provided by utils

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
      if (!t || !t.has(key)) { throw new SyncError('NOT_FOUND', 'not found'); }
      const cur = t.get(key);
      if (opts?.ifVersion && cur.version !== opts.ifVersion) { throw new SyncError('CONFLICT', 'Version mismatch', { expectedVersion: opts.ifVersion, actualVersion: cur.version }); }
      const now = Date.now();
      const out = { ...cur, ...set, updatedAt: now, version: (cur.version ?? 0) + 1 };
      t.set(key, out);
      return out;
    },
    async deleteByPk(table: string, pk: PrimaryKey) {
      const t = tables.get(table);
      const key = canonicalPk(pk);
      if (!t || !t.has(key)) { throw new SyncError('NOT_FOUND', 'not found'); }
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
      {
        const { lastId } = decodeWindowCursor(req.cursor);
        if (lastId) {
          const idx = rows.findIndex(r => String(r.id) === String(lastId));
          if (idx >= 0) start = idx + 1;
        }
      }
      const page = rows.slice(start, start + limit);
      let nextCursor: string | null = null;
      if ((start + limit) < rows.length && page.length > 0) {
        const last = page[page.length - 1] as any;
        const lastKeys: Record<string, string | number> = {};
        for (const k of keys) lastKeys[k] = last[k];
        nextCursor = encodeWindowCursor({ table, orderBy, last: { keys: lastKeys, id: String(last.id) } });
      }
      return { data: page, nextCursor };
    }
  };
}
