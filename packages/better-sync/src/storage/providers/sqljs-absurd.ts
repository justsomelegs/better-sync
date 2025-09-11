import { createRequire } from "node:module";
import initSqlJs from "@jlongster/sql.js";
import { SQLiteFS } from "absurd-sql";
import IndexedDBBackend from "absurd-sql/dist/indexeddb-backend.js";

export interface AbsurdOptions { dbName: string; useWorker?: "auto" | "always" | "never" }

/**
 * Creates an "absurd" key-value storage adapter backed by SQLite (sql.js + Absurd-SQL), optionally running in a Web Worker.
 *
 * Depending on options.useWorker and runtime capabilities, this returns an API that either proxies operations to a worker (RPC over postMessage) or uses an in-thread sql.js database persisted via an IndexedDB-backed filesystem.
 *
 * Behavior notes:
 * - Options.useWorker: "always" forces worker mode, "never" forces in-thread mode, "auto" uses a worker when the environment supports Worker and window.
 * - Data is persisted as JSON strings in a single table `kv(store TEXT, key TEXT, value TEXT, PRIMARY KEY(store, key))`.
 * - In worker mode, a worker is spawned from ./workers/absurd.worker.js and calls are proxied; in non-worker mode, sql.js is initialized, an IndexedDB-backed FS is mounted at /sql, and a SQLite file /sql/{dbName}.sqlite is opened.
 * - Values stored are JSON-serialized on put and JSON-parsed on get/list.
 *
 * @param options - Configuration for the adapter (see AbsurdOptions).
 * @returns An object with kind: "absurd", the supplied options, and async methods:
 *   - put(store, key, value): Promise<void>
 *   - get<T>(store, key): Promise<T | undefined>
 *   - del(store, key): Promise<void>
 *   - list<T>(store, opts?): Promise<Array<{ key: string; value: T }>>
 *   - clear(store): Promise<void>
 */
export function absurd(options: AbsurdOptions) {
  const useWorker = options.useWorker ?? "auto";
  const canUseWorker = typeof Worker !== "undefined" && typeof window !== "undefined";
  const shouldUseWorker = useWorker === "always" || (useWorker === "auto" && canUseWorker);
  if (shouldUseWorker) {
    const workerUrl = new URL("./workers/absurd.worker.js", import.meta.url);
    const w = new Worker(workerUrl, { type: "module" });
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    w.onmessage = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg && typeof msg.id === "number") {
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error)); else entry.resolve(msg.result);
        }
      }
    };
    // init
    w.postMessage({ id: 0, method: "init", args: [{ dbName: options.dbName }] });
    const call = (method: string, ...args: any[]) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, method, args });
    });
    return {
      kind: "absurd" as const,
      options,
      put(store: string, key: string, value: any) { return call("put", store, key, value) as Promise<void>; },
      get<T>(store: string, key: string) { return call("get", store, key) as Promise<T | undefined>; },
      del(store: string, key: string) { return call("del", store, key) as Promise<void>; },
      list<T>(store: string, opts?: { prefix?: string; limit?: number }) { return call("list", store, opts) as Promise<Array<{ key: string; value: T }>>; },
      clear(store: string) { return call("clear", store) as Promise<void>; },
    };
  }
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