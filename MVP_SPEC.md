## Sync Engine MVP – Product & API Specification

This document codifies the agreed MVP goals, constraints, and API. It is the single source of truth for our initial release. Future agents should read this before implementing or proposing changes.

### Quickstart (TL;DR)

1) Define your schema
```ts
// schema.ts
import { z } from 'zod';
export const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() })
} as const;
```

2) Mount the server handler
```ts
// server.ts
import { createSyncEngine } from 'just-sync';
import { sqliteNode } from 'just-sync/storage/sqlite-node';
import { schema } from './schema';

export const sync = createSyncEngine({ schema, adapter: sqliteNode({ url: 'file:./app.db' }), mode: 'sse' });
export const handler = sync.handler; // Mount in your framework
```

3) Use the client in your app
```ts
// client.ts
import { createClient } from 'just-sync';
export const client = createClient({ baseURL: '/api/sync' });

// Optimistic by default
await client.todos.insert({ title: 'Buy milk', done: false });

// Live updates
const sub = client.todos.watch({ where: ({ done }) => !done }, ({ data }) => render(data));
```

That’s it. No routing, no cache setup, no manual optimistic code.

### Vision
- **Type-safe sync engine for TypeScript** with excellent DX, inspired by Better Auth’s extensibility and simplicity.
- **Environment-agnostic**: serverless/ephemeral friendly, Node, edge runtimes, browsers.
- **SQLite-first MVP**: minimal infra, predictable behavior.
- **Realtime by default (SSE-first)**: SSE for updates; polling is opt-in via modes (`'sse' | 'sse-poll-fallback' | 'poll'`).
- **Bring Your Own Schema**: first-class Standard Schema support; also accepts Zod/Valibot/ArkType/TypeBox/Yup without user adapters, and plain TS-only objects.
- **Zero user routing**: a single handler is mounted; transport details are internal.

### Non-Goals (MVP)
- No DB triggers or CDC/scanning for external writers. MVP observes only writes performed through our API.
- No built-in auth provider in MVP. Provider-agnostic hooks are available and optional; users bring their own auth (Better Auth, Supabase, Clerk, custom).
- No query DSL or server-side filter push-down beyond basic shapes (predicate runs client-side in MVP).
- No additional ORMs in core; remote SQLite ORM adapters land post‑MVP.

---

## Architecture Snapshot (MVP)
- **Server**: `createSyncEngine({ schema, adapter, mode })`. Server is authoritative for `id` and per-row `version` (ordering/conflicts). `updatedAt` is for UX only.
- **Transport**: Internal unified handler exposes `GET /events` (SSE), `GET /changes` (pull), `POST /mutate`, `POST /select`. Developer mounts a single handler for their framework.
- **Client**: `createClient({ baseURL, mode?: 'sse' | 'sse-poll-fallback' | 'poll', pollIntervalMs? })`. Default `mode: 'sse'`; polling is used only if explicitly configured.
- **Client state**: Local-first optimistic cache applies writes immediately; reconciles on server acknowledgment; rolls back on error. Inserts use temporary IDs remapped to server ULIDs.
- **Realtime resume**: SSE events include monotonic event IDs and support resuming via `Last-Event-ID`. The server tails a DB-backed `_sync_outbox`; if retention is exceeded, the client performs a fresh snapshot.
- **Change propagation**: On successful mutations, the server appends to `_sync_outbox` in the same transaction and emits SSE. Subscribed clients refresh affected data immediately. No DB triggers/CDC in MVP.

---

## Schema Model (BYO)

Core Concepts:
- Single plain object keyed by table name.
- Standard Schema first-class: accepts Standard Schema objects directly, and popular validators (Zod/Valibot/ArkType/TypeBox/Yup) without user adapters. TS-only objects are also accepted (types-only, no runtime validation).
- Defaults: `primaryKey = ['id']`, `updatedAt = 'updatedAt'` (for UX); server-assigned `version` is authoritative for ordering/conflicts.
- Inline overrides allowed per table when DB names differ.

Examples:

```ts
// Zod-only (runtime validation + strong inference)
import { z } from 'zod';

export const schema = {
  todos: z.object({
    id: z.string(),
    title: z.string(),
    done: z.boolean().default(false),
    updatedAt: z.number()
  }),
  posts: {
    table: 'app_posts',
    primaryKey: ['id'],
    updatedAt: 'updated_at',
    schema: z.object({ id: z.string(), title: z.string(), body: z.string(), updated_at: z.number() })
  }
} as const;
```

```ts
// TS-only (no runtime validation)
type Todo = { id: string; title: string; done: boolean; updatedAt: number };

export const schema = {
  todos: {} as unknown as Todo
} as const;
```

Notes:
- We do not provide helper functions. The schema object is plain.
- If a validator is present, server validates mutations; TS-only is types-only.

---

## Server API (MVP)

This section shows how to stand up the server, define custom mutators (server functions), and how request context flows into handlers. The server is authoritative for IDs, versions, and timestamps.

```ts
import { createSync } from 'just-sync';
import { sqliteAdapter } from 'just-sync/storage/server';
import { schema } from './schema';

export const sync = createSync({
  schema,
  database: sqliteAdapter({ url: 'file:./app.db' })
});
// `createSync` wires:
// - transactional mutations
// - version assignment and updatedAt stamping
// - SSE event emission (with eventId, txId, rowVersions, and optional diffs)
// - a unified handler interface (handler/fetch/next)
// Option A (recommended): define mutators in config
export const sync = createSync({
  schema,
  database: sqliteAdapter({ url: 'file:./app.db' }),
  mutators: {
    addTodo: {
      args: z.object({ title: z.string().min(1) }),
      handler: async ({ db, ctx }, { title }) => {
        const row = await db.insert('todos', { title, done: false });
        return row;
      }
    },
    toggleAll: {
      args: z.object({ done: z.boolean() }),
      handler: async ({ db }, { done }) => {
        const { pks } = await db.updateWhere('todos', { set: { done } });
        return { ok: true, count: pks.length };
      }
    }
  }
});

// Option B (advanced): register mutators via method
export const mutators = sync.defineMutators({
  addTodo: {
    args: z.object({ title: z.string().min(1) }),
    handler: async ({ db, ctx }, { title }) => {
      const row = await db.insert('todos', { title, done: false });
      return row;
    }
  },
  toggleAll: {
    args: z.object({ done: z.boolean() }),
    handler: async ({ db }, { done }) => {
      const { pks } = await db.updateWhere('todos', { set: { done } });
      return { ok: true, count: pks.length };
    }
  }
});
// Notes:
// - `args` provides runtime validation. Types are inferred end-to-end.
// - `ctx` can include request metadata (e.g., userId) for future auth.
// - Mutators run inside a server transaction; on success, standard SSE events emit and clients reconcile.

// Framework mounting (examples)
export const handler = sync.handler;          // Express/Hono style
export const fetch = sync.fetch;              // (req: Request) => Promise<Response>
// Next.js (route handlers)
import { toNextJsHandler } from 'just-sync/next-js';
export const { GET, POST } = toNextJsHandler(sync.handler);
```

Internalized routes (no configuration needed):
- `GET    /events` – SSE stream (default realtime channel)
- `POST   /mutate` – unified insert/update/delete endpoint
- `POST   /select` – read endpoint
- `POST   /mutators/:name` – invoke a registered server mutator

Request/response shapes (for reference; client abstracts these):
```http
POST /mutate
Content-Type: application/json
{
  "table": "todos",
  "op": "update", // insert | update | delete | upsert
  "pk": "t1",     // or object for composite
  "set": { "done": true },
  "ifVersion": 1012,           // optional compare-and-set
  "clientOpId": "uuid-..."    // idempotency
}

200 OK
{
  "row": { "id": "t1", "done": true, "updatedAt": 1726..., "version": 1013 }
}
```

```http
POST /select
Content-Type: application/json
{
  "table": "todos",
  "where": null, // client-side predicate in code, server does windowing: select/orderBy/limit/cursor
  "select": ["id","title","done","updatedAt"],
  "orderBy": { "updatedAt": "desc" },
  "limit": 50,
  "cursor": null
}

200 OK
{ "data": [ ... ], "nextCursor": "opaque" }
```

```http
POST /mutators/addTodo
Content-Type: application/json
{ "args": { "title": "Buy milk" }, "clientOpId": "uuid-..." }

200 OK
{ "result": { "id": "t1", "title": "Buy milk", "done": false, "updatedAt": 1726..., "version": 1001 } }
```

Server behavior:
- IDs: Server is authoritative and serverless-friendly.
  - Generates ULIDs for inserted rows. Client-provided ids are always replaced by server-issued ULIDs for scalar PK tables.
  - Responses include `{ tempId, id }` mapping when a temporary client id was used so the client can reconcile.
  - Composite PKs are allowed per table config and are always accepted as provided.
- Sets `updatedAt` (ms) on each write; LWW conflict policy on `updatedAt` with deterministic tie-breaker on `id`.
- Emits SSE events after successful writes.

Auth: Out of scope for MVP. Request context passthrough supported (e.g., headers → `ctx`), enforcement to be added later without breaking API.

---

## Client API (MVP)

The client maintains a local optimistic cache by default with zero configuration. Writes apply immediately, then reconcile with server responses and SSE events. On error, the client auto-rolls back the local change. No developer code is required to enable or manage optimistic behavior.

### Typing & Inference (Better Auth-style)

To get full IntelliSense without generics, add a tiny ambient file once:
```ts
// sync-env.d.ts (type-only; ensure tsconfig includes it)
import type { schema } from './server/schema';
import type { mutators } from './server/sync';

declare module 'just-sync' {
  interface AppTypes {
    Schema: typeof schema;
    Mutators: typeof mutators;
  }
}
```
After this, `createClient({ ... })` is fully typed across tables and RPCs.

Alternative: Exported generics from the server
```ts
// server/sync.types.ts (type-only helper)
import type { schema } from './schema';
import type { mutators } from './sync';

export type AppTypes = {
  Schema: typeof schema;
  Mutators: typeof mutators; // or typeof sync.$mutators if preferred
};
```

```ts
// client.ts
import type { AppTypes } from '../server/sync.types';
import { createClient } from 'just-sync';

export const client = createClient<AppTypes>({ baseURL: '/api/sync' });
```
Notes:
- Uses types-only imports, so no server code is bundled.
- You specify a single generic once; the rest of the client API is fully inferred.

```ts
import { createClient } from 'just-sync';

export const client = createClient({
  baseURL: '/api/sync',
  realtime: 'sse',       // default
  pollIntervalMs: 1500   // used only if SSE is unavailable
});
// Optimistic UI is ON by default; no configuration required.

// Optional: choose a local datastore (no fallback)
// Memory (zero deps, ephemeral)
createClient({ baseURL: '/api/sync', datastore: memory() });

// Web SQLite via absurd-sql (IndexedDB-backed), worker thread by default
createClient({ baseURL: '/api/sync', datastore: absurd() });
// Mutators: typed and dynamic
await client.mutators.addTodo({ title: 'Buy eggs' });
await client.mutators.toggleAll({ done: true });
await client.mutators.call('addTodo', { title: 'Milk' }); // dynamic escape hatch

// Reads and subscriptions automatically stay fresh as mutations land, thanks to SSE.

// Optional teardown
// client.close();
```

### Reads – `select`

```ts
// By id or composite PK object
const one = await client.todos.select('t1', { select: ['id','title','done'] });

// By query (predicate is type-safe; evaluated client-side in MVP)
const { data, nextCursor } = await client.todos.select({
  where: ({ done, title }) => !done && title.includes('milk'),
  select: ['id','title','updatedAt'],
  orderBy: { updatedAt: 'desc' },
  limit: 50,
  cursor: undefined // opaque token; pass previous nextCursor for next page
});
```

### Subscriptions – `watch`

```ts
// Single row
const sub1 = client.todos.watch(
  't1',
  ({ item, change, cursor }) => {
    // item: Todo | null
    // change: { type: 'inserted' | 'updated' | 'deleted'; item?: Todo }
  },
  { select: ['id','title'] }
);

// Query-based (predicate runs client-side in MVP)
const sub2 = client.todos.watch(
  {
    where: ({ done }) => !done,
    select: ['id','title'],
    orderBy: { updatedAt: 'desc' },
    limit: 50
  },
  ({ data, changes, cursor }) => {
    // data: Todo[]
    // changes: { inserted: Todo[]; updated: Todo[]; deleted: Array<string|Record<string,unknown>> }
  }
);

// Handle
sub1.unsubscribe();
```

Subscription handle shape:
- `unsubscribe(): void`
- `status: 'connecting' | 'live' | 'retrying'`
- `error?: Error`
- `getSnapshot(): Row | Row[] | null`

### Writes – `insert` / `update` / `delete`

Writes automatically include a client-generated operation ID for idempotency and clean reconciliation with optimistic state. No setup is required. You may optionally pass a `clientOpId` for correlation/debugging, but it is not needed for correctness.

```ts
// Insert (returns inserted row(s)); server fills id and updatedAt
const inserted = await client.todos.insert({ title: 'Buy milk', done: false });

// Update by id
const updated = await client.todos.update('t1', { done: true });

// Conditional update (compare-and-set): only apply if current version matches
await client.todos.update('t1', { done: true }, { ifVersion: 1012 });

// Delete with rollback handled by the client if the server rejects the change
await client.todos.delete('t1');

// Update by where (client resolves PKs via select, then server updates by PK)
const bulk = await client.todos.update(
  { where: ({ title }) => title.includes('milk') },
  { set: { done: true } }
);

// Delete by id
await client.todos.delete('t1');

// Delete by where (client resolves PKs via select, then server deletes by PK)
await client.todos.delete({ where: ({ done }) => done });
```

Writes are transactional on the server; on success, the server emits SSE events to watching clients. No DB triggers or scanners in MVP.

Local-first optimistic writes (default):
- Client applies changes to a local cache immediately for instant UI.
- On server success (200), cache is reconciled with authoritative row properties (`id`, `updatedAt`).
- On failure, the client automatically rolls back the local change.
- Inserts use temporary IDs that are remapped to server-issued ULIDs upon acknowledgment.

Under the hood (conceptual, handled by the client library):
```ts
const opId = generateClientOperationId();
const tempId = allocateTemporaryId();
applyLocal({ table: 'todos', id: tempId, set: { title: 'Buy milk', done: false } });
try {
  const res = await postMutate({ opId, table: 'todos', set: { title: 'Buy milk', done: false } });
  reconcile({ tempId, realId: res.id, version: res.version, updatedAt: res.updatedAt });
} catch (e) {
  rollback({ opId });
}
```

### Upsert – `upsert`

```ts
// Upsert by primary key
const up = await client.todos.upsert({ id: 't1', title: 'Buy eggs', done: false });

// Upsert many (array)
const ups = await client.todos.upsert([
  { id: 't2', title: 'Call mom', done: false },
  { id: 't3', title: 'Water plants', done: true }
]);

// Options: control merge behavior
const up2 = await client.todos.upsert(
  { id: 't1', title: 'Buy eggs', done: false },
  { merge: ['title', 'done'] } // only these fields updated on conflict
);
```

Semantics:
- Conflict target defaults to primary key.
- On conflict: default merges all provided fields except `id` and `updatedAt`; unspecified fields remain unchanged. To restrict, pass `merge: string[]`. `merge: []` performs no update on conflict (insert-only behavior).
- Returns the upserted row(s). Server sets/updates `updatedAt`.

---

## Realtime Semantics

SSE is the default realtime channel. Each event has a monotonic `id` (ULID) and the server keeps a small ring buffer so clients can resume without a full snapshot after brief disconnects.
- **Default**: SSE for push notifications on successful server-side mutations, with event IDs and resume support.
- **Resume**: Clients include `Last-Event-ID` (or `?since=`) on reconnect to receive any missed events from a small server-side buffer; if the buffer cannot satisfy, the client performs a fresh snapshot.
- **Fallback**: If SSE is unsupported, client falls back to periodic HTTP polling (interval configurable). When events are received, matching `watch` subscriptions refresh their data.
- **External DB writes** (not via our API): Not observed in MVP. Post-MVP will add DB triggers/CDC/scanners.

Defaults:
- SSE `id` format: ULID (monotonic where supported). `eventId` mirrors SSE `id`.
- Ring buffer: retains up to 60 seconds of recent events or the last 10,000 events (whichever smaller). Configurable.
- Heartbeat: send comment `:keepalive` every 15s (configurable).
- Retry: do not send `retry:`; client uses exponential backoff (base 500 ms, max 5 s).
  Example SSE frames:
  ```
  id: 01J9Y0C8WEN8G2YCP0QWQFQ8R9
  event: mutation
  data: {"eventId":"01J9Y0C8WEN8G2YCP0QWQFQ8R9","txId":"01J9Y0C8WF7N6...","tables":[{"name":"todos","type":"mutation","pks":["t1"],"rowVersions":{"t1":1013},"diffs":{"t1":{"set":{"done":true},"unset":[]}}}]}

  :keepalive
  ```

---

## Consistency & Conflicts

We use server-issued versions for causality-aware ordering. This avoids clock skew pitfalls and ensures that newer updates always supersede older ones, even after retries.
- **Server is authoritative** for canonical state and sequencing. Clients reconcile to server-emitted versions.
- **Causality-aware versions**:
  - Each row maintains a server-issued monotonic `version` (e.g., per-table sequence or ULID ordered by time) in addition to `updatedAt`.
  - Writes carry an optional `clientOpId` for idempotency; server dedupes and assigns the next `version`.
  - SSE events include `{ table, pks, rowVersions }` so clients can apply only-newer changes in-order.
- **Conflict resolution**:
  - Default remains row-level last-writer-wins by `version` (server sequence), removing reliance on clock timestamps.
  - Optional per-table field-level merge: specify `merge: ['fieldA','fieldB']` to merge disjoint field updates when concurrent.
- Server validates rows if a validator is provided (Zod/ArkType). TS-only skips runtime validation.

Versions storage (MVP):
- Stored in an internal meta table `_sync_versions(table_name, pk_canonical, version)`, not embedded into user tables. A future option may allow embedding a `version` column.

Row versions & IDs:
- `version`: integer per table, starts at 1 for first insert, increments by 1 per row update/upsert; insert sets version=1.
- Overflow: JavaScript safe up to 2^53-1; practically unreachable in MVP; if exceeded, respond `INTERNAL`.
- `eventId`: ULID in monotonic mode; assumes single-process for ordering (no distributed clock). Clustered ordering is post‑MVP.
- `id` policy: ULID preferred for server-generated scalar PKs; client-provided `id` must be a valid ULID to be honored.

Per-table field-level merge (example):
```ts
import { z } from 'zod';
export const schema = {
  todos: {
    primaryKey: ['id'],
    updatedAt: 'updatedAt',
    merge: ['title','done'], // disjoint field merges allowed
    schema: z.object({ id: z.string(), title: z.string(), done: z.boolean(), updatedAt: z.number() })
  }
} as const;
```

---

## Errors
Standard JSON error shape:
- `{ code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL', message: string, details?: unknown }`

Error codes reference:

| Code          | When it occurs                                      | details example |
|---------------|------------------------------------------------------|-----------------|
| BAD_REQUEST   | Validation fails, payload malformed, limit exceeded  | { field: 'title', reason: 'min:1' } |
| UNAUTHORIZED  | Auth required but missing/invalid (post‑MVP)         | { reason: 'missing token' } |
| NOT_FOUND     | PK not found on update/delete/selectByPk             | { pk: 't1' } |
| CONFLICT      | Version mismatch or unique constraint violation      | { expectedVersion, actualVersion } |
| INTERNAL      | Unhandled errors                                     | { requestId: '...' } |

---

## Extensibility & Internals (MVP boundaries)
- **Transport**: Better Call is internal; developers never import it. We expose `handler`, `fetch`, `nextHandlers` only.
- **Plugins**: Hook system designed but not exposed in MVP; default behavior baked in.
- **Database adapters**: SQLite adapter only in MVP. Post-MVP: Drizzle adapters and additional databases (Postgres, D1/libsql, DynamoDB, etc.).

### Package & Export Layout (MVP)
- Package name: `just-sync`
- Module format: ESM-only (`"type": "module"`), with Node export maps and subpath exports.
- Primary exports:
  - Server core: `import { createSync } from 'just-sync'`
  - Client core: `import { createClient } from 'just-sync'`
- Subpath exports:
  - Server storage adapters: `import { sqliteAdapter } from 'just-sync/storage/server'`
  - Client datastores: `import { memory, absurd } from 'just-sync/storage/client'`
- Type augmentation target: `declare module 'just-sync' { interface AppTypes { ... } }`
 - Next.js integration: `import { toNextJsHandler } from 'just-sync/next-js'` then `export const { GET, POST } = toNextJsHandler(sync.handler)`

---

## Post-MVP Roadmap (high level)
- DB triggers/CDC or incremental scanners to observe external writes.
- Server-side filter push-down and query planner; richer query builder.
- Authentication/authorization hooks (headers → user context → policy).
- Additional adapters (Postgres with LISTEN/NOTIFY, libsql/D1, Redis pubsub notifier).
- Additional codegen (optional) to generate types, handlers, and project scaffolding.
- WebSocket/SSE multiplexing for advanced realtime; presence and backpressure handling.

---

## Example: Svelte Usage with `.watch`

```ts
// lib/syncClient.ts
import { createClient } from 'just-sync';
export const client = createClient({ baseURL: '/api/sync' });
```

```svelte
<!-- routes/TodosList.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { writable } from 'svelte/store';
  import { client } from '$lib/syncClient';

  type Todo = typeof client.todos.$infer;
  const todos = writable<Todo[]>([]);
  let sub: { unsubscribe: () => void } | null = null;

  onMount(() => {
    sub = client.todos.watch(
      { where: ({ done }) => !done, select: ['id','title'], orderBy: { updatedAt: 'desc' }, limit: 50 },
      ({ data }) => todos.set(data)
    );
    return () => sub?.unsubscribe();
  });
</script>

<ul>
  {#each $todos as t}
    <li>{t.title}</li>
  {/each}
  {#if !$todos.length}
    <li>Loading…</li>
  {/if}
</ul>
```

---

## MVP Checklist
- Schema: single plain object; Zod/ArkType/TS-only supported; inline overrides per table.
- Server: `createSync`; SQLite adapter; internal routes `/events`, `/mutate`, `/select`; SSE default.
- Client: `createClient`; SSE default with HTTP fallback; `.close()`.
- Reads: `select(id|query)` with `{ where, select, orderBy, limit, cursor }` (predicate runs client-side in MVP).
- Subs: `watch(id|query, cb, opts?)` unified API.
- Writes: `insert`, `update(id|where)`, `delete(id|where)`; server authoritative; emits SSE on success.
- Errors: standardized JSON codes.
- CLI: opt-in schema generation; generates DDL/migrations; user applies with their tooling.
- Out-of-scope: auth, external write capture, advanced queries.

---

## Additional MVP Clarifications

### Runtime & Compatibility
- Server runtime target: Node.js 18+ (Bun compatible), not Edge in MVP (due to SQLite driver).
- Client: ESM-only, works in browsers and Node (SSR safe). SSE via `EventSource` in browsers; fetch-based stream on Node.
- Packages ship ESM-only with `"type": "module"` and export maps; no CJS builds.
- CORS: same-origin by default; cross-origin allowed if server/framework enables it (not configured by this library in MVP).

### Composite Primary Keys
- PK type is either a scalar (string|number) or an object of key fields.
- API accepts:
  - `select('id')`, `watch('id', ...)` for scalar PK
  - `select({ id, workspaceId })`, `watch({ id, workspaceId }, ...)` for composite PK
- Type inference exposes `typeof client.<table>.$pk`.

### Query Semantics & Limits
- `where` is a client-side predicate in MVP. For query-based `select`/`watch`, the client:
  - performs an initial read with `{ select, orderBy, limit }` (and `cursor` for pagination) to build a snapshot
  - re-runs the same read upon relevant mutation events (see SSE model below)
- Defaults:
  - `limit` default: 100
  - `limit` max: 1000 (excess is clamped)
  - `orderBy` default: `{ updatedAt: 'desc' }`
- `select` narrows fields and types; unspecified implies full row.

### Mutation Semantics & Idempotency
- Mutations are transactional; server sets/normalizes `id` (ULID if missing), assigns a monotonic `version`, and updates `updatedAt` (ms) before commit.
- Idempotency: clients send `clientOpId` (and/or `Idempotency-Key`) on `insert/update/delete`; the server dedupes repeated attempts and returns the same result. Default dedupe window is 10 minutes (configurable).
- Idempotency store: pluggable `IdempotencyStore` with memory default; supports get/set of prior results and optional in-flight locks to coalesce duplicates.
- Bulk update/delete by `where` is resolved client-side by first selecting PKs, then performing batch operations by PK on the server.
- Per-row outcomes for bulk operations:
  - `{ ok: number, failed: Array<{ pk: PK, error: { code: string, message: string } }>, pks: Array<PK> }`
- Return shapes:
  - `insert(row|rows) -> row | row[]`
  - `update(id, patch) -> row`
  - `update({ where }, { set }) -> { ok, failed, pks }`
  - `delete(id) -> { ok: true }`
  - `delete({ where }) -> { ok, failed, pks }`

Conflict error (example):
```json
{
  "code": "CONFLICT",
  "message": "Version mismatch",
  "details": { "expectedVersion": 1012, "actualVersion": 1013 }
}
```

Idempotency scope:
- Key: `{ clientOpId }` (optional `{ clientId }` may be added later). Dedupe TTL: 10 minutes; stored in-memory for MVP (lost on restart).
- If duplicate payload differs, return first successful response and include `{ duplicated: true }` in `details`.

### SSE Event Model (MVP)
- Event is emitted after successful mutation commit. Each SSE message includes a monotonic `id` using the SSE `id:` field to enable resume.
- Event payload (data field) example:
```json
{
  "eventId": "1726080000123-42",
  "txId": "1726080000123-7",
  "tables": [
    {
      "name": "todos",
      "type": "mutation",
      "pks": ["t1","t2"],
      "rowVersions": { "t1": 1012, "t2": 1013 },
      "diffs": {
        "t1": { "set": { "done": true }, "unset": [] }
      }
    }
  ]
}
```
- `eventId`: Global order for resume/dedupe.
- `txId`: Groups changes that committed together; clients can update atomically per transaction.
- `rowVersions`: Per-row monotonic versions so clients only apply newer updates.
- `diffs` (optional): Minimal changes for efficient cache updates. If absent or insufficient, the client reselects.

Diff semantics (MVP):
- Shallow top-level fields only. Arrays replace wholesale.
- If a change cannot be expressed as a shallow diff, `diffs` is omitted for that row and clients reselect.

Composite PK canonicalization:
- Canonical PK string used in `rowVersions`/`diffs` maps is constructed by the declared `primaryKey` order.
- Example: `primaryKey: ['workspaceId','id']`, pk `{ workspaceId: 'w1', id: 't1' }` → canonical `"workspaceId=w1|id=t1"`.

---

## Core Concepts (explained)

- Local-first optimistic cache: The client applies writes immediately for instant UX, then reconciles with server state. On failure, changes auto-rollback. Inserts get a temporary ID remapped to the server-issued ULID.
- Server-authoritative versions: The server assigns a monotonic `version` per row on commit. Clients accept only newer versions, eliminating clock-skew races.
- Idempotent operations: The client attaches a unique operation ID to each write. Retries don’t duplicate effects; the same result is returned.
- Realtime via SSE: The server emits events with `eventId`, `txId`, `rowVersions`, and optional `diffs`. Clients resume on reconnect using `Last-Event-ID`.
- Simple merges: Default row-level last-writer by `version`; optionally merge disjoint field updates when enabled per table.

Client Datastores:
- Pluggable local stores. MVP includes:
  - `memory()` – in-memory, ephemeral. Fastest startup, zero dependencies.
  - `absurd()` – SQLite on the web via absurd-sql (IndexedDB-backed). Runs off the main thread in browsers. No fallback; if initialization fails, it surfaces an error.
- No automatic fallback between datastores to ensure predictable behavior.
- Web default behavior: all datastore operations execute off the main thread (Web Worker). The `absurd` adapter is web-only (uses IndexedDB under the hood).

Examples:
```ts
// Memory (no persistence)
createClient({ baseURL: '/api/sync', datastore: memory() });

// Web SQLite via absurd-sql (IndexedDB-backed), worker thread by default
createClient({ baseURL: '/api/sync', datastore: absurd() });
```

Client datastore contract:
- Threading: on web, runs in a Worker; communication via postMessage; operations must not block main thread.
- Apply vs reconcile: `apply` may stage optimistic state; `reconcile` must accept newer `version` and overwrite; older versions are ignored.

---

## FAQ

Q: Do I need to configure optimistic updates?
A: No. They’re on by default. The client handles temp IDs, reconcile, rollback, and idempotency for you.

Q: What happens if the client disconnects?
A: On reconnect, the client uses `Last-Event-ID` to resume from the server’s buffer. If events are missed beyond the buffer, it takes a fresh snapshot.

Q: How do I run domain logic (validation/side-effects)?
A: Define a server mutator with `defineMutators`. It runs in a transaction and emits standard SSE on success. Call it via `client.mutators.addTodo(args)` or `client.mutators.call(name, args)` dynamically.

Q: Are external DB writes reflected?
A: MVP only observes writes through our API. Post‑MVP we’ll add CDC/triggers to emit events for external writers.

Q: Can I disable realtime?
A: Yes. Set `realtime: 'off'` when creating the client; you can still call `select` and writes will work without subscriptions.
- The client routes events to active subscriptions:
  - `watch(id, ...)`: if PK matches and `rowVersion` is newer than local, apply diff or re-fetch that row via `select(id)` if needed.
  - `watch(query, ...)`: if any table in event matches the watched table, apply diffs to the local window; if not enough info, re-run `select(query)`.
- Reconnection:
  - On SSE disconnect, client enters `retrying` and resubscribes with `Last-Event-ID` to resume from the last processed event.
  - If the server-side buffer cannot replay the requested range, the client performs a fresh snapshot to avoid misses.
- Poll fallback:
  - If SSE is unavailable, client polls `select(query)` on an interval (default 1500 ms) for active `watch`es.

### Security (MVP)
- No authentication/authorization. Intended for trusted/internal environments in MVP.
- CSRF: endpoints are POST-only for mutations; same-origin recommended.
- Future: add pluggable auth (e.g., header → user context) without breaking surface.

### Observability (MVP)
- Minimal server logs: request summary, error logs, and mutation summaries.
- Optional `X-Request-Id` echo; include in error `details` when present.

### Limits
- Max payload size (request/response): 1 MB default (configurable per framework/environment).
- Max batch size for mutations: 100 rows (excess rejected with `BAD_REQUEST`).
- Timeouts: server handlers target 10 s default per request.

### Schema Generation CLI (MVP)
- Provide an opt-in CLI, similar to Better Auth, that generates adapter-specific schema/migrations from the declared application `schema` and chosen adapter.
- The CLI does not auto-apply by default; it primarily scaffolds SQL files and migration scripts in the repo.

Example usage:
```bash
npx just-sync init --adapter sqlite --db-url "file:./app.db"
npx just-sync generate:schema --adapter sqlite --out migrations/
```

Behavior:
- Reads the exported `schema` and adapter configuration.
- Emits adapter-specific DDL for tables, indexes, and the internal `_sync_versions` meta table.
- Generates idempotent migration scripts with checks (create if not exists) and recommended indexes (PK, `updatedAt`).
- Does not change DB engine settings (e.g., WAL). Users run migrations via their own tooling.
- Safe by default: interactive by default.
- Default output format: libsql/D1-style, timestamp-prefixed, one-file-per-migration in the specified `migrations/` directory.

### Adapter Interface (MVP)
Database adapters MUST implement:
- Transactions: `begin()`, `commit()`, `rollback()`
- Row ops: `insert`, `updateByPk`, `deleteByPk`, `selectByPk`
- Windows: `selectWindow({ select, orderBy, limit, cursor })`
- Batch variants for update/delete where applicable
All write methods return authoritative `id`, `updatedAt`, and assigned `version`.

Minimal memory adapter shape (illustrative):
```ts
export function memory() {
  const db = new Map();
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert(table, row) { /* ... return row with id/updatedAt/version */ },
    async updateByPk(table, pk, set) { /* ... */ },
    async deleteByPk(table, pk) { /* ... */ },
    async selectByPk(table, pk) { /* ... */ },
    async selectWindow(query) { /* ... return { data, nextCursor } */ }
  } as const;
}
```

Database adapter contract details:
- Transaction nesting: calling `begin` while a transaction is active must throw `INTERNAL` in MVP (no nested tx support).
- Error mapping (SQLite specifics):
  - Unique constraint violations → `CONFLICT` with `details: { constraint: 'unique', column?: string }` when column can be inferred.
  - Invalid payload / validation failures → `BAD_REQUEST` with per-field details when available.
  - Unexpected/internal errors → `INTERNAL` and include `{ requestId }` if present.
- `selectWindow`: must return rows in the declared `orderBy`; `nextCursor` encodes the last row’s ordering keys.

Cursor design:
- Encoding: base64 of JSON `{ table, orderBy, last: { keys: Record<string, string|number>, id: string } }`.
- Stability: valid only for same `{ table, orderBy }`; changing order or where invalidates the cursor.
- Tie-breakers: always include `id` as final tie-breaker after `updatedAt` and `version`.

Meta table DDL (authoritative):
```sql
CREATE TABLE IF NOT EXISTS _sync_versions (
  table_name   TEXT    NOT NULL,
  pk_canonical TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  PRIMARY KEY (table_name, pk_canonical)
);
```

### Conflict Errors
- On version mismatch, server returns `CONFLICT` with details `{ expectedVersion, actualVersion }`.

### Database Responsibilities (MVP)
- The library does not modify DB settings (e.g., WAL) or create indexes automatically.
- Users are responsible for appropriate indexing (recommended: primary key, and any fields used in orderBy like `updatedAt`).
- We’ll provide docs with recommended indexes and migration examples.

---

## Authoritative Types (MVP)

Type aliases and interfaces an implementer can rely on.

```ts
// Primary key can be scalar or composite object
export type PrimaryKey = string | number | Record<string, string | number>;

export type OrderBy = Record<string, 'asc' | 'desc'>;

export type SelectWindow = {
  select?: string[];
  orderBy?: OrderBy; // default { updatedAt: 'desc' }
  limit?: number;    // default 100, max 1000
  cursor?: string | null;
};

export type MutationOp =
  | { op: 'insert'; table: string; rows: Record<string, unknown> | Record<string, unknown>[] }
  | { op: 'update'; table: string; pk: PrimaryKey; set: Record<string, unknown>; ifVersion?: number }
  | { op: 'updateWhere'; table: string; where: unknown; set: Record<string, unknown> }
  | { op: 'delete'; table: string; pk: PrimaryKey }
  | { op: 'deleteWhere'; table: string; where: unknown }
  | { op: 'upsert'; table: string; rows: Record<string, unknown> | Record<string, unknown>[]; merge?: string[] };

export type MutationRequest = MutationOp & {
  clientOpId?: string;
};

export type MutationResponse =
  | { row: Record<string, unknown> }
  | { rows: Record<string, unknown>[] }
  | { ok: true }
  | { ok: number; failed: Array<{ pk: PrimaryKey; error: { code: string; message: string } }>; pks: PrimaryKey[] };

export type SelectRequest = {
  table: string;
  where?: unknown; // client predicate lives in code; server windows only
  select?: string[];
  orderBy?: OrderBy;
  limit?: number;
  cursor?: string | null;
};

export type SelectResponse = { data: Record<string, unknown>[]; nextCursor?: string | null };

export type SseEvent = {
  eventId: string; // mirrors SSE id
  txId: string;
  tables: Array<{
    name: string;
    type: 'mutation';
    pks: PrimaryKey[];
    rowVersions?: Record<string, number>;
    diffs?: Record<string, { set?: Record<string, unknown>; unset?: string[] }>;
  }>;
};

export interface DatabaseAdapter {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateByPk(table: string, pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }): Promise<Record<string, unknown>>;
  deleteByPk(table: string, pk: PrimaryKey): Promise<{ ok: true }>;
  selectByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
  selectWindow(table: string, req: SelectWindow & { where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }>;
}

export interface ClientDatastore {
  // Called on optimistic apply
  apply(table: string, pk: PrimaryKey, diff: { set?: Record<string, unknown>; unset?: string[] }): Promise<void>;
  // Reconcile authoritative state by version
  reconcile(table: string, pk: PrimaryKey, row: Record<string, unknown> & { version: number }): Promise<void>;
  // Read APIs used by client.select/watch
  readByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
  readWindow(table: string, req: SelectWindow & { where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }>;
}

export interface IdempotencyStore {
  get(key: string): Promise<{ status: 'hit'; response: unknown } | { status: 'miss' }>;
  set(key: string, response: unknown, ttlMs: number): Promise<void>;
  // Optional: prevent duplicate in-flight work
  acquire?(key: string, ttlMs: number): Promise<{ ok: true } | { ok: false }>;
  release?(key: string): Promise<void>;
}
```

---

## Transport Details (SSE)

- HTTP endpoint: `GET /events`
- Headers:
  - Request: `Last-Event-ID` for resume, optional `X-Client-Id` for diagnostics
  - Response: `Content-Type: text/event-stream`, `Cache-Control: no-cache`
- Delivery semantics: at-least-once; idempotent by `eventId` and per-row `version`
- Buffer policy: retain last 60s or 10k events; if resume misses, client performs fresh snapshot

---

## Pagination and Ordering

- Ordering default: `{ updatedAt: 'desc' }`
- Cursor: opaque string; server returns `nextCursor` or `null`
- Limits: default 100, max 1000 (excess clamped)

---

## Mutators Definition (Schema)

```ts
type MutatorDef<Args, Result> = {
  args: unknown; // validator (e.g., zod schema)
  handler(ctx: { db: DatabaseAdapter; ctx: Record<string, unknown> }, args: Args): Promise<Result>;
};

type Mutators = Record<string, MutatorDef<any, any>>;

createSync({
  schema,
  database,
  mutators: {
    addTodo: { args: z.object({ title: z.string() }), handler: async ({ db }, { title }) => db.insert('todos', { title, done: false }) }
  }
});
```

Mutators endpoint and validation:
- Route: `POST /mutators/:name`
- Request: `{ args: unknown, clientOpId?: string }` with `Content-Type: application/json`
- Response: `{ result: unknown }` or error with standard shape.
- Validation failures map to `BAD_REQUEST` with per-field details when available.

---

## End-to-End Flow (Optimistic Write to Realtime Update)

1) Client issues `insert` (optimistic):
   - Generate `clientOpId` and temp `id`.
   - Apply local diff to datastore.
2) Server processes `/mutate`:
   - Begin tx → assign `id` (if missing), `updatedAt`, `version` → commit.
   - Emit SSE with `eventId`, `txId`, `rowVersions`, optional `diffs`.
3) Client receives 200 response:
   - Reconcile temp ID to real ID; ensure local version matches.
4) Client receives SSE event:
   - If newer `rowVersion`, apply diff or select row; update all subscriptions.
5) On disconnect:
   - Client reconnects with `Last-Event-ID`. If buffer miss, run fresh snapshot.

Sequence (text diagram):
```
App UI → client.insert → local apply (opId,tempId)
        → POST /mutate(opId) → Server tx (id,updatedAt,version) → commit
        ← 200 {row}                      → SSE: id:eventId\ndata:{...}
App UI ← reconcile(tempId→id,version)    ← apply event (diff/version)
```

