import "../../chunk-V6TY7KAL.js";

// src/storage/server/index.ts
import { ulid } from "ulid";
function pkCanon(pk) {
  if (typeof pk === "string" || typeof pk === "number") return String(pk);
  return Object.keys(pk).sort().map((k) => `${k}=${String(pk[k])}`).join("|");
}
function sqliteAdapter(opts) {
  const tables = /* @__PURE__ */ new Map();
  const versions = /* @__PURE__ */ new Map();
  function ensure(table) {
    if (!tables.has(table)) tables.set(table, /* @__PURE__ */ new Map());
    return tables.get(table);
  }
  function ensureVer(table) {
    if (!versions.has(table)) versions.set(table, /* @__PURE__ */ new Map());
    return versions.get(table);
  }
  let inTx = false;
  return {
    async begin() {
      if (inTx) throw Object.assign(new Error("Nested tx not supported"), { code: "INTERNAL" });
      inTx = true;
    },
    async commit() {
      inTx = false;
    },
    async rollback() {
      inTx = false;
    },
    async insert(table, row) {
      const m = ensure(table);
      const v = ensureVer(table);
      const now = Date.now();
      const id = row.id && typeof row.id === "string" ? row.id : ulid();
      const key = pkCanon(id);
      if (m.has(key)) throw Object.assign(new Error("Unique conflict"), { code: "CONFLICT", details: { constraint: "unique", column: "id" } });
      const version = (v.get(key) ?? 0) + 1;
      v.set(key, version);
      const record = { ...row, id, updatedAt: now, version };
      m.set(key, record);
      return record;
    },
    async updateByPk(table, pk, set, opts2) {
      const m = ensure(table);
      const v = ensureVer(table);
      const key = pkCanon(pk);
      const existing = m.get(key);
      if (!existing) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", details: { pk } });
      const now = Date.now();
      const currentVersion = v.get(key) ?? existing.version ?? 0;
      if (opts2?.ifVersion != null && opts2.ifVersion !== currentVersion) {
        throw Object.assign(new Error("Version mismatch"), { code: "CONFLICT", details: { expectedVersion: opts2.ifVersion, actualVersion: currentVersion } });
      }
      const version = currentVersion + 1;
      v.set(key, version);
      const updated = { ...existing, ...set, updatedAt: now, version };
      m.set(key, updated);
      return updated;
    },
    async deleteByPk(table, pk) {
      const m = ensure(table);
      const v = ensureVer(table);
      const key = pkCanon(pk);
      if (!m.has(key)) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", details: { pk } });
      m.delete(key);
      v.delete(key);
      return { ok: true };
    },
    async selectByPk(table, pk, select) {
      const m = ensure(table);
      const row = m.get(pkCanon(pk)) ?? null;
      if (!row) return null;
      if (!select || select.length === 0) return { ...row };
      const out = {};
      for (const f of select) out[f] = row[f];
      return out;
    },
    async selectWindow(table, req) {
      const m = ensure(table);
      const all = Array.from(m.values());
      const order = req.orderBy ?? { updatedAt: "desc" };
      const keys = Object.keys(order);
      all.sort((a, b) => {
        for (const k of keys) {
          const dir = order[k] === "asc" ? 1 : -1;
          const av = a[k];
          const bv = b[k];
          if (av === bv) continue;
          return av > bv ? dir : -dir;
        }
        const aid = String(a.id ?? "");
        const bid = String(b.id ?? "");
        return aid.localeCompare(bid);
      });
      const limit = Math.min(1e3, Math.max(1, req.limit ?? 100));
      const data = all.slice(0, limit).map((r) => {
        if (!req.select || req.select.length === 0) return r;
        const o = {};
        for (const f of req.select) o[f] = r[f];
        return o;
      });
      return { data, nextCursor: null };
    }
  };
}
export {
  sqliteAdapter
};
//# sourceMappingURL=index.js.map