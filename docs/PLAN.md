## Better Sync: Product & API Plan (DX-focused)

### External - Vision
- Framework-agnostic, DB-agnostic sync engine with better-auth-grade DX.
- Local-first by default, strong typing, minimal setup, portable JSON protocol.

For beginners: This library helps your app keep data the same between users and devices. It works with many frameworks and databases, and it’s designed to be easy to set up and safe to use.

### External - Core DX
- Constructors: `createSyncClient(config)` (client), `betterSync(config)` (server).
- Absolute client `baseUrl` is required (e.g., `http://localhost:3000`).
- Server `basePath` is optional, default `/api/sync`.
- WebSocket default (always-on connection) with HTTP polling fallback (periodic requests); heartbeat (small “I’m alive” pings) and jittered reconnects (randomized delays so many clients don’t retry at once).
- SYNC:* namespaced error codes with helpUrl; result-returning APIs on hot paths.
- JSDoc with `@example` across public APIs.

For beginners: You make one client and one server instance with a small config.
- `createSyncClient` builds the client that runs in the browser/device.
- `betterSync` builds the server instance your framework mounts.
- `baseUrl` is the full address of your server (e.g., `http://localhost:3000`).
- `basePath` is the path on that server (default `/api/sync`), so the full endpoint is `${baseUrl}${basePath}`.
- WebSocket = always-on connection for instant updates; HTTP polling = periodic requests as a fallback.
- "Result-returning API" means many functions return `{ ok: boolean, value?: T, error?: SyncError }` instead of throwing, so you can handle errors without try/catch.
- Error codes look like `SYNC:UNAUTHORIZED` and include a link with how to fix it.

### External - How syncing works
- Local-first: client persists changes immediately and syncs in background.
- Push/Pull with server-issued opaque cursor (a server-made bookmark); idempotent (safe to retry), batched changes (sent in groups).
- Conflicts: LWW (last write wins) using HLC (hybrid logical clock); delete-wins on equal timestamps; actorId lexical tie-breaker (consistent ordering by editor id).
- Retry/backoff: exponential with jitter (wait a bit longer each time, with randomness); resume from last acknowledged cursor (continue where sync left off).

For beginners: Your app writes locally first so it feels instant—even offline. The client sends changes to the server and fetches new ones. If two people edit the same thing, we have a fair rule to decide the winner. Network hiccups are handled automatically.

### External - Key concepts (for beginners)
- Client: the app running in the browser or device. It keeps a local database for speed and offline use.
- Server: the part that stores data for everyone and resolves conflicts between clients.
- baseUrl: the full address of your server (like a house address). Example: `http://localhost:3000`.
- basePath: the street (path) where sync traffic goes. Default: `/api/sync`.
- WebSocket vs HTTP: WebSocket is a always-on connection (like a phone call). HTTP polling is asking repeatedly (like sending letters). We use WebSocket first and fall back to HTTP if needed.
- Cursor: a bookmark that says “we’ve synced everything up to here.” It’s created by the server.
- Change (op): a small record that says what you did (insert/update/delete) to which item.
- Conflict: when two changes disagree. We resolve it predictably so all devices end up the same.
- Shape: a filter that says “only sync this slice of data” to save bandwidth.
- Snapshot: a stored copy of current data so we don’t have to replay every change from the beginning.
- Tenant: a group or organization in a multi-tenant app. Each tenant can have its own data slice and cursor.

### External - End-to-end flow (first 5 minutes)
1) Create the server with `betterSync({ ... })`. This prepares the sync endpoint and storage.
2) Start your web app and create the client with `createSyncClient({ baseUrl, storage })`.
3) Call `await sync.connect()`. The client will talk to the server and get a cursor.
4) Make a change (e.g., add a todo). The client writes locally right away (instant UI).
5) In the background, the client pushes your change to the server. The server stores it and updates the cursor.
6) If someone else changed the same item, the server resolves the conflict and the client updates your view.
7) If the network fails, the client tries again later and picks up where it left off.

### External - Picking a local database (client)
- IndexedDB (browser): best default for web apps; stores data even if the tab closes.
- sql.js/libsql (WASM): useful when you want a SQL interface in the browser or edge.
Tip: Start with IndexedDB unless you know you need SQL in the browser.

Example:
```ts
import { idb } from "better-sync/providers/storage";
// Default choice for web apps
const storage = idb({ dbName: "app" });

// Or use a WASM SQL engine if you need SQL locally
// import { sqljs } from "better-sync/providers/storage";
// const storage = sqljs({ file: ":memory:" });
```

### External - Handlers vs direct server API
- Handlers (server.fetch): mount HTTP/WS endpoints for browsers and external clients.
- Direct server API (server.api.*): call from server code (SSR/server actions) with no HTTP hop.
- Use handlers for browsers/mobile; use direct calls inside your server.

Example (Express):
```ts
import express from "express";
import { server } from "./server";

const app = express();
app.use("/api/sync", server.fetch());
app.listen(3000);
```

For beginners: If your code runs in the browser, use the handler URL. If your code runs on the server (like a server action), call `server.api.*` directly—no network needed.

### External - Client (simple)
```ts
import { createSyncClient } from "better-sync";
import { idb } from "better-sync/providers/storage";
import { rpc } from "better-sync/providers/transport";

const sync = createSyncClient({
  models,
  baseUrl: "http://localhost:3000",
  storage: idb({ dbName: "app" }),
  transport: rpc({ baseUrl: "http://localhost:3000" }),
  auth: { headers: () => ({ Authorization: `Bearer ${token()}` }) },
  conflict: "lww",
  dev: { autoServer: true },
});

await sync.connect();
```

- Config notes: `baseUrl` required; `basePath` defaults to `/api/sync` (effective URL `${baseUrl}${basePath}`), so `http://localhost:3000` + `/api/sync` = `http://localhost:3000/api/sync`.
- Token refresh: `tokenRefresher` hook dedups concurrent 401s, retries with backoff.

For beginners: This creates the client, tells it where the server is, where to store local data, and how to attach your auth token (proof you’re allowed). After `connect()`, it starts syncing.
- `models`: teaches the client the shape of your data so types and validation work.
- `baseUrl`: full server address (must include `http://` or `https://`).
- `storage`: where to keep local data (IndexedDB is the default for browsers).
- `transport`: how to talk to the server (RPC over WS/HTTP by default).
- `auth.headers`: how to attach your token or cookie to each request.
- `conflict: "lww"`: the default rule for handling edits that clash.
- `dev.autoServer`: in development, auto-mounts the server handler so you don’t create routes by hand.
`basePath` is the path part the server listens on (usually `/api/sync`).

### External - Server (simple)
```ts
import { betterSync } from "better-sync";
import { sqlite } from "better-sync/providers/storage";
import { jwt } from "better-sync/providers/auth";

export const server = betterSync({
  basePath: "/api/sync",
  storage: sqlite({ file: "./data.db", ensureSchema: true, autoMigrate: process.env.NODE_ENV !== "production" }),
  auth: jwt({ jwksUrl }),
  conflict: "lww",
  authorize: async (req) => ({ userId, tenantId, roles }),
  canRead: (ctx, table, row) => true,
  canWrite: (ctx, table, row) => true,
});

export const fetch = server.fetch();
```

For beginners: This sets up the server.
- `storage`: where changes are saved (SQLite here; Postgres/MySQL adapters later). `ensureSchema` creates required tables if missing (dev-safe). `autoMigrate` runs non-destructive updates in dev/test.
- `auth`: verifies who the user is (JWT here, or bring your own provider).
- `authorize(req)`: turns an incoming request into a context (userId, tenantId, roles). Think of it as a login check per request.
- `canRead/canWrite`: per-row checks that decide access (row-level security for your app logic).
- `server.fetch()` gives a function your framework can mount as the sync endpoint.

### External - Dialect and adapter selection
- Recommended: use explicit storage providers (`sqlite()`, `postgres()`, etc.). The provider already knows the dialect—no extra option needed.
- Optional: for BYO ORM, use a generic factory with a `dialect` flag to create a `StorageAdapter`.
- Client: no `dialect` option is needed; wire normalization keeps types consistent.

Explicit provider (recommended):
```ts
import { betterSync } from "better-sync";
import { postgres } from "better-sync/providers/storage";

export const server = betterSync({
  storage: postgres({ pool }), // dialect implied by provider
});
```

Generic BYO ORM with dialect (optional):
```ts
import { createOrmAdapter } from "better-sync/adapters";
import { drizzle } from "drizzle-orm";

const storage = createOrmAdapter({
  dialect: "postgres",
  orm: drizzle(db),
  schema,
  wire: { normalize: "auto" }, // inherits adapter defaults, still overridable
});

export const server = betterSync({ storage });
```

Custom provider (no dialect needed):
```ts
import type { StorageAdapter } from "better-sync";

const storage: StorageAdapter = myCustomAdapter(/* ... */);
export const server = betterSync({ storage });
```

Notes:
- Keeping dialect inside providers improves type inference, tree‑shaking, and clear config.
- The generic factory is convenience for BYO ORMs; omit `dialect` when you supply a full `StorageAdapter`.

### External - Live queries & subscriptions (framework-agnostic)
```ts
const sub = sync.subscribeQuery({ model: "todo", where: { done: false }, select: ["id", "title"] }, (rows) => {
  // typed rows
});
sub.unsubscribe();
```
- Uses WS “poke” (tiny message that says “pull now”) with HTTP fallback; server validates queries and ACLs (access control rules for rows).

For beginners: Subscribe (like “follow”) to a query and get updates whenever data changes—no manual polling.
- "Query" = filter + fields (which rows, which columns).
- The callback runs immediately with current data, then runs again when the server sends a WS poke ("pull now").
- Call `unsubscribe()` when your component unmounts to avoid memory leaks.
- Live queries stay framework-agnostic: you can wire them to React/Svelte/Vue yourself or use tiny wrappers later.

### External - Partial replication shapes
```ts
await server.api.registerShape({ tenantId: "t1", model: "todo", where: { archived: false }, select: ["id", "title", "updated_at"] });
// Client can pin shapes: sync.pinShape(shapeId)
```
- Per-tenant cursors per shape (separate bookmarks per organization and data slice) to reduce bandwidth; client cache invalidates when the shape changes.

For beginners:
- What is a “partial replication shape”? It’s a saved rule on the server that describes exactly which records to sync and which fields of those records to include. Think of it as a “subscription” that says “give me only these rows and only these columns.”
  - where: which rows (filters). Example: only todos where archived = false.
  - select: which fields (columns). Example: only id, title, updated_at.
- What is a “slice”? It’s the actual subset of your data produced by a shape—the filtered rows and chosen fields that the client will download and keep up to date.
- Why shapes? They make sync faster and cheaper by avoiding data you don’t need, and they keep the local database small.

Concrete examples:
- A project dashboard might register a shape like: { model: "task", where: { projectId, status: { in: ["open","in_progress"] } }, select: ["id","title","status","updated_at"] }.
- A reporting page could use a shape for the last 30 days: { model: "event", where: { created_at: { gte: last30Days } }, select: ["id","type","created_at"] }.
- A multi-tenant app sets shapes per tenant so each organization only syncs its own rows.

### External - Model typing & optional schema mode
- `defineModel.fromZod(schema)` (Zod = schema/validation library) or `defineModel.fromDrizzle(table)` (Drizzle = TypeScript-first SQL mapping) for end-to-end types.
- Optional schema mode: start loose, harden over time.

```ts
import { z } from "zod";
import { defineModel } from "better-sync/models";

const Todo = z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false) });
export const models = { todo: defineModel.fromZod(Todo) };
```

For beginners: You can start without strict schemas and add them later. When you do, your editor will autocomplete and type-check your data.

### External - DB-agnostic wire format (automatic and optional)
- Default: Automatic normalization handled by the storage adapter, no config required.
- You can turn it off globally or override per model when you need full control.
- Typical defaults: uuid → string; bigint/numeric → string; timestamp → ISO 8601 string; bytea → base64; arrays → JSON arrays.

Zero-config (adapter applies safe defaults):
```ts
import { betterSync } from "better-sync";
import { postgres } from "better-sync/providers/storage";

export const server = betterSync({
  storage: postgres({ connectionString: process.env.DATABASE_URL }),
  // wire.normalize defaults to "auto" → adapter performs safe conversions for you
});
```

Turn it off globally (you’ll get raw DB driver values on the wire):
```ts
import { sqlite } from "better-sync/providers/storage";

const storage = sqlite({ file: "./data.db", wire: { normalize: "off" } });
```

Override per model in the adapter (supply custom serializer):
```ts
import { postgres } from "better-sync/providers/storage";

const storage = postgres({
  connectionString: process.env.DATABASE_URL,
  wire: {
    normalize: "auto", // keep defaults for everything else
    serializers: {
      todo: {
        encode(row) {
          return { ...row, priority: String(row.priority) };
        },
        decode(wire) {
          return { ...wire, priority: wire.priority };
        },
      },
    },
  },
});
```

Override at model definition (library-level, independent of adapter):
```ts
import { defineModel } from "better-sync/models";

export const models = {
  todo: defineModel.fromZod(Todo, {
    wire: {
      encode: (row) => ({ ...row, updated_at: new Date(row.updated_at).toISOString() }),
      decode: (wire) => ({ ...wire, updated_at: wire.updated_at }),
    },
  }),
};
```

For beginners: By default, you don’t need to do anything—your adapter converts tricky types into safe JSON automatically. If you prefer raw values (or special handling) you can turn normalization off entirely or customize it for a specific model.

### Internal - Internal Serializer API (storage boundary)
Define how rows become wire-safe JSON and back again. This keeps the protocol DB-agnostic.

```ts
// Internal API shape (per model or per storage adapter)
export interface ModelSerializer<TWire = any, TRow = any> {
  encode(row: TRow): TWire;          // app/db → wire (JSON-safe)
  decode(wire: TWire): TRow;          // wire → app/db
  wireVersion?: number;               // bump if the wire shape changes
}
```

Default conversions (recommendations):
- uuid → string
- bigint/numeric/decimal → string (avoid JS precision loss)
- timestamp/timestamptz → ISO 8601 string
- bytea/binary → base64 string
- arrays → JSON arrays
- json/jsonb → JSON as-is

Example (Postgres Todo):
```ts
const todoSerializer: ModelSerializer<any, PgTodoRow> = {
  encode(row) {
    return {
      id: row.id,
      title: row.title,
      done: row.done,
      priority: String(row.priority),                 // numeric -> string
      updated_at: new Date(row.updated_at).toISOString(),
      tags: row.tags,                                  // text[] -> JSON array
      meta: row.meta,                                  // jsonb -> JSON
      _v: 1,                                           // local wireVersion tag (optional)
    };
  },
  decode(wire) {
    return {
      id: wire.id,
      title: wire.title,
      done: !!wire.done,
      priority: wire.priority,                         // keep as string unless app needs number
      updated_at: wire.updated_at,                     // keep ISO string or parse on app boundary
      tags: Array.isArray(wire.tags) ? wire.tags : [],
      meta: wire.meta ?? {},
    } as PgTodoRow;
  },
  wireVersion: 1,
};
```

Testing guidance (internal):
- Round-trip: `decode(encode(row))` equals `row` (or a normalized equivalent).
- Stability: avoid changing wire shape; if needed, bump `wireVersion` and support decoding older versions.
- Property tests: generate random rows and assert invariants on encode/decode.

sync.json note:
- Include a `wireVersion` field per model family if you evolve wire shapes; tools can adapt accordingly.

### External - Error model (SYNC:*)
- Shape: `{ code: string; message: string; helpUrl?: string; meta?: Record<string, unknown> }`.
- Examples: `SYNC:UNAUTHORIZED`, `SYNC:CURSOR_STALE`, `SYNC:CHANGE_REJECTED`, `SYNC:RATE_LIMITED`, `SYNC:SCHEMA_UPGRADE_REQUIRED`.

```json
{
  "error": {
    "code": "SYNC:UNAUTHORIZED",
    "message": "Missing or invalid token.",
    "helpUrl": "https://docs.better-sync.dev/errors#SYNC:UNAUTHORIZED"
  },
  "meta": { "path": "/api/sync" }
}
```

For beginners: Errors use consistent codes and include a link that explains how to fix them.
- Typical HTTP mapping: `SYNC:UNAUTHORIZED` → 401, `SYNC:FORBIDDEN` → 403, `SYNC:CURSOR_STALE` → 409, `SYNC:RATE_LIMITED` → 429.
- Error objects include `helpUrl` and `meta` so you can show a friendly message and log useful details safely.

### External - Backpressure & batching
- Defaults: 1000 changes or ~256KB compressed per batch; compression >8KB (smaller, faster transfers).
- `{ queued: boolean }` on apply; `sync.drain()` (wait until queue flushes); `getQueueStats()` (see sizes); `shouldBackOff()` (when to slow down = backpressure).

```ts
const res = await sync.applyChange("todo", { type: "update", id: "1", patch: { title: "X" } });
if (res.ok && res.value.queued) {
  await sync.drain(); // wait for queue to flush
}
const stats = sync.getQueueStats(); // { size, pendingBatches, bytes }
if (sync.shouldBackOff()) {
  // pause UI-heavy sync actions or show a small indicator
}
```

For beginners: We send data in safe chunks and prevent overload. You can check if work is queued and wait until it’s done.

### External - Persistence & snapshots
- Client: IDB default with `durability: "relaxed" | "strict"`; snapshots (save current state) + compaction (clean up old changes) helpers.
- Server: transactional batch apply (all-or-nothing); coalesce (merge) duplicate ops in batch; per-tenant cursor index (fast bookmarks).

```ts
// Client: take a snapshot and optionally compact
await sync.createSnapshot("todo");
// (compaction may run automatically; helpers will be documented in API)
```

For beginners: The client stores data locally (fast and offline). Snapshots keep things small. The server applies groups of changes safely.

### External - Rate limiting (plugin)
```ts
import { rateLimit } from "better-sync/plugins/rate-limit";
plugins: [rateLimit({ windowMs: 60_000, max: 600, key: (ctx) => ctx.userId ?? ctx.tenantId ?? ctx.ip })];
```
- Returns `SYNC:RATE_LIMITED` with `retryAfterMs` and `Retry-After` header; `windowMs` = time window, `max` = allowed requests, `key` = who to count (user/tenant/ip).

For beginners: This protects your server from too many requests. If a user hits a limit, the error tells them when to try again.

Example: custom strategy
```ts
import { rateLimit } from "better-sync/plugins/rate-limit";

export const server = betterSync({
  // ...
  plugins: [
    rateLimit({
      windowMs: 60_000,
      max: (ctx) => (ctx.roles?.includes("admin") ? 5_000 : 600),
      key: (ctx) => ctx.userId ?? ctx.tenantId ?? ctx.ip,
    }),
  ],
});
```

### External - Tenant helpers
```ts
const t1 = createSyncClient({ baseUrl, storage: idb({ dbName: "app" }) }).withTenant("t1");
await t1.applyChange("todo", { type: "insert", id: "1", value: { title: "A" } });
await server.api.withTenant("t1").apply({ changeSet, ctx: { userId } });
```

For beginners: Multi-tenant apps (like organizations) are easy.
- A "tenant" is a logical group (e.g., company/org). Each tenant has its own data and its own sync cursor.
- `withTenant("t1")` tells the client/server which tenant you want to work with.
- The library keeps tenants separate and avoids leaking data across them.

### External - sync.json metadata endpoint
- GET `${baseUrl}${basePath}/sync.json` returns `{ protocolVersion, features, basePath, methods }`.

```ts
const res = await fetch("http://localhost:3000/api/sync/sync.json");
const meta = await res.json();
// { protocolVersion, features, basePath, methods }
```

For beginners: Tools and dashboards can read this to know what your server supports—no guesswork.

### External - Protocol & transport defaults
- WS default; heartbeat every ~30s to keep the connection alive; exponential backoff with jitter (start ~250–500ms, cap ~30s) for stable reconnects.
- Server cursors are opaque and monotonic per tenant; client never trusts local clock.

```ts
import { ws } from "better-sync/providers/transport";
const sync = createSyncClient({
  models,
  baseUrl: "http://localhost:3000",
  storage: idb({ dbName: "app" }),
  transport: ws({ url: "ws://localhost:3000/api/sync", heartbeatMs: 30000 }),
});
```

For beginners: Real-time by default, with automatic fallbacks and safe retry rules.

### External - SSR / server actions
- Use `server.api.*` directly (no HTTP hop) with `createRequestContext(request)`.

```ts
import { createRequestContext } from "better-sync/server";
import { server } from "@/lib/sync/server";

const ctx = await createRequestContext(request); // { userId, tenantId, roles }
const result = await server.api.apply({ changeSet, ctx });
```

For beginners: On the server, you can call the sync API like regular functions—faster and simpler than making HTTP calls. In frameworks like Next.js, “server actions” are functions that run on the server; use `createRequestContext(request)` to extract user/tenant info from headers/cookies and pass it to `server.api.*`.

### External - Metrics & debug hooks
- Optional `metrics.on(event, data)` for push/pull/conflict/retry; OpenTelemetry adapters later.

```ts
const sync = createSyncClient({
  // ...
  metrics: {
    on(event, data) {
      console.log("sync-event", event, data);
    },
  },
});
```

For beginners: You can log or visualize sync activity to troubleshoot or monitor performance. Common events include `push`, `pull`, `conflict`, and `retry`. You can show these in a dev panel or send them to a metrics tool.

### External - Dev convenience
- `dev.autoServer`: enabled in development, disabled in production; auto-mounts the server handler at `basePath`.

```ts
const sync = createSyncClient({
  // ...
  dev: { autoServer: false }, // disable if you prefer to mount routes yourself in dev
});
```

For beginners: In development, it “just works” without you setting up routes. In production, you control exactly where to mount it.

### External - Migrations policy (databases)
- Recommended: manage schema changes with your DB/ORM tooling (e.g., drizzle-kit) via CLI/CI. Do not auto‑migrate on server startup.
- Provide one‑way, idempotent migrations; review/backup before destructive changes.
- Adapters should not create/alter app tables, only their own required tables when explicitly requested in dev/test.

Example (drizzle‑kit):
```bash
pnpm drizzle:generate  # create SQL from schema
pnpm drizzle:migrate   # apply in CI or local dev
```

### Internal - Contributors (code infrastructure)
- `@bettersync/testkit`: fake transport/storage, deterministic scheduler/clock, conformance runners.
- Type stability tests for public APIs; error factory `syncError(code, message, meta?)` with `SyncErrorCode` union.

For beginners: The project includes tools that make it easier to add features safely without breaking users.
- Testkit: simulate networks and databases to practice sync flows and confirm your adapter logic.
- Conformance: run the same tests against every storage/transport to ensure consistent behavior.
- Type tests: verify that public types and generics infer the right shapes for your app.

Example: run a storage adapter through conformance
```ts
import { createConformanceSuite } from "@bettersync/testkit";
import { sqlite } from "better-sync/providers/storage";

const suite = createConformanceSuite({ storage: sqlite({ file: ":memory:" }) });
await suite.run();
```

### External - Roadmap (package scope)
- MVP: SQLite + IDB, WS default with HTTP fallback, live queries, shapes, LWW+HLC, result-based apply, rate-limit plugin, ensureSchema/autoMigrate, SYNC:* errors, dev.autoServer, metrics hooks.
- Next: Postgres/MySQL adapters, msgpack encoder, CRDT plugin pack, OpenTelemetry, richer devtools.

For beginners: We’ll ship the basics first (so you can build apps now) and add more databases and features over time.