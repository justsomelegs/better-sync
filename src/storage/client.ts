import initSqlJs from 'sql.js';

export type LocalStore = {
  apply(changes: { table: string; type: 'insert'|'update'|'delete'; row?: Record<string, unknown>; pk?: string|number|Record<string, unknown> }[]): Promise<void>;
  reconcile(): Promise<void>;
  readByPk(table: string, pk: string|number|Record<string, unknown>): Promise<Record<string, unknown>|null>;
  readWindow(table: string, q?: { limit?: number; orderBy?: Record<string,'asc'|'desc'>; cursor?: string|null }): Promise<{ data: Record<string, unknown>[]; nextCursor: string|null }>;
};

export function memory(): LocalStore {
  const tables = new Map<string, Map<string, any>>();
  function t(name: string) { let m = tables.get(name); if (!m) { m = new Map(); tables.set(name, m); } return m; }
  return {
    async apply(changes) {
      for (const c of changes) {
        if (c.type === 'insert' && c.row) t(c.table).set(String((c.row as any).id), c.row);
        if (c.type === 'update' && c.row) t(c.table).set(String((c.row as any).id), { ...(t(c.table).get(String((c.row as any).id)) || {}), ...c.row });
        if (c.type === 'delete' && c.pk) t(c.table).delete(String(c.pk as any));
      }
    },
    async reconcile() {},
    async readByPk(table, pk) { return t(table).get(String(pk)) ?? null; },
    async readWindow(table, q) {
      const arr = Array.from(t(table).values());
      arr.sort((a,b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const limit = q?.limit ?? 100;
      const start = q?.cursor ? Math.max(0, arr.findIndex(r => String(r.id) === String(q.cursor)) + 1) : 0;
      const page = arr.slice(start, start + limit);
      const nextCursor = (start + limit) < arr.length ? String(page[page.length-1]?.id ?? '') : null;
      return { data: page, nextCursor };
    }
  };
}

export async function absurd(): Promise<LocalStore> {
  const hasBrowserWorker = typeof globalThis !== 'undefined'
    && typeof (globalThis as any).Worker === 'function'
    && typeof (globalThis as any).Blob === 'function'
    && typeof (globalThis as any).URL?.createObjectURL === 'function';
  if (hasBrowserWorker) {
    // Prefer web worker in browser contexts
    const worker = createInlineAbsurdWorker();
    return createAbsurdWorkerStore(worker);
  }
  // Fallback: run sql.js on the current thread (Node or non-workerable env)
  const SQL = await initSqlJs({ locateFile: (f: string) => `node_modules/sql.js/dist/${f}` });
  const db = new SQL.Database();
  // minimal schema: users can create their own tables; we ensure metadata for versions if desired later
  return {
    async apply(changes) {
      // naive: derive table columns from row keys, upsert by id for insert/update, delete by id
      for (const c of changes) {
        if (c.type === 'insert' && c.row) {
          const cols = Object.keys(c.row);
          const placeholders = cols.map(() => '?').join(',');
          const sql = `INSERT OR REPLACE INTO ${c.table} (${cols.join(',')}) VALUES (${placeholders})`;
          try { db.run(sql, cols.map((k) => (c.row as any)[k])); } catch {
            // try to create table then retry
            const defs = cols.map((k) => `${k} TEXT`).join(',');
            db.run(`CREATE TABLE IF NOT EXISTS ${c.table} (${defs})`);
            db.run(sql, cols.map((k) => (c.row as any)[k]));
          }
        } else if (c.type === "update" && c.row) {
          const cols = Object.keys(c.row);
          const sets = cols.map((k) => `${k} = ?`).join(',');
          const sql = `UPDATE ${c.table} SET ${sets} WHERE id = ?`;
          db.run(sql, [...cols.map((k) => (c.row as any)[k]), (c.row as any).id]);
        } else if (c.type === 'delete' && c.pk) {
          db.run(`DELETE FROM ${c.table} WHERE id = ?`, [String(c.pk as any)]);
        }
      }
    },
    async reconcile() {},
    async readByPk(table, pk) {
      const stmt = db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`);
      const res: any[] = [];
      stmt.bind([String(pk)]);
      while (stmt.step()) res.push(stmt.getAsObject());
      stmt.free();
      return res[0] ?? null;
    },
    async readWindow(table, q) {
      const limit = q?.limit ?? 100;
      let sql = `SELECT * FROM ${table}`;
      const params: any[] = [];
      if (q?.cursor) {
        sql += ` WHERE updatedAt < ?`;
        params.push(await getUpdatedAtById(db, table, String(q.cursor)) ?? 0);
      }
      sql += ` ORDER BY updatedAt DESC, id ASC LIMIT ?`;
      params.push(limit);
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const out: any[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      stmt.free();
      const nextCursor = out.length === limit ? String(out[out.length-1]?.id ?? '') : null;
      return { data: out, nextCursor };
    }
  };
}

async function getUpdatedAtById(db: any, table: string, id: string) {
  const stmt = db.prepare(`SELECT updatedAt FROM ${table} WHERE id = ? LIMIT 1`);
  stmt.bind([id]);
  let val: number | null = null;
  if (stmt.step()) val = (stmt.getAsObject() as any).updatedAt ?? null;
  stmt.free();
  return val;
}

function createAbsurdWorkerStore(worker: any): LocalStore {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const onMessage = (e: any) => {
    const msg = e?.data ?? e;
    if (msg && typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'Worker error'));
      }
    }
  };
  if (typeof worker.addEventListener === 'function') worker.addEventListener('message', onMessage);
  else worker.onmessage = onMessage;
  function call(method: string, ...args: any[]) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  }
  return {
    async apply(changes) { await call('apply', changes); },
    async reconcile() { await call('reconcile'); },
    async readByPk(table, pk) { return call('readByPk', table, pk) as Promise<any>; },
    async readWindow(table, q) { return call('readWindow', table, q) as Promise<any>; }
  };
}

function createInlineAbsurdWorker(opts?: { sqlJsCdn?: string }): any {
  const base = (opts?.sqlJsCdn ?? 'https://unpkg.com/sql.js@1.10.3/dist').replace(/\/$/, '');
  const code = `
    self.addEventListener('message', (e) => { /* wait for init */ });
    (async function(){
      importScripts('${base}/sql-wasm.js');
      const SQL = await self.initSqlJs({ locateFile: (f) => '${base}/' + f });
      const db = new SQL.Database();
      async function getUpdatedAtById(table, id) {
        const stmt = db.prepare('SELECT updatedAt FROM ' + table + ' WHERE id = ? LIMIT 1');
        stmt.bind([String(id)]);
        let val = null; if (stmt.step()) val = stmt.getAsObject().updatedAt ?? null; stmt.free(); return val;
      }
      const api = {
        async apply(changes){
          for (const c of changes) {
            if (c.type === 'insert' && c.row) {
              const cols = Object.keys(c.row);
              const placeholders = cols.map(() => '?').join(',');
              const sql = 'INSERT OR REPLACE INTO ' + c.table + ' (' + cols.join(',') + ') VALUES (' + placeholders + ')';
              try { db.run(sql, cols.map((k) => c.row[k])); } catch {
                const defs = cols.map((k) => k + ' TEXT').join(',');
                db.run('CREATE TABLE IF NOT EXISTS ' + c.table + ' (' + defs + ')');
                db.run(sql, cols.map((k) => c.row[k]));
              }
            } else if (c.type === 'update' && c.row) {
              const cols = Object.keys(c.row);
              const sets = cols.map((k) => k + ' = ?').join(',');
              const sql = 'UPDATE ' + c.table + ' SET ' + sets + ' WHERE id = ?';
              db.run(sql, cols.map((k) => c.row[k]).concat([c.row.id]));
            } else if (c.type === 'delete' && c.pk) {
              db.run('DELETE FROM ' + c.table + ' WHERE id = ?', [String(c.pk)]);
            }
          }
        },
        async reconcile(){},
        async readByPk(table, pk){
          const stmt = db.prepare('SELECT * FROM ' + table + ' WHERE id = ? LIMIT 1');
          const res = []; stmt.bind([String(pk)]); while (stmt.step()) res.push(stmt.getAsObject()); stmt.free();
          return res[0] ?? null;
        },
        async readWindow(table, q){
          const limit = (q && q.limit) || 100;
          let sql = 'SELECT * FROM ' + table; const params = [];
          if (q && q.cursor) { sql += ' WHERE updatedAt < ?'; params.push((await getUpdatedAtById(table, String(q.cursor))) || 0); }
          sql += ' ORDER BY updatedAt DESC, id ASC LIMIT ?'; params.push(limit);
          const stmt = db.prepare(sql); stmt.bind(params);
          const out = []; while (stmt.step()) out.push(stmt.getAsObject()); stmt.free();
          const nextCursor = out.length === limit ? String((out[out.length-1] && out[out.length-1].id) || '') : null;
          return { data: out, nextCursor };
        }
      };
      self.onmessage = async (e) => {
        const msg = e && e.data || {};
        const id = msg.id; const method = msg.method; const args = msg.args || [];
        try { const result = await api[method](...args); self.postMessage({ id, ok: true, result }); }
        catch (err) { self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
      };
      self.postMessage({ ready: true });
    })();
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const WorkerCtor = (globalThis as any).Worker;
  return new WorkerCtor(url);
}
