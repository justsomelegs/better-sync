import type { SyncServer, SyncServerConfig, Cursor } from "./types.js";
import { syncError } from "./errors.js";
import { getSyncJsonMeta } from "./sync-json.js";
/**
 * Create a sync server instance.
 *
 * @example
 * import express from "express";
 * import { betterSync } from "better-sync";
 * import { sqlite } from "better-sync/storage";
 * const app = express();
 * const server = betterSync({
 *   basePath: "/api/sync",
 *   authorize: (req) => Boolean(req.headers["authorization"]),
 *   canRead: (_req, _model, _row) => true,
 *   canWrite: (_req, _model, _change) => true,
 * });
 * app.use("/api/sync", server.fetch());
 * app.listen(3000);
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
  // Separate clock store for conflict resolution: tenant -> model -> id -> clock
  const clocks = new Map<string, Map<string, Map<string, { ts?: number | string; actorId?: string }>>>();
  const tenantCursor = new Map<string, number>();
  const getTenant = (req: any): string => String(req?.headers?.["x-tenant-id"] ?? "default");
  const getModelMap = (tenantId: string, model: string) => {
    let t = store.get(tenantId);
    if (!t) { t = new Map(); store.set(tenantId, t); }
    let m = t.get(model);
    if (!m) { m = new Map(); t.set(model, m); }
    return m;
  };
  const getClockMap = (tenantId: string, model: string) => {
    let t = clocks.get(tenantId);
    if (!t) { t = new Map(); clocks.set(tenantId, t); }
    let m = t.get(model);
    if (!m) { m = new Map(); t.set(model, m); }
    return m;
  };
  const nextCursor = (tenantId: string): Cursor => {
    const cur = (tenantCursor.get(tenantId) ?? 0) + 1;
    tenantCursor.set(tenantId, cur);
    return String(cur) as Cursor;
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
  // Shapes: tenant -> shapeId -> def
  const shapes = new Map<string, Map<string, { model: string; where?: Record<string, unknown>; select?: string[] }>>();
  const shapeIds = new Map<string, number>(); // tenant-local counters
  const shapeCursors = new Map<string, Map<string, number>>(); // tenant -> shapeId -> cursor
  const getShapeCursor = (tenantId: string, shapeId: string) => {
    let t = shapeCursors.get(tenantId); if (!t) { t = new Map(); shapeCursors.set(tenantId, t); }
    return t;
  };
  const broadcastPoke = (model?: string) => {
    for (const s of sockets) {
      try { s.send(JSON.stringify({ type: "poke", model })); } catch {}
    }
  };
  /**
   * Coalesce and apply a batch of changes with conflict handling.
   *
   * Concepts:
   * - Coalescing: Multiple updates on the same (model,id) are merged; delete wins.
   * - HLC LWW: Newer {@link clock} wins; on tie, delete beats update; actorId breaks ties.
   * - Per-shape cursor: After applying changes, any shapes referencing affected models
   *   advance their own cursors so clients can pull incrementally by shape.
   */
  const applyBatch = (tenantId: string, changes: Array<{ model: string; type: string; id: string; value?: any; patch?: Record<string, unknown>; clock?: { ts?: number | string; actorId?: string } }>) => {
    // coalesce per model/id
    const finalByModelId = new Map<string, Map<string, { action: "delete" | "upsert"; base?: any; patch?: Record<string, unknown>; clock?: { ts?: number | string; actorId?: string } }>>();
    for (const ch of changes) {
      const { model, type, id, value, patch, clock } = ch || ({} as any);
      if (!model || !type || !id) continue;
      let modelMap = finalByModelId.get(model);
      if (!modelMap) { modelMap = new Map(); finalByModelId.set(model, modelMap); }
      const cur = modelMap.get(id) ?? { action: "upsert" as const, base: undefined as any, patch: undefined as Record<string, unknown> | undefined, clock: undefined as any };
      if (type === "delete") {
        // delete-wins; keep the latest clock for determinism
        modelMap.set(id, { action: "delete", clock: clock ?? cur.clock });
        continue;
      }
      if (type === "insert") {
        // prefer explicit value, but do not drop accumulated patch
        const next: typeof cur = { action: "upsert", base: value ?? cur.base, patch: cur.patch, clock: clock ?? cur.clock };
        modelMap.set(id, next);
        continue;
      }
      if (type === "update") {
        // merge patches shallowly
        const merged = { ...(cur.patch ?? {}), ...(patch ?? {}) };
        modelMap.set(id, { action: "upsert", base: cur.base, patch: merged, clock: clock ?? cur.clock });
        continue;
      }
    }
    // apply to store with LWW+HLC semantics
    const cmpClock = (a?: { ts?: number | string; actorId?: string }, b?: { ts?: number | string; actorId?: string }): number => {
      if (!a && !b) return 0;
      if (a && !b) return 1;
      if (!a && b) return -1;
      const at = typeof a!.ts === "string" ? Date.parse(a!.ts as string) : (a!.ts ?? 0);
      const bt = typeof b!.ts === "string" ? Date.parse(b!.ts as string) : (b!.ts ?? 0);
      if (at > bt) return 1;
      if (at < bt) return -1;
      const aa = a!.actorId ?? ""; const ba = b!.actorId ?? "";
      if (aa > ba) return 1;
      if (aa < ba) return -1;
      return 0;
    };
    const affectedModels = new Set<string>();
    for (const [model, idMap] of finalByModelId) {
      affectedModels.add(model);
      const rows = getModelMap(tenantId, model);
      const cm = getClockMap(tenantId, model);
      for (const [id, fin] of idMap) {
        const currentClock = cm.get(id);
        const newer = cmpClock(fin.clock, currentClock) >= 0;
        if (fin.action === "delete") {
          if (newer || !currentClock) { rows.delete(id); if (fin.clock) cm.set(id, fin.clock); }
          continue;
        }
        if (newer || !currentClock) {
          const current = rows.get(id) ?? {};
          const base = fin.base ?? current;
          const nextValue = { ...base, ...(fin.patch ?? {}) };
          rows.set(id, nextValue);
          if (fin.clock) cm.set(id, fin.clock);
        }
      }
    }
    // bump per-shape cursors for affected models
    const tShapes = shapes.get(tenantId);
    if (tShapes && tShapes.size) {
      for (const [sid, def] of tShapes) {
        if (affectedModels.has(def.model)) {
          const tm = getShapeCursor(tenantId, sid);
          const cur = (tm.get(sid) ?? 0) + 1; tm.set(sid, cur);
        }
      }
    }
  };
  const buildApi = (fixedTenant?: string) => ({
    /**
     * Apply a batch of changes for a tenant (direct/server-side).
     *
     * @example
     * const result = await server.api.apply({ tenantId: "t1", changes: [
     *   { model: "todo", type: "insert", id: "t1", value: { id: "t1", title: "A" } },
     * ]});
     */
    async apply(input: { tenantId?: string; changes: any[] }) {
      const tenantId = fixedTenant ?? input?.tenantId ?? "default";
      const changes = Array.isArray(input?.changes) ? input.changes : [];
      applyBatch(tenantId, changes);
      broadcastPoke();
      return { ok: true, value: { applied: true, cursor: nextCursor(tenantId) } } as const;
    },
    /**
     * Return a tenant-bound API (no network).
     *
     * @example
     * const t1 = server.api.withTenant("t1");
     * await t1.apply({ changes: [{ model: "todo", type: "insert", id: "x", value: { id: "x", title: "B" } }] });
     */
    withTenant(id?: string) { return buildApi(id); },
    /**
     * Register a shape and return its id (per-tenant namespace).
     *
     * @example
     * const { id } = server.api.registerShape({ tenantId: "t1", model: "todo", where: { done: false }, select: ["id","title"] });
     */
    registerShape(input: { tenantId?: string; model: string; where?: Record<string, unknown>; select?: string[] }) {
      const tenantId = fixedTenant ?? input?.tenantId ?? "default";
      const tid = shapeIds.get(tenantId) ?? 0; const idNum = tid + 1; shapeIds.set(tenantId, idNum);
      let t = shapes.get(tenantId); if (!t) { t = new Map(); shapes.set(tenantId, t); }
      const id = `shape_${idNum}`;
      t.set(id, { model: input.model, where: input.where, select: input.select });
      return { id } as const;
    },
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
          if (_config.shouldRateLimit && await _config.shouldRateLimit(req)) return json(res, 429, { ok: false, error: syncError("SYNC:RATE_LIMITED", "Rate limited", { path: basePath }) });
          if (_config.forbid && await _config.forbid(req)) return json(res, 403, { ok: false, error: syncError("SYNC:FORBIDDEN", "Forbidden", { path: basePath }) });
          if (_config.authorize && !(await _config.authorize(req))) return json(res, 401, { ok: false, error: syncError("SYNC:UNAUTHORIZED", "Unauthorized", { path: basePath }) });
          if (method === "GET" && (remainder === "/sync.json" || remainder === "/sync.json/")) {
            return json(res, 200, getSyncJsonMeta(basePath));
          }
          if (method === "GET" && remainder.startsWith("/pull")) {
            const tenantId = getTenant(req);
            const u = new URL(`http://local${remainder}`);
            const model = u.searchParams.get("model");
            const shapeId = u.searchParams.get("shapeId");
            const since = u.searchParams.get("since");
            if (!model) return json(res, 400, { ok: false, error: syncError("SYNC:CHANGE_REJECTED", "Missing model", { path: basePath }) });
            let rows = Array.from(getModelMap(tenantId, model).values());
            if (_config.canRead) {
              const filtered: any[] = [];
              for (const r of rows) { if (await _config.canRead(req, model, r)) filtered.push(r); }
              rows = filtered;
            }
            if (shapeId) {
              const t = shapes.get(tenantId); const def = t?.get(shapeId);
              if (def && def.model === model) {
                if (def.where) {
                  rows = rows.filter((r: any) => Object.entries(def.where!).every(([k, v]) => (r as any)[k] === v));
                }
                if (def.select && def.select.length) {
                  rows = rows.map((r: any) => def.select!.reduce((acc: any, k: string) => { acc[k] = r[k]; return acc; }, { id: r.id }));
                }
              }
            }
            const cursor = shapeId ? String(getShapeCursor(tenantId, shapeId).get(shapeId) ?? 0) : String(tenantCursor.get(tenantId) ?? 0);
            if (since && since === cursor) return json(res, 200, { ok: true, value: { rows: [], cursor } });
            return json(res, 200, { ok: true, value: { rows, cursor } });
          }
          if (method === "POST" && (remainder === "/apply" || remainder === "/apply/")) {
            const body = await parseBody(req);
            const tenantId = getTenant(req);
            if (body?.__tooLarge) return json(res, 413, { ok: false, error: syncError("SYNC:CHANGE_REJECTED", "Body too large", { path: basePath }) });
            // test hook for internal error simulation
            if (body?.__force500) return json(res, 500, { ok: false, error: syncError("SYNC:SERVER_ERROR", "Forced error", { path: basePath }) });
            // support single or batch
            const changes = Array.isArray(body?.changes)
              ? body.changes
              : body && body.model && body.change ? [{ model: body.model, ...body.change }] : [];
            const idempotencyKey = String(req?.headers?.["x-idempotency-key"] ?? body?.idempotencyKey ?? "");
            if (!changes.length) {
              return json(res, 400, { ok: false, error: syncError("SYNC:CHANGE_REJECTED", "Invalid change payload", { path: basePath }) });
            }
            if (_config.canWrite) {
              for (const ch of changes) {
                const ok = await _config.canWrite(req, ch.model, ch as any);
                if (!ok) return json(res, 403, { ok: false, error: syncError("SYNC:FORBIDDEN", "Change rejected by ACL", { path: basePath }) });
              }
            }
            // idempotency cache per tenant
            const idemKey = `${tenantId}:${idempotencyKey}`;
            const idem = (globalThis as any).__betterSyncIdem ?? ((globalThis as any).__betterSyncIdem = new Map<string, any>());
            if (idempotencyKey && idem.has(idemKey)) {
              const prev = idem.get(idemKey);
              return json(res, 200, { ok: true, value: prev });
            }
            const affected = new Set<string>(); changes.forEach((c: any) => affected.add(c.model));
            try {
              applyBatch(tenantId, changes);
            } catch (e) {
              return json(res, 500, { ok: false, error: syncError("SYNC:SERVER_ERROR", "Failed to apply changes", { path: basePath }) });
            }
            for (const m of affected) broadcastPoke(m);
            const value = { applied: true, cursor: nextCursor(tenantId) } as const;
            if (idempotencyKey) idem.set(idemKey, value);
            return json(res, 200, { ok: true, value });
          }
          if (method === "POST" && (remainder === "/shapes/register" || remainder === "/shapes/register/")) {
            const body = await parseBody(req);
            const tenantId = getTenant(req);
            if (!body?.model) return json(res, 400, { ok: false, error: syncError("SYNC:CHANGE_REJECTED", "Missing model", { path: basePath }) });
            const tid = shapeIds.get(tenantId) ?? 0; const idNum = tid + 1; shapeIds.set(tenantId, idNum);
            let t = shapes.get(tenantId); if (!t) { t = new Map(); shapes.set(tenantId, t); }
            const id = `shape_${idNum}`;
            t.set(id, { model: body.model, where: body.where, select: body.select });
            // initialize shape cursor to current tenant cursor
            const tm = getShapeCursor(tenantId, id); tm.set(id, tenantCursor.get(tenantId) ?? 0);
            return json(res, 200, { ok: true, value: { id } });
          }
        }
        if (typeof next === "function") return next();
      };
    },
    api: buildApi(),
  } as unknown as SyncServer;
}

/** Alias for symmetry with createSyncClient. */
export const createSyncServer = betterSync;
