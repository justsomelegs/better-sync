import type { DatabaseAdapter, OrderBy, PrimaryKey, SelectWindow } from "../server";
import { ulid } from "ulid";

type Row = Record<string, unknown> & { id: string; updatedAt: number; version: number };

type TableStore = {
  byId: Map<string, Row>;
  versionCounter: number;
};

export function memoryAdapter(): DatabaseAdapter {
  const tables = new Map<string, TableStore>();
  let inTx = false;

  function getTable(name: string): TableStore {
    let t = tables.get(name);
    if (!t) {
      t = { byId: new Map(), versionCounter: 0 };
      tables.set(name, t);
    }
    return t;
  }

  function canonicalPk(pk: PrimaryKey): string {
    if (typeof pk === "string" || typeof pk === "number") return String(pk);
    return Object.keys(pk)
      .sort()
      .map((k) => `${k}=${String((pk as any)[k])}`)
      .join("|");
  }

  function applyOrder(data: Row[], orderBy?: OrderBy): Row[] {
    const ob = orderBy ?? { updatedAt: "desc" };
    const keys = Object.keys(ob);
    return data.sort((a, b) => {
      for (const k of keys) {
        const dir = ob[k]!;
        const av = a[k] as any;
        const bv = b[k] as any;
        if (av === bv) continue;
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
      }
      // Tie-breaker by id
      return String(a.id).localeCompare(String(b.id));
    });
  }

  return {
    async begin() {
      if (inTx) throw new Error("INTERNAL: nested transaction not supported");
      inTx = true;
    },
    async commit() {
      inTx = false;
    },
    async rollback() {
      inTx = false;
    },
    async insert(table: string, row: Record<string, unknown>) {
      const t = getTable(table);
      const id = (row as any).id ?? ulid();
      const now = Date.now();
      const version = ++t.versionCounter;
      const newRow: Row = { ...(row as any), id, updatedAt: now, version };
      t.byId.set(String(id), newRow);
      return { ...newRow };
    },
    async updateByPk(table: string, pk: PrimaryKey, set: Record<string, unknown>) {
      const t = getTable(table);
      const id = canonicalPk(pk);
      const existing = t.byId.get(id);
      if (!existing) throw new Error("NOT_FOUND: row");
      const now = Date.now();
      const version = ++t.versionCounter;
      const next: Row = { ...existing, ...set, updatedAt: now, version };
      t.byId.set(id, next);
      return { ...next };
    },
    async deleteByPk(table: string, pk: PrimaryKey) {
      const t = getTable(table);
      const id = canonicalPk(pk);
      t.byId.delete(id);
      return { ok: true } as const;
    },
    async selectByPk(table: string, pk: PrimaryKey, select?: string[]) {
      const t = getTable(table);
      const id = canonicalPk(pk);
      const row = t.byId.get(id);
      if (!row) return null;
      if (!select || select.length === 0) return { ...row };
      const out: Record<string, unknown> = {};
      for (const k of select) out[k] = (row as any)[k];
      return out;
    },
    async selectWindow(table: string, req: SelectWindow & { where?: unknown }) {
      const t = getTable(table);
      const limit = Math.max(1, Math.min(req.limit ?? 100, 1000));
      const rows = applyOrder(Array.from(t.byId.values()).map((r) => ({ ...r })), req.orderBy).slice(0, limit);
      if (!req.select || req.select.length === 0) return { data: rows, nextCursor: null };
      const data = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const k of req.select!) out[k] = (row as any)[k];
        return out;
      });
      return { data, nextCursor: null };
    }
  } satisfies DatabaseAdapter;
}

