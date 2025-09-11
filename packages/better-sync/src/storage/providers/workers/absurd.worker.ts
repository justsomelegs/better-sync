import initSqlJs from "@jlongster/sql.js";
import { SQLiteFS } from "absurd-sql";
import IndexedDBBackend from "absurd-sql/dist/indexeddb-backend.js";

let db: any;

/**
 * Initialize and return the shared SQL.js database instance backed by IndexedDB (Absurd-SQL).
 *
 * Ensures a single SQL.Database is created and prepared for use: loads SQL.js, mounts an IndexedDB-backed filesystem at /sql,
 * opens/creates the SQLite file `/sql/{dbName}.sqlite`, applies performance PRAGMA settings, and ensures the `kv` table exists.
 * On first initialization this function assigns the database to the module-level `db` variable.
 *
 * @param dbName - Base name for the SQLite file (the function uses `/sql/{dbName}.sqlite`).
 * @returns A promise that resolves to the initialized SQL.Database instance.
 */
async function ensureDb(dbName: string) {
  if (db) return db;
  const SQL = await initSqlJs({ locateFile: (f: string) => new URL(`../../../node_modules/@jlongster/sql.js/dist/${f}`, (self as any).location as any).toString() });
  const sqlFS = new SQLiteFS(SQL.FS, new IndexedDBBackend());
  (SQL as any).register_for_idb(sqlFS);
  SQL.FS.mkdir("/sql");
  SQL.FS.mount(sqlFS, {}, "/sql");
  const path = `/sql/${dbName}.sqlite`;
  // Fallback in non-SAB environments
  const stream = SQL.FS.open(path, "a+");
  await (stream as any).node.contents.readIfFallback?.();
  SQL.FS.close(stream);
  db = new SQL.Database(path, { filename: true });
  db.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;");
  db.exec("CREATE TABLE IF NOT EXISTS kv (store TEXT, key TEXT, value TEXT, PRIMARY KEY(store, key));");
  return db;
}

self.onmessage = async (ev: MessageEvent) => {
  const { id, method, args } = (ev.data || {}) as { id: number; method: string; args: any[] };
  try {
    if (method === "init") { await ensureDb(args[0]?.dbName ?? "app"); return self.postMessage({ id, result: true }); }
    if (!db) await ensureDb("app");
    if (method === "put") { const [store, key, value] = args; db.run("INSERT OR REPLACE INTO kv (store, key, value) VALUES (?, ?, ?)", [store, key, JSON.stringify(value)]); return self.postMessage({ id, result: true }); }
    if (method === "get") { const [store, key] = args; const stmt = db.prepare("SELECT value FROM kv WHERE store = ? AND key = ? LIMIT 1"); try { const ok = stmt.bind([store, key]) && stmt.step(); return self.postMessage({ id, result: ok ? JSON.parse(String(stmt.get()[0])) : undefined }); } finally { stmt.free(); } }
    if (method === "del") { const [store, key] = args; db.run("DELETE FROM kv WHERE store = ? AND key = ?", [store, key]); return self.postMessage({ id, result: true }); }
    if (method === "list") { const [store, opts] = args; const prefix = String(opts?.prefix ?? ""); const limit = opts?.limit ?? -1; const stmt = db.prepare("SELECT key, value FROM kv WHERE store = ? AND key LIKE ? || '%' " + (limit > 0 ? "LIMIT ?" : "")); try { const params: any[] = [store, prefix]; if (limit > 0) params.push(limit); stmt.bind(params); const out: any[] = []; while (stmt.step()) { const row = stmt.get(); out.push({ key: String(row[0]), value: JSON.parse(String(row[1])) }); } return self.postMessage({ id, result: out }); } finally { stmt.free(); } }
    if (method === "clear") { const [store] = args; db.run("DELETE FROM kv WHERE store = ?", [store]); return self.postMessage({ id, result: true }); }
    return self.postMessage({ id, error: `Unknown method ${method}` });
  } catch (e: any) {
    return self.postMessage({ id, error: e?.message ?? String(e) });
  }
};