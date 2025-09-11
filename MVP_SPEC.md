## Sync Engine MVP – Product & API Specification

This document codifies the agreed MVP goals, constraints, and API. It is the single source of truth for our initial release. Future agents should read this before implementing or proposing changes.

### Vision
- **Type-safe sync engine for TypeScript** with excellent DX, inspired by Better Auth’s extensibility and simplicity.
- **Environment-agnostic**: serverless/ephemeral friendly, Node, edge runtimes, browsers.
- **SQLite-first MVP**: minimal infra, predictable behavior.
- **Realtime by default**: SSE for updates, HTTP POST for mutations; fall back to HTTP polling only if SSE is unavailable.
- **Bring Your Own Schema**: accept plain Zod/ArkType/TS types; no custom DSL/helpers.
- **Zero user routing**: endpoints internally powered (Better Call under the hood), devs only mount a handler.

### Non-Goals (MVP)
- No DB triggers or CDC/scanning for external writers. MVP observes only writes performed through our API.
- No auth/authorize pipeline in MVP (will be added later without breaking API).
- No query DSL or server-side filter push-down beyond basic shapes (predicate runs client-side in MVP).
- No CLI/codegen. No additional ORMs beyond schema compatibility.

---

## Architecture Snapshot (MVP)
- **Server**: `createSync({ schema, storage })` where storage is a SQLite adapter. Server is authoritative for `id` and `updatedAt`.
- **Transport**: Internally uses Better Call to expose `GET /events` (SSE), `POST /mutate`, `POST /select`. Developer mounts a single exported handler for their framework.
- **Client**: `createClient<typeof schema>({ baseURL, realtime?: 'sse' | 'poll' | 'off', pollIntervalMs? })`. Defaults to SSE realtime; silently falls back to polling if needed.
- **Change propagation**: On successful server mutations (via our API), the server emits an SSE event. Subscribed clients refresh affected data immediately. No background scanners/triggers in MVP.

---

## Schema Model (BYO)
- Single object keyed by collection/table name.
- Accepts Zod/ArkType validators or TS-only types.
- Defaults: `primaryKey = ['id']`, `updatedAt = 'updatedAt'`.
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

```ts
import { createSync } from '@sync/core';
import { sqliteAdapter } from '@sync/adapter-sqlite';
import { schema } from './schema';

export const sync = createSync({
  schema,
  storage: sqliteAdapter({ url: 'file:./app.db' })
});

// Framework mounting (examples)
export const handler = sync.handler;      // Express/Hono style
export const fetch = sync.fetch;          // (req: Request) => Promise<Response>
export const next = sync.nextHandlers();  // { GET, POST } for Next.js route handlers
```

Internalized routes (no configuration needed):
- `GET    /events` – SSE stream (default realtime channel)
- `POST   /mutate` – unified insert/update/delete endpoint
- `POST   /select` – read endpoint

Server behavior:
- Generates IDs (ULID) if missing.
- Sets `updatedAt` (ms) on each write; LWW conflict policy on `updatedAt` with deterministic tie-breaker on `id`.
- Emits SSE events after successful writes.

Auth: Out of scope for MVP. To be added later (headers/callbacks) without breaking API.

---

## Client API (MVP)

```ts
import { createClient } from '@sync/client';
import { schema } from './schema';

export const client = createClient<typeof schema>({
  baseURL: '/api/sync',
  realtime: 'sse',       // default
  pollIntervalMs: 1500   // used only if SSE is unavailable
});

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

```ts
// Insert (returns inserted row(s)); server fills id and updatedAt
const inserted = await client.todos.insert({ title: 'Buy milk', done: false });

// Update by id
const updated = await client.todos.update('t1', { done: true });

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
- On conflict: merge fields (default: all input fields except id/updatedAt) or as specified by `merge`.
- Returns the upserted row(s). Server sets/updates `updatedAt`.

---

## Realtime Semantics
- **Default**: SSE for push notifications on successful server-side mutations.
- **Fallback**: If SSE is unsupported, client falls back to periodic HTTP polling (interval configurable). When events are received, matching `watch` subscriptions refresh their data.
- **External DB writes** (not via our API): Not observed in MVP. Post-MVP will add DB triggers/CDC/scanners.

---

## Consistency & Conflicts
- Server is authoritative for `id` and `updatedAt`.
- Conflict resolution: **LWW** on `updatedAt`, tie-breaker by `id`.
- Server validates rows if a validator is provided (Zod/ArkType). TS-only skips runtime validation.

---

## Errors
Standard JSON error shape:
- `{ code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL', message: string, details?: unknown }`

---

## Extensibility & Internals (MVP boundaries)
- **Transport**: Better Call is internal; developers never import it. We expose `handler`, `fetch`, `nextHandlers` only.
- **Plugins**: Hook system designed but not exposed in MVP; default behavior baked in.
- **Storage**: SQLite adapter only in MVP. Post-MVP: Postgres, D1/libsql, DynamoDB, etc.

---

## Post-MVP Roadmap (high level)
- DB triggers/CDC or incremental scanners to observe external writes.
- Server-side filter push-down and query planner; richer query builder.
- Authentication/authorization hooks (headers → user context → policy).
- Additional adapters (Postgres with LISTEN/NOTIFY, libsql/D1, Redis pubsub notifier).
- CLI/codegen (optional) to generate types, handlers, and project scaffolding.
- WebSocket/SSE multiplexing for advanced realtime; presence and backpressure handling.

---

## Example: Svelte Usage with `.watch`

```ts
// lib/syncClient.ts
import { createClient } from '@sync/client';
import { schema } from '../schema';

export const client = createClient<typeof schema>({ baseURL: '/api/sync' });
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
- Client: `createClient<typeof schema>`; SSE default with HTTP fallback; `.close()`.
- Reads: `select(id|query)` with `{ where, select, orderBy, limit, cursor }` (predicate runs client-side in MVP).
- Subs: `watch(id|query, cb, opts?)` unified API.
- Writes: `insert`, `update(id|where)`, `delete(id|where)`; server authoritative; emits SSE on success.
- Errors: standardized JSON codes.
- Out-of-scope: auth, external write capture, CLI, advanced queries.

---

## Additional MVP Clarifications

### Runtime & Compatibility
- Server runtime target: Node.js 18+ (Bun compatible), not Edge in MVP (due to SQLite driver).
- Client: ESM-first, works in browsers and Node (SSR safe). SSE via `EventSource` in browsers; fetch-based stream on Node.
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
- Mutations are transactional; server sets/normalizes `id` (ULID if missing) and `updatedAt` (ms) before commit.
- Optional idempotency: clients may send `Idempotency-Key` header on `insert/update/delete` to dedupe accidental retries (MVP support is best-effort; duplicates are rare with ULIDs).
- Bulk update/delete by `where` is resolved client-side by first selecting PKs, then performing batch operations by PK on the server.
- Per-row outcomes for bulk operations:
  - `{ ok: number, failed: Array<{ pk: PK, error: { code: string, message: string } }>, pks: Array<PK> }`
- Return shapes:
  - `insert(row|rows) -> row | row[]`
  - `update(id, patch) -> row`
  - `update({ where }, { set }) -> { ok, failed, pks }`
  - `delete(id) -> { ok: true }`
  - `delete({ where }) -> { ok, failed, pks }`

### SSE Event Model (MVP)
- Event is emitted after successful mutation commit. Event payload:
```json
{ "tables": [{ "name": "todos", "pks": ["t1","t2"], "type": "mutation" }] }
```
- The client routes events to active subscriptions:
  - `watch(id, ...)`: if PK matches, re-fetch that row via `select(id)` and emit callback.
  - `watch(query, ...)`: if any table in event matches the watched table, re-run `select(query)` to recompute the snapshot/window.
- Reconnection:
  - On SSE disconnect, client enters `retrying` with exponential backoff (base 500 ms, max 5 s), then resubscribes and re-runs snapshots to reconcile.
  - No cursor is required in MVP since events are library-originated; on reconnect we do a fresh snapshot to avoid misses.
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

### Database Responsibilities (MVP)
- The library does not modify DB settings (e.g., WAL) or create indexes automatically.
- Users are responsible for appropriate indexing (recommended: primary key, and any fields used in orderBy like `updatedAt`).
- We’ll provide docs with recommended indexes and migration examples.

