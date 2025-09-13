import type { DatabaseAdapter, PrimaryKey, SelectWindow } from '../../index.js';
import { ulid } from 'ulid';

type Row = Record<string, unknown> & { id?: string; updatedAt?: number; version?: number };

function pkCanon(pk: PrimaryKey): string {
  if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
  return Object.keys(pk).sort().map((k) => `${k}=${String((pk as any)[k])}`).join('|');
}

export function sqliteAdapter(opts: { url: string }): DatabaseAdapter {
  // MVP: provide an in-memory JS shim so library is usable without native deps; warn that this is not persistent.
  const tables = new Map<string, Map<string, Row>>();
  const versions = new Map<string, Map<string, number>>(); // _sync_versions
  function ensure(table: string) { if (!tables.has(table)) tables.set(table, new Map()); return tables.get(table)!; }
  function ensureVer(table: string) { if (!versions.has(table)) versions.set(table, new Map()); return versions.get(table)!; }
  let inTx = false;
  return {
    async begin() { if (inTx) throw Object.assign(new Error('Nested tx not supported'), { code: 'INTERNAL' }); inTx = true; },
    async commit() { inTx = false; },
    async rollback() { inTx = false; },
    async insert(table, row) {
      const m = ensure(table);
      const v = ensureVer(table);
      const now = Date.now();
      const id = (row as any).id && typeof (row as any).id === 'string' ? (row as any).id : ulid();
      const key = pkCanon(id);
      if (m.has(key)) throw Object.assign(new Error('Unique conflict'), { code: 'CONFLICT', details: { constraint: 'unique', column: 'id' } });
      const version = (v.get(key) ?? 0) + 1;
      v.set(key, version);
      const record: Row = { ...(row as any), id, updatedAt: now, version };
      m.set(key, record);
      return record;
    },
    async updateByPk(table, pk, set, opts) {
      const m = ensure(table);
      const v = ensureVer(table);
      const key = pkCanon(pk);
      const existing = m.get(key);
      if (!existing) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND', details: { pk } });
      const now = Date.now();
      const currentVersion = v.get(key) ?? existing.version ?? 0;
      if (opts?.ifVersion != null && opts.ifVersion !== currentVersion) {
        throw Object.assign(new Error('Version mismatch'), { code: 'CONFLICT', details: { expectedVersion: opts.ifVersion, actualVersion: currentVersion } });
      }
      const version = currentVersion + 1;
      v.set(key, version);
      const updated = { ...existing, ...set, updatedAt: now, version } as Row;
      m.set(key, updated);
      return updated;
    },
    async deleteByPk(table, pk) {
      const m = ensure(table);
      const v = ensureVer(table);
      const key = pkCanon(pk);
      if (!m.has(key)) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND', details: { pk } });
      m.delete(key);
      v.delete(key);
      return { ok: true } as const;
    },
    async selectByPk(table, pk, select) {
      const m = ensure(table);
      const row = m.get(pkCanon(pk)) ?? null;
      if (!row) return null;
      if (!select || select.length === 0) return { ...row };
      const out: Record<string, unknown> = {};
      for (const f of select) out[f] = (row as any)[f];
      return out as any;
    },
    async selectWindow(table, req) {
      const m = ensure(table);
      const all = Array.from(m.values());
      // MVP: ignore where (client-side), simple order and limit
      const order = req.orderBy ?? { updatedAt: 'desc' };
      const keys = Object.keys(order);
      all.sort((a, b) => {
        for (const k of keys) {
          const dir = order[k] === 'asc' ? 1 : -1;
          const av = (a as any)[k];
          const bv = (b as any)[k];
          if (av === bv) continue;
          return av > bv ? dir : -dir;
        }
        // tie-breaker by id
        const aid = String((a as any).id ?? '');
        const bid = String((b as any).id ?? '');
        return aid.localeCompare(bid);
      });
      const limit = Math.min(1000, Math.max(1, req.limit ?? 100));
      const data = all.slice(0, limit).map((r) => {
        if (!req.select || req.select.length === 0) return r;
        const o: Record<string, unknown> = {};
        for (const f of req.select) o[f] = (r as any)[f];
        return o as any;
      });
      return { data, nextCursor: null };
    }
  } as DatabaseAdapter;
}

