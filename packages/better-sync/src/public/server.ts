import type { SyncServer, SyncServerConfig } from "./types.js";
import { getSyncJsonMeta } from "./sync-json.js";
/**
 * Create a sync server instance.
 * @example
 * const server = betterSync({ basePath: "/api/sync" });
 * app.use("/api/sync", server.fetch());
 */
/**
 * Build a Better Sync server instance.
 * - HTTP endpoints: GET /sync.json, GET /pull?model=..., POST /apply
 * - Optional WebSocket: attach via attachWebSocket(server) and clients will be poked after apply
 * - Guards: authorize/forbid/shouldRateLimit → mapped to SYNC:* error codes
 */
export function betterSync(_config: SyncServerConfig): SyncServer {
  const basePath = _config.basePath ?? "/api/sync";
  const json = (res: any, status: number, body: unknown) => {
    if (typeof res?.statusCode === "number") res.statusCode = status;
    if (typeof res?.setHeader === "function") res.setHeader("Content-Type", "application/json");
    const payload = JSON.stringify(body);
    if (typeof res?.end === "function") res.end(payload);
  };
  // In-memory store: tenant -> model -> id -> row
  const store = new Map<string, Map<string, Map<string, any>>>();
  const tenantCursor = new Map<string, number>();
  const getTenant = (req: any): string => String(req?.headers?.["x-tenant-id"] ?? "default");
  const getModelMap = (tenantId: string, model: string) => {
    let t = store.get(tenantId);
    if (!t) { t = new Map(); store.set(tenantId, t); }
    let m = t.get(model);
    if (!m) { m = new Map(); t.set(model, m); }
    return m;
  };
  const nextCursor = (tenantId: string) => {
    const cur = (tenantCursor.get(tenantId) ?? 0) + 1;
    tenantCursor.set(tenantId, cur);
    return String(cur);
  };
  const parseBody = async (req: any): Promise<any> => {
    if (req?.body) return req.body;
    if (typeof req?.on === "function") {
      const chunks: Buffer[] = [];
      let total = 0; const limit = 1_000_000; // 1MB
      await new Promise<void>((resolve) => {
        req.on("data", (c: Buffer) => { total += c.length; if (total <= limit) chunks.push(c); });
        req.on("end", () => resolve());
      });
      if (total > limit) return { __tooLarge: true };
      const text = Buffer.concat(chunks).toString("utf8");
      try { return JSON.parse(text); } catch { return undefined; }
    }
    return undefined;
  };
  const sockets = new Set<any>();
  const broadcastPoke = (model?: string) => {
    for (const s of sockets) {
      try { s.send(JSON.stringify({ type: "poke", model })); } catch {}
    }
  };
  /** Coalesce and apply a batch of changes; delete-wins, update patches merged. */
  const applyBatch = (tenantId: string, changes: Array<{ model: string; type: string; id: string; value?: any; patch?: Record<string, unknown> }>) => {
    // coalesce per model/id
    const finalByModelId = new Map<string, Map<string, { action: "delete" | "upsert"; base?: any; patch?: Record<string, unknown> }>>();
    for (const ch of changes) {
      const { model, type, id, value, patch } = ch || {} as any;
      if (!model || !type || !id) continue;
      let modelMap = finalByModelId.get(model);
      if (!modelMap) { modelMap = new Map(); finalByModelId.set(model, modelMap); }
      const cur = modelMap.get(id) ?? { action: "upsert" as const, base: undefined as any, patch: undefined as Record<string, unknown> | undefined };
      if (type === "delete") {
        modelMap.set(id, { action: "delete" });
        continue;
      }
      if (type === "insert") {
        // prefer explicit value, but do not drop accumulated patch
        const next: typeof cur = { action: "upsert", base: value ?? cur.base, patch: cur.patch };
        modelMap.set(id, next);
        continue;
      }
      if (type === "update") {
        // merge patches shallowly
        const merged = { ...(cur.patch ?? {}), ...(patch ?? {}) };
        modelMap.set(id, { action: "upsert", base: cur.base, patch: merged });
        continue;
      }
    }
    // apply to store
    for (const [model, idMap] of finalByModelId) {
      const rows = getModelMap(tenantId, model);
      for (const [id, fin] of idMap) {
        if (fin.action === "delete") {
          rows.delete(id);
          continue;
        }
        const current = rows.get(id) ?? {};
        const base = fin.base ?? current;
        const nextValue = { ...base, ...(fin.patch ?? {}) };
        rows.set(id, nextValue);
      }
    }
  };
  const buildApi = (fixedTenant?: string) => ({
    /** Apply a batch of changes for a tenant (direct/server-side). */
    async apply(input: { tenantId?: string; changes: any[] }) {
      const tenantId = fixedTenant ?? input?.tenantId ?? "default";
      const changes = Array.isArray(input?.changes) ? input.changes : [];
      applyBatch(tenantId, changes);
      broadcastPoke();
      return { ok: true, value: { applied: true, cursor: nextCursor(tenantId) } } as const;
    },
    /** Return a tenant-bound API (no network). */
    withTenant(id?: string) { return buildApi(id); },
    /** Register a shape (no-op for now to keep API stable). */
    registerShape(_input: any) { /* no-op */ },
  });
  return {
    /**
     * Attach a WebSocket server (via `ws`) to an existing Node HTTP server.
     * Clients connect to `${basePath}/ws`; after `apply`, a `{ type: "poke" }`
     * is broadcast so clients re-pull their subscribed models.
     */
    attachWebSocket(server: any) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const WebSocketServer = require("ws").Server;
        const wss = new WebSocketServer({ server });
        wss.on("connection", (socket: any, req: any) => {
          const url: string = String(req?.url ?? "");
          if (!url.startsWith(basePath + "/ws")) return socket.close();
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        });
        return wss;
      } catch {
        return undefined;
      }
    },
    /**
     * Express-style HTTP handler supporting:
     * - GET `${basePath}/sync.json`
     * - GET `${basePath}/pull?model=...`
     * - POST `${basePath}/apply`
     */
    fetch() {
      // Express-style handler
      return async (req: any, res: any, next?: any) => {
        const method: string = (req?.method ?? "GET").toUpperCase();
        const url: string = String(req?.originalUrl ?? req?.url ?? "");
        if (url.startsWith(basePath)) {
          const remainder = url.slice(basePath.length);
          if (_config.shouldRateLimit && await _config.shouldRateLimit(req)) return json(res, 429, { ok: false, error: { code: "SYNC:RATE_LIMITED", message: "Rate limited" } });
          if (_config.forbid && await _config.forbid(req)) return json(res, 403, { ok: false, error: { code: "SYNC:FORBIDDEN", message: "Forbidden" } });
          if (_config.authorize && !(await _config.authorize(req))) return json(res, 401, { ok: false, error: { code: "SYNC:UNAUTHORIZED", message: "Unauthorized" } });
          if (method === "GET" && (remainder === "/sync.json" || remainder === "/sync.json/")) {
            return json(res, 200, getSyncJsonMeta(basePath));
          }
          if (method === "GET" && remainder.startsWith("/pull")) {
            const tenantId = getTenant(req);
            const u = new URL(`http://local${remainder}`);
            const model = u.searchParams.get("model");
            const since = u.searchParams.get("since");
            if (!model) return json(res, 400, { ok: false, error: { code: "SYNC:CHANGE_REJECTED", message: "Missing model" } });
            const rows = Array.from(getModelMap(tenantId, model).values());
            const cursor = String(tenantCursor.get(tenantId) ?? 0);
            if (since && since === cursor) return json(res, 200, { ok: true, value: { rows: [], cursor } });
            return json(res, 200, { ok: true, value: { rows, cursor } });
          }
          if (method === "POST" && (remainder === "/apply" || remainder === "/apply/")) {
            const body = await parseBody(req);
            const tenantId = getTenant(req);
            if (body?.__tooLarge) return json(res, 413, { ok: false, error: { code: "SYNC:CHANGE_REJECTED", message: "Body too large" } });
            // test hook for internal error simulation
            if (body?.__force500) return json(res, 500, { ok: false, error: { code: "SYNC:SERVER_ERROR", message: "Forced error" } });
            // support single or batch
            const changes = Array.isArray(body?.changes)
              ? body.changes
              : body && body.model && body.change ? [{ model: body.model, ...body.change }] : [];
            if (!changes.length) {
              return json(res, 400, { ok: false, error: { code: "SYNC:CHANGE_REJECTED", message: "Invalid change payload" } });
            }
            const affected = new Set<string>(); changes.forEach((c: any) => affected.add(c.model));
            try {
              applyBatch(tenantId, changes);
            } catch (e) {
              return json(res, 500, { ok: false, error: { code: "SYNC:SERVER_ERROR", message: "Failed to apply changes" } });
            }
            for (const m of affected) broadcastPoke(m);
            return json(res, 200, { ok: true, value: { applied: true, cursor: nextCursor(tenantId) } });
          }
        }
        if (typeof next === "function") return next();
      };
    },
    api: buildApi(),
  } as unknown as SyncServer;
}
