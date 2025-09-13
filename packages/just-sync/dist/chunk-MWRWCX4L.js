import {
  __publicField
} from "./chunk-V6TY7KAL.js";

// src/index.ts
import { ulid } from "ulid";
var RingBuffer = class {
  constructor(maxAgeMs, maxEvents) {
    this.maxAgeMs = maxAgeMs;
    this.maxEvents = maxEvents;
    __publicField(this, "buffer", []);
  }
  push(value) {
    const id = ulid();
    const now = Date.now();
    this.buffer.push({ id, value });
    const cutoff = now - this.maxAgeMs;
    while (this.buffer.length > this.maxEvents) this.buffer.shift();
    return id;
  }
  since(lastId) {
    if (!lastId) return this.buffer.slice();
    const idx = this.buffer.findIndex((e) => e.id === lastId);
    if (idx === -1) return this.buffer.slice();
    return this.buffer.slice(idx + 1);
  }
};
function json(data, init) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
    ...init
  });
}
function error(code, message, details, init) {
  return json({ code, message, details }, { status: init?.status ?? (code === "BAD_REQUEST" ? 400 : code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 500) });
}
function createSync(opts) {
  const mutators = { ...opts.mutators ?? {} };
  const idStore = opts.idempotency ?? {
    async get() {
      return { status: "miss" };
    },
    async set() {
      return;
    }
  };
  const buffer = new RingBuffer(
    (opts.sse?.bufferSeconds ?? 60) * 1e3,
    opts.sse?.bufferMaxEvents ?? 1e4
  );
  async function handleEvents(req) {
    const last = req.headers.get("last-event-id") || void 0;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const back = buffer.since(last);
        for (const e of back) {
          controller.enqueue(enc.encode(`id: ${e.id}
`));
          controller.enqueue(enc.encode(`event: mutation
`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e.value ?? e)}

`));
        }
        const heartbeatMs = opts.sse?.heartbeatMs ?? 15e3;
        const iv = setInterval(() => controller.enqueue(enc.encode(`:keepalive

`)), heartbeatMs);
        controller._iv = iv;
      },
      cancel() {
        const iv = this._iv;
        if (iv) clearInterval(iv);
      }
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      }
    });
  }
  async function handleSelect(body) {
    try {
      const limit = Math.min(1e3, Math.max(1, body.limit ?? 100));
      const orderBy = body.orderBy ?? { updatedAt: "desc" };
      const res = await opts.database.selectWindow(body.table, { select: body.select, orderBy, limit, cursor: body.cursor ?? null, where: body.where });
      return json({ data: res.data, nextCursor: res.nextCursor ?? null });
    } catch (e) {
      return error("INTERNAL", "Unhandled select error");
    }
  }
  async function runMutation(op) {
    switch (op.op) {
      case "insert": {
        const rows = Array.isArray(op.rows) ? op.rows : [op.rows];
        const inserted = [];
        await opts.database.begin();
        try {
          for (const r of rows) {
            inserted.push(await opts.database.insert(op.table, r));
          }
          await opts.database.commit();
        } catch (e) {
          await opts.database.rollback();
          throw e;
        }
        if (Array.isArray(op.rows)) return { rows: inserted };
        return { row: inserted[0] };
      }
      case "update": {
        const row = await opts.database.updateByPk(op.table, op.pk, op.set, { ifVersion: op.ifVersion });
        return { row };
      }
      case "delete": {
        await opts.database.deleteByPk(op.table, op.pk);
        return { ok: true };
      }
      case "upsert": {
        const rows = Array.isArray(op.rows) ? op.rows : [op.rows];
        const results = [];
        await opts.database.begin();
        try {
          for (const r of rows) {
            try {
              results.push(await opts.database.insert(op.table, r));
            } catch {
              const pk = r.id ?? r;
              results.push(await opts.database.updateByPk(op.table, pk, r, {}));
            }
          }
          await opts.database.commit();
        } catch (e) {
          await opts.database.rollback();
          throw e;
        }
        if (Array.isArray(op.rows)) return { rows: results };
        return { row: results[0] };
      }
      case "updateWhere":
      case "deleteWhere": {
        throw Object.assign(new Error("updateWhere/deleteWhere require client-resolved PKs in MVP"), { code: "BAD_REQUEST" });
      }
      default:
        throw Object.assign(new Error("Unknown op"), { code: "BAD_REQUEST" });
    }
  }
  async function handleMutate(body) {
    const idemKey = body.clientOpId ? `op:${body.clientOpId}` : null;
    if (idemKey) {
      const g = await idStore.get(idemKey);
      if (g.status === "hit") return json(g.response);
    }
    try {
      const res = await runMutation(body);
      const event = {
        eventId: "",
        txId: ulid(),
        tables: [{ name: body.table, type: "mutation", pks: "pk" in body ? [body.pk] : [] }]
      };
      const eid = buffer.push(event);
      event.eventId = eid;
      if (idemKey) await idStore.set(idemKey, res, 10 * 60 * 1e3);
      return json(res);
    } catch (e) {
      if (e && e.code === "BAD_REQUEST") return error("BAD_REQUEST", e.message);
      if (e && e.code === "CONFLICT") return error("CONFLICT", e.message, e.details);
      return error("INTERNAL", "Unhandled mutate error");
    }
  }
  async function handleMutator(name, body) {
    const m = mutators[name];
    if (!m) return error("NOT_FOUND", `Mutator ${name} not found`);
    try {
      const result = await m.handler({ db: opts.database, ctx: {} }, body.args);
      return json({ result });
    } catch (e) {
      return error("INTERNAL", e?.message || "Mutator error");
    }
  }
  async function handler(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/events")) return handleEvents(req);
    if (req.method === "POST" && url.pathname.endsWith("/select")) {
      const body = await req.json();
      return handleSelect(body);
    }
    if (req.method === "POST" && url.pathname.endsWith("/mutate")) {
      const body = await req.json();
      return handleMutate(body);
    }
    if (req.method === "POST" && url.pathname.includes("/mutators/")) {
      const name = url.pathname.split("/").pop();
      const body = await req.json();
      return handleMutator(name, body);
    }
    return error("NOT_FOUND", "Route not found");
  }
  return {
    handler,
    fetch: handler,
    defineMutators(m) {
      Object.assign(mutators, m);
      return mutators;
    },
    $mutators: mutators
  };
}
function createClient(opts) {
  const baseURL = opts.baseURL.replace(/\/$/, "");
  const datastore = opts.datastore ?? createMemoryDatastore();
  const realtime = opts.realtime ?? "sse";
  async function post(path, body) {
    const res = await fetch(`${baseURL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  function table(name) {
    return {
      async select(pkOrQuery) {
        if (typeof pkOrQuery === "string" || typeof pkOrQuery === "number" || pkOrQuery && typeof pkOrQuery === "object" && !("table" in pkOrQuery)) {
          const row = await datastore.readByPk(name, pkOrQuery);
          if (row) return row;
          const res2 = await post("/select", { table: name, where: void 0, select: void 0, orderBy: { updatedAt: "desc" }, limit: 1 });
          return res2.data[0] ?? null;
        }
        const req = pkOrQuery;
        const res = await post("/select", { ...req, table: name });
        return res;
      },
      async insert(row) {
        const clientOpId = ulid();
        const tempId = `temp_${clientOpId}`;
        await datastore.apply(name, tempId, { set: row });
        try {
          const res = await post("/mutate", { op: "insert", table: name, rows: row, clientOpId });
          const inserted = res.row ?? (res.rows && res.rows[0]);
          await datastore.reconcile(name, inserted.id ?? tempId, inserted);
          return inserted;
        } catch (e) {
          await datastore.apply(name, tempId, { unset: Object.keys(row) });
          throw e;
        }
      },
      async update(pk, set, opts2) {
        const clientOpId = ulid();
        await datastore.apply(name, pk, { set });
        try {
          const res = await post("/mutate", { op: "update", table: name, pk, set, ifVersion: opts2?.ifVersion, clientOpId });
          const row = res.row;
          await datastore.reconcile(name, pk, row);
          return row;
        } catch (e) {
          throw e;
        }
      },
      async delete(pk) {
        const clientOpId = ulid();
        await datastore.apply(name, pk, { unset: ["__deleted__"] });
        try {
          await post("/mutate", { op: "delete", table: name, pk, clientOpId });
          return { ok: true };
        } catch (e) {
          throw e;
        }
      },
      async upsert(rowOrRows, options) {
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        const clientOpId = ulid();
        for (const r of rows) {
          const pk = r && (r.id ?? r);
          await datastore.apply(name, pk, { set: r });
        }
        const res = await post("/mutate", { op: "upsert", table: name, rows, merge: options?.merge, clientOpId });
        const payload = res.rows ?? [res.row];
        for (const r of payload) {
          await datastore.reconcile(name, r.id, r);
        }
        return Array.isArray(rowOrRows) ? payload : payload[0];
      },
      watch(pkOrQuery, cb) {
        const state = { status: "connecting", error: void 0, snapshot: null };
        let es = null;
        let stopped = false;
        const base = baseURL;
        const startSse = () => {
          es = new EventSource(`${base}/events`);
          es.onopen = () => {
            state.status = "live";
          };
          es.onerror = () => {
            state.status = "retrying";
          };
          es.onmessage = async (ev) => {
            try {
              const data = JSON.parse(ev.data);
              const res = await post("/select", typeof pkOrQuery === "object" && "table" in pkOrQuery ? pkOrQuery : { table: name });
              state.snapshot = res;
              cb(res);
            } catch {
            }
          };
        };
        if (realtime === "sse") startSse();
        else if (realtime === "poll") {
          const iv = setInterval(async () => {
            if (stopped) return clearInterval(iv);
            const res = await post("/select", typeof pkOrQuery === "object" && "table" in pkOrQuery ? pkOrQuery : { table: name });
            cb(res);
          }, opts.pollIntervalMs ?? 1500);
        }
        return {
          unsubscribe() {
            stopped = true;
            if (es) es.close();
          },
          get status() {
            return state.status;
          },
          get error() {
            return state.error;
          },
          getSnapshot() {
            return state.snapshot;
          }
        };
      }
    };
  }
  const client = new Proxy({}, {
    get(_t, prop) {
      if (prop === "mutators") {
        return new Proxy({}, {
          get(_t2, name) {
            return async (args) => post(`/mutators/${String(name)}`, { args });
          }
        });
      }
      return table(String(prop));
    }
  });
  return client;
}
function createMemoryDatastore() {
  const store = /* @__PURE__ */ new Map();
  function canon(pk) {
    if (typeof pk === "string" || typeof pk === "number") return String(pk);
    return Object.keys(pk).sort().map((k) => `${k}=${String(pk[k])}`).join("|");
  }
  function ensure(table) {
    if (!store.has(table)) store.set(table, /* @__PURE__ */ new Map());
    return store.get(table);
  }
  return {
    async apply(table, pk, diff) {
      const m = ensure(table);
      const key = canon(pk);
      const current = m.get(key) ?? {};
      if (diff.set) Object.assign(current, diff.set);
      if (diff.unset) for (const f of diff.unset) delete current[f];
      m.set(key, current);
    },
    async reconcile(table, pk, row) {
      const m = ensure(table);
      const key = canon(pk);
      const existing = m.get(key);
      if (!existing || typeof existing.version !== "number" || row.version >= existing.version) {
        m.set(key, row);
      }
    },
    async readByPk(table, pk) {
      const m = ensure(table);
      return m.get(canon(pk)) ?? null;
    },
    async readWindow(table, req) {
      const m = ensure(table);
      const data = Array.from(m.values());
      return { data, nextCursor: null };
    }
  };
}

export {
  createSync,
  createClient,
  createMemoryDatastore
};
//# sourceMappingURL=chunk-MWRWCX4L.js.map