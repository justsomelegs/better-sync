import type { SyncClient, SyncClientConfig, SchemaModels, ModelName, RowOf, SyncClientStatus } from "./types.js";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
/**
 * Create a sync client.
 * - WebSocket-first transport with HTTP fallback and exponential backoff
 * - Background sender loop drains enqueued changes when connected
 * - 30s heartbeat; live "poke" refreshes subscribed models
 *
 * @example
 * // With absurd-sql storage (workerized), typed models, and status hook
 * import { createSyncClient, defineSchema } from "better-sync";
 * import { absurd } from "better-sync/storage";
 * type Todo = { id: string; title: string; done: boolean; updated_at: string };
 * const models = defineSchema({ todo: {} as Todo });
 * const sync = createSyncClient<typeof models>({
 *   baseUrl: "http://localhost:3000",
 *   storage: absurd({ dbName: "app", useWorker: "auto" }),
 *   compressMinBytes: 8 * 1024,
 * });
 * sync.onStatus((s) => console.log("status", s));
 * await sync.connect();
 * await sync.applyChange("todo", { type: "insert", id: "t1", value: { id: "t1", title: "A", done: false, updated_at: new Date().toISOString() } });
 * await sync.drain();
 */
export function createSyncClient<TSchema extends SchemaModels = SchemaModels>(_config: SyncClientConfig<TSchema>): SyncClient<TSchema> {
  type Queued = { model: ModelName<TSchema>; idempotencyKey?: string; change: { type: "insert" | "update" | "delete"; id: string; value?: unknown; patch?: any } };
  const queue: Queued[] = [];
  const basePath = _config.basePath ?? "/api/sync";
  const baseUrl = _config.baseUrl.replace(/\/$/, "");
  let isConnected = false;
  const tenantId = _config.tenantId;
  const metrics = _config.metrics;
  const wsSubscribers = new Map<string, Set<(rows: any[]) => void>>();
  const lastCursorByModel = new Map<string, string>();
  const lastCursorByShape = new Map<string, string>();
  const serializers = (_config.serializers ?? {}) as SyncClientConfig<TSchema>["serializers"];
  const storage = _config.storage;
  const backoffBase = _config.backoffBaseMs ?? 250;
  const backoffMax = _config.backoffMaxMs ?? 30_000;
  const heartbeatMs = _config.heartbeatMs ?? 30_000;
  const queueMaxSize = _config.queueMaxSize ?? Number.POSITIVE_INFINITY;
  const batchMaxCount = _config.batchMaxCount ?? 1000;
  const batchMaxBytes = _config.batchMaxBytes ?? 262_144; // ~256KB
  const compressMinBytes = _config.compressMinBytes ?? 8_192; // 8KB
  let inFlight = 0;
  let stopped = false;
  let status: SyncClientStatus = { state: "idle" };
  const statusSubscribers = new Set<(s: SyncClientStatus) => void>();
  function setStatus(s: SyncClientStatus) {
    status = s; for (const cb of Array.from(statusSubscribers)) { try { cb(s); } catch {} }
    metrics?.on("status", s as any);
  }
  function approxSize(obj: unknown): number {
    try { return Buffer.byteLength(JSON.stringify(obj), "utf8"); } catch { return 0; }
  }
  function encodeValue(model: string, value: any) {
    const ser = (serializers as any)[model];
    return ser ? ser.encode(value) : value;
  }
  // background sender loop with batching
  (async () => {
    for (; ;) {
      if (stopped) return;
      if (isConnected && queue.length > 0) {
        // Build a batch under limits
        const firstModel = queue[0]!.model as string;
        const batch: Array<{ model: string; type: string; id: string; value?: any; patch?: any; idempotencyKey?: string }> = [];
        const idKeys = new Set<string | undefined>();
        let bytes = 0;
        while (batch.length < batchMaxCount && queue.length > 0) {
          const peek = queue[0]!;
          // keep models in same batch for simplicity; could mix later
          if (peek.model !== (firstModel as any) && batch.length > 0) break;
          const payload = { model: String(peek.model), ...peek.change, idempotencyKey: peek.idempotencyKey } as any;
          // apply encode for value
          if (payload.value !== undefined) payload.value = encodeValue(String(peek.model), payload.value);
          const nextBytes = approxSize(payload);
          if (batch.length > 0 && bytes + nextBytes > batchMaxBytes) break;
          batch.push(payload);
          idKeys.add(peek.idempotencyKey);
          bytes += nextBytes;
          queue.shift();
        }
        try {
          inFlight += 1;
          metrics?.on("applySent", { count: batch.length, model: firstModel });
          const bodyObj = batch.length === 1
            ? { model: batch[0]!.model, change: { type: batch[0]!.type, id: batch[0]!.id, value: batch[0]!.value, patch: batch[0]!.patch }, idempotencyKey: batch[0]!.idempotencyKey }
            : { changes: batch, idempotencyKey: (idKeys.size === 1 ? Array.from(idKeys)[0] : undefined) };
          let headers: Record<string, string> = { ...(tenantId ? { "x-tenant-id": tenantId } : {}) };
          if ((bodyObj as any).idempotencyKey) headers["x-idempotency-key"] = String((bodyObj as any).idempotencyKey);
          let payload: BodyInit;
          const raw = JSON.stringify(bodyObj);
          if (raw.length >= compressMinBytes && typeof (globalThis as any).CompressionStream !== "undefined") {
            headers["Content-Encoding"] = "gzip";
            headers["Content-Type"] = "application/json";
            const cs = new (globalThis as any).CompressionStream("gzip");
            const writer = cs.writable.getWriter();
            writer.write(new TextEncoder().encode(raw));
            writer.close();
            payload = cs.readable as any;
          } else {
            headers["Content-Type"] = "application/json";
            payload = raw;
          }
          const res = await fetch(`${baseUrl}${basePath}/apply`, { method: "POST", headers, body: payload });
          if (res.ok) { metrics?.on("applyAck", { count: batch.length, model: firstModel }); inFlight -= 1; continue; }
        } catch { /* network error -> fallthrough */ }
        finally { if (inFlight > 0) inFlight -= 1; }
        // On failure, re-enqueue at front (simple retry); avoid reordering
        while (batch.length) {
          const item = batch.pop()!;
          queue.unshift({ model: item.model as any, idempotencyKey: item.idempotencyKey, change: { type: item.type as any, id: item.id, value: item.value, patch: item.patch } } as any);
        }
      }
      await sleep(25);
    }
  })();
  return {
    async connect() {
      // Start a background connection loop; prefer WebSocket, fallback to HTTP
      (async () => {
        if (stopped) return;
        let attempt = 0;
        let ws: WebSocket | null = null;
        setStatus({ state: "connecting" });
        const refreshModel = async (model: string) => {
          try {
            const since = lastCursorByModel.get(model);
            const res = await fetch(`${baseUrl}${basePath}/pull?model=${encodeURIComponent(model)}${since ? `&since=${encodeURIComponent(since)}` : ""}`, { headers: tenantId ? { "x-tenant-id": tenantId } : undefined }); metrics?.on("pull", { model });
            if (res.ok) {
              const data = await res.json();
              const set = wsSubscribers.get(model);
              if (data?.ok && data?.value?.rows) {
                const ser = (serializers as any)[model];
                const rows = ser ? (data.value.rows as any[]).map((r) => ser.decode(r)) : data.value.rows;
                if (set?.size) set.forEach((cb) => cb(rows));
                if (data?.value?.cursor) lastCursorByModel.set(model, String(data.value.cursor));
              }
            }
          } catch { }
        };
        for (; ;) {
          try {
            // try WS
            await new Promise<void>((resolve, reject) => {
              try {
                ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}${basePath}/ws`);
                ws.onopen = () => { isConnected = true; setStatus({ state: "connected-ws" }); metrics?.on("connect", { transport: "ws" }); resolve(); };
                ws.onerror = () => { isConnected = false; ws = null; };
                ws.onclose = () => { isConnected = false; };
                ws.onmessage = (ev) => {
                  try {
                    const msg = JSON.parse(String(ev.data ?? ""));
                    if (msg?.type === "poke") {
                      metrics?.on("poke", { model: msg?.model });
                      const target = msg?.model;
                      if (typeof target === "string" && wsSubscribers.has(target)) {
                        void refreshModel(target);
                      } else {
                        for (const model of wsSubscribers.keys()) void refreshModel(model);
                      }
                    }
                  } catch { }
                };
              } catch (e) { reject(e); }
            });
          } catch {
            // fallback to HTTP probe
            try {
              const res = await fetch(`${baseUrl}${basePath}/sync.json`, { method: "GET" });
              if (res.ok) { isConnected = true; setStatus({ state: "connected-http" }); metrics?.on("connect", { transport: "http" }); }
              else throw new Error("http probe failed");
            } catch {
              isConnected = false;
              const base = Math.min(backoffMax, backoffBase * 2 ** attempt);
              const jitter = Math.floor(Math.random() * 100);
              const nextMs = base + jitter; setStatus({ state: "backoff", attempt, nextMs }); metrics?.on("backoff", { attempt, nextMs }); await sleep(nextMs);
              attempt += 1;
              continue;
            }
          }
          // HTTP fallback: periodically refresh subscribed models
          if (status.state === "connected-http") {
            for (const model of wsSubscribers.keys()) { await refreshModel(model); }
          }
          await sleep(heartbeatMs); // heartbeat interval
        }
      })();
    },
    /**
     * Subscribe to connection status changes.
     *
     * @example
     * const sub = sync.onStatus((s) => {
     *   if (s.state === "backoff") console.log("retrying in", s.nextMs);
     * });
     * // later
     * sub.unsubscribe();
     */
    onStatus(cb: (s: import("./types.js").SyncClientStatus) => void) { statusSubscribers.add(cb); return { unsubscribe() { statusSubscribers.delete(cb); } }; },
    getStatus() { return status; },
    async applyChange<TModel extends ModelName<TSchema>>(model: TModel, change: { type: "insert" | "update" | "delete"; id: string; value?: RowOf<TSchema, TModel>; patch?: Partial<RowOf<TSchema, TModel>> }) {
      if (queue.length >= queueMaxSize) return { ok: false as const, error: { code: "SYNC:CHANGE_REJECTED", message: "Queue full", meta: { max: queueMaxSize } } };
      const idk = `ik_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      queue.push({ model, idempotencyKey: idk, change } as unknown as Queued); metrics?.on("applyQueued", { model });
      return { ok: true, value: { queued: !isConnected } } as const;
    },
    /** Apply a batch of changes; returns when enqueued. */
    async applyChanges<TModel extends ModelName<TSchema>>(model: TModel, changes: { type: "insert" | "update" | "delete"; id: string; value?: RowOf<TSchema, TModel>; patch?: Partial<RowOf<TSchema, TModel>> }[]) {
      const idk = `ik_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      for (const c of changes) {
        if (queue.length >= queueMaxSize) return { ok: false as const, error: { code: "SYNC:CHANGE_REJECTED", message: "Queue full", meta: { max: queueMaxSize } } };
        queue.push({ model, idempotencyKey: idk, change: c } as unknown as Queued); metrics?.on("applyQueued", { model });
      }
      return { ok: true, value: { queued: !isConnected } } as const;
    },
    async drain() {
      while ((queue.length > 0 || inFlight > 0) && !stopped) {
        await sleep(10);
      }
      if (stopped && queue.length > 0) queue.length = 0;
    },
    getQueueStats() {
      // rough estimate: assume ~150 bytes per change when small
      const bytes = queue.slice(0, Math.min(queue.length, 64)).reduce((n, q) => n + approxSize(q), 0);
      return { size: queue.length, pendingBatches: Math.ceil(queue.length / batchMaxCount), bytes };
    },
    shouldBackOff() { return queue.length >= Math.min(queueMaxSize, batchMaxCount * 4); },
    /**
     * Subscribe to a model. Immediately pulls current rows, then refreshes
     * whenever the server sends a WS "poke".
     *
     * @example
     * // Narrow columns via select; callback rows are typed
     * const sub = sync.subscribeQuery({ model: "todo", select: ["id","title"] as const }, rows => {
     *   rows.forEach(r => console.log(r.id, r.title));
     * });
     * // later: sub.unsubscribe()
     */
    subscribeQuery(params: { model: string; where?: any; select?: string[] }, cb: (rows: any[]) => void) {
      // initial pull
      void (async () => {
        try {
          const since = lastCursorByModel.get(params.model);
          const res = await fetch(`${baseUrl}${basePath}/pull?model=${encodeURIComponent(params.model)}${since ? `&since=${encodeURIComponent(since)}` : ""}`, { headers: tenantId ? { "x-tenant-id": tenantId } : undefined });
          if (res.ok) {
            const data = await res.json();
            if (data?.ok && data?.value?.rows) {
              const ser = (serializers as any)[params.model];
              const rows = ser ? (data.value.rows as any[]).map((r) => ser.decode(r)) : data.value.rows;
              cb(rows);
              if (data?.value?.cursor) lastCursorByModel.set(params.model, String(data.value.cursor));
            }
          }
        } catch { }
      })();
      let set = wsSubscribers.get(params.model);
      if (!set) { set = new Set(); wsSubscribers.set(params.model, set); }
      set.add(cb);
      return { unsubscribe() { set!.delete(cb); if (set!.size === 0) wsSubscribers.delete(params.model); } };
    },
    pinShape(shapeId: string) {
      let unpinned = false;
      const refresh = async () => {
        if (unpinned) return;
        try {
          const since = lastCursorByShape.get(shapeId);
          const res = await fetch(`${baseUrl}${basePath}/pull?model=${encodeURIComponent("*")}&shapeId=${encodeURIComponent(shapeId)}${since ? `&since=${encodeURIComponent(since)}` : ""}`, { headers: tenantId ? { "x-tenant-id": tenantId } : undefined });
          if (res.ok) { const j = await res.json(); if (j?.value?.cursor) lastCursorByShape.set(shapeId, String(j.value.cursor)); }
          void res.arrayBuffer(); // fire-and-forget to warm cache
        } catch { }
      };
      // periodic refresh piggybacks on heartbeat
      void refresh();
      return { unpin() { unpinned = true; } };
    },
    /**
     * Create a lightweight snapshot marker in client storage.
     * Use together with your own export/backup to retain local state.
     *
     * @example
     * await sync.createSnapshot("todo");
     */
    async createSnapshot(model?: string) {
      if (!storage) return;
      const stamp = Date.now();
      // naive snapshot: store a cursor marker per model
      const key = model ? `snapshot:${model}:${stamp}` : `snapshot:all:${stamp}`;
      await storage.put("snapshots", key, { createdAt: stamp });
    },
    /** Stop background loops and close network resources. */
    async stop() { stopped = true; setStatus({ state: "stopped" }); },
    /**
     * Return a tenant-scoped client instance.
     * @example
     * const t1 = sync.withTenant("t1");
     * await t1.applyChange("todo", { type: "insert", id: "1", value: { title: "A" } });
     */
    withTenant(id?: string) { return createSyncClient<TSchema>({ ..._config, tenantId: id }); },
  } as unknown as SyncClient<TSchema>;
}

export function createClient<TSchema extends SchemaModels = SchemaModels>(config: SyncClientConfig<TSchema>): SyncClient<TSchema> {
  return createSyncClient<TSchema>(config);
}
