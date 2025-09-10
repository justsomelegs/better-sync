import { createRequire } from "node:module";
import initSqlJs from "@jlongster/sql.js";
import { SQLiteFS } from "absurd-sql";
import IndexedDBBackend from "absurd-sql/dist/indexeddb-backend.js";

export interface AbsurdOptions { dbName: string }

export function absurd(options: AbsurdOptions) {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const dbPromise = (async () => {
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    // Mount absurd-sql FS (IndexedDB-backed) to persist DB in browser
    const sqlFS = new SQLiteFS(SQL.FS, new IndexedDBBackend());
    SQL.register_for_idb(sqlFS);
    SQL.FS.mkdir("/sql");
    SQL.FS.mount(sqlFS, {}, "/sql");
    const path = `/sql/${options.dbName}.sqlite`;
    if (typeof (globalThis as any).SharedArrayBuffer === "undefined") {
      const stream = SQL.FS.open(path, "a+");
      await (stream as any).node.contents.readIfFallback?.();
      SQL.FS.close(stream);
    }
    const db = new SQL.Database(path, { filename: true });
    db.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;");
    db.exec("CREATE TABLE IF NOT EXISTS kv (store TEXT, key TEXT, value TEXT, PRIMARY KEY(store, key));");
    return db;
  })();
  return {
    kind: "absurd" as const,
    options,
    async put(store: string, key: string, value: any) {
      const db = await dbPromise;
      const json = JSON.stringify(value);
      db.run("INSERT OR REPLACE INTO kv (store, key, value) VALUES (?, ?, ?)", [store, key, json]);
    },
    async get<T>(store: string, key: string): Promise<T | undefined> {
      const db = await dbPromise;
      const stmt = db.prepare("SELECT value FROM kv WHERE store = ? AND key = ? LIMIT 1");
      try {
        const out: T | undefined = stmt.bind([store, key]) && stmt.step() ? JSON.parse(String(stmt.get()[0])) : undefined;
        return out;
      } finally { stmt.free(); }
    },
    async del(store: string, key: string) {
      const db = await dbPromise;
      db.run("DELETE FROM kv WHERE store = ? AND key = ?", [store, key]);
    },
    async list<T>(store: string, opts?: { prefix?: string; limit?: number }) {
      const db = await dbPromise;
      const prefix = String(opts?.prefix ?? "");
      const limit = opts?.limit ?? -1;
      const stmt = db.prepare("SELECT key, value FROM kv WHERE store = ? AND key LIKE ? || '%' " + (limit > 0 ? "LIMIT ?" : ""));
      try {
        const params: any[] = [store, prefix]; if (limit > 0) params.push(limit);
        stmt.bind(params);
        const out: Array<{ key: string; value: T }> = [];
        while (stmt.step()) {
          const row = stmt.get();
          out.push({ key: String(row[0]), value: JSON.parse(String(row[1])) });
        }
        return out;
      } finally { stmt.free(); }
    },
    async clear(store: string) {
      const db = await dbPromise;
      db.run("DELETE FROM kv WHERE store = ?", [store]);
    },
  };
}