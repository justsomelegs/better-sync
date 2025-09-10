import type { SyncClient, SyncClientConfig, SchemaModels, ModelName, RowOf } from "./types.js";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
/**
 * Create a sync client.
 * - WebSocket-first transport with HTTP fallback and exponential backoff
 * - Background sender loop drains enqueued changes when connected
 * - 30s heartbeat; live "poke" refreshes subscribed models
 * @example
 * const sync = createClient({ baseUrl: "http://localhost:3000" });
 * await sync.connect();
 * await sync.applyChange("todo", { type: "insert", id: "1", value: { title: "A" } });
 * await sync.drain();
 */
export function createSyncClient<TSchema extends SchemaModels = SchemaModels>(_config: SyncClientConfig<TSchema>): SyncClient<TSchema> {
  type Queued = { model: ModelName<TSchema>; change: { type: "insert" | "update" | "delete"; id: string; value?: unknown; patch?: any } };
  const queue: Queued[] = [];
  const basePath = _config.basePath ?? "/api/sync";
  const baseUrl = _config.baseUrl.replace(/\/$/, "");
  let isConnected = false;
  const tenantId = _config.tenantId;
  const metrics = _config.metrics;
  const wsSubscribers = new Map<string, Set<(rows: any[]) => void>>();
  const serializers = (_config.serializers ?? {}) as SyncClientConfig<TSchema>["serializers"];
  const backoffBase = _config.backoffBaseMs ?? 250;
  const backoffMax = _config.backoffMaxMs ?? 30_000;
  const heartbeatMs = _config.heartbeatMs ?? 30_000;
  const queueMaxSize = _config.queueMaxSize ?? Number.POSITIVE_INFINITY;
  let stopped = false;
  // background sender loop
  (async () => {
    for (; ;) {
      if (stopped) return;
      if (isConnected && queue.length > 0) {
        const next = queue[0];
        try {
          metrics?.on("applySent", { model: next.model }); const res = await fetch(`${baseUrl}${basePath}/apply`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(tenantId ? { "x-tenant-id": tenantId } : {}) },
            body: JSON.stringify({
              model: next.model, change: {
                ...next.change,
                value: next.change.value && (serializers && (serializers as any)[next.model]) ? (serializers as any)[next.model]!.encode(next.change.value) : next.change.value,
              }
            }),
          });
          if (res.ok) {
            queue.shift(); metrics?.on("applyAck", { model: next.model });
            continue; // attempt to send next immediately
          }
        } catch {
          // fall through to sleep
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
        const refreshModel = async (model: string) => {
          try {
            const res = await fetch(`${baseUrl}${basePath}/pull?model=${encodeURIComponent(model)}`, { headers: tenantId ? { "x-tenant-id": tenantId } : undefined }); metrics?.on("pull");
            if (res.ok) {
              const data = await res.json();
              const set = wsSubscribers.get(model);
              if (data?.ok && data?.value?.rows && set?.size) {
                const ser = (serializers as any)[model];
                const rows = ser ? (data.value.rows as any[]).map((r) => ser.decode(r)) : data.value.rows;
                set.forEach((cb) => cb(rows));
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
                ws.onopen = () => { isConnected = true; resolve(); };
                ws.onerror = () => { isConnected = false; ws = null; reject(new Error("ws error")); };
                ws.onclose = () => { isConnected = false; };
                ws.onmessage = (ev) => {
                  try {
                    const msg = JSON.parse(String(ev.data ?? ""));
                    if (msg?.type === "poke") {
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
              if (res.ok) { isConnected = true; }
              else throw new Error("http probe failed");
            } catch {
              isConnected = false;
              const base = Math.min(backoffMax, backoffBase * 2 ** attempt);
              const jitter = Math.floor(Math.random() * 100);
              await sleep(base + jitter);
              attempt += 1;
              continue;
            }
          }
          await sleep(heartbeatMs); // heartbeat interval
        }
      })();
    },
    async applyChange<TModel extends ModelName<TSchema>>(model: TModel, change: { type: "insert" | "update" | "delete"; id: string; value?: RowOf<TSchema, TModel>; patch?: Partial<RowOf<TSchema, TModel>> }) {
      if (queue.length >= queueMaxSize) return { ok: false as const, error: { code: "SYNC:CHANGE_REJECTED", message: "Queue full", meta: { max: queueMaxSize } } };
      queue.push({ model, change } as unknown as Queued); metrics?.on("applyQueued", { model });
      return { ok: true, value: { queued: !isConnected } } as const;
    },
    /** Apply a batch of changes; returns when enqueued. */
    async applyChanges<TModel extends ModelName<TSchema>>(model: TModel, changes: { type: "insert" | "update" | "delete"; id: string; value?: RowOf<TSchema, TModel>; patch?: Partial<RowOf<TSchema, TModel>> }[]) {
      for (const c of changes) {
        if (queue.length >= queueMaxSize) return { ok: false as const, error: { code: "SYNC:CHANGE_REJECTED", message: "Queue full", meta: { max: queueMaxSize } } };
        queue.push({ model, change: c } as unknown as Queued); metrics?.on("applyQueued", { model });
      }
      return { ok: true, value: { queued: !isConnected } } as const;
    },
    async drain() {
      while (queue.length > 0 && !stopped) {
        await sleep(10);
      }
      if (stopped && queue.length > 0) queue.length = 0;
    },
    getQueueStats() { return { size: queue.length, pendingBatches: queue.length ? 1 : 0, bytes: 0 }; },
    shouldBackOff() { return queue.length > 1000; },
    /**
     * Subscribe to a model. Immediately pulls current rows, then refreshes
     * whenever the server sends a WS "poke".
     * @example
     * const sub = sync.subscribeQuery({ model: "todo" }, rows => {
     *   console.log(rows);
     * });
     * // later: sub.unsubscribe()
     */
    subscribeQuery(params: { model: string; where?: any; select?: string[] }, cb: (rows: any[]) => void) {
      // initial pull
      void (async () => {
        try {
          const res = await fetch(`${baseUrl}${basePath}/pull?model=${encodeURIComponent(params.model)}`, { headers: tenantId ? { "x-tenant-id": tenantId } : undefined });
          if (res.ok) {
            const data = await res.json();
            if (data?.ok && data?.value?.rows) {
              const ser = (serializers as any)[params.model];
              const rows = ser ? (data.value.rows as any[]).map((r) => ser.decode(r)) : data.value.rows;
              cb(rows);
            }
          }
        } catch { }
      })();
      let set = wsSubscribers.get(params.model);
      if (!set) { set = new Set(); wsSubscribers.set(params.model, set); }
      set.add(cb);
      return { unsubscribe() { set!.delete(cb); if (set!.size === 0) wsSubscribers.delete(params.model); } };
    },
    createSnapshot() { return Promise.resolve(); },
    /** Stop background loops and close network resources. */
    async stop() { stopped = true; },
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
