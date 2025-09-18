## Just Sync – New MVP Specification (TypeScript-only, BYO-DB, SSE-first)

This is the consolidated MVP spec reflecting our updated principles: Standard Schema first-class, database as the single source of truth, provider-agnostic auth, SSE-first realtime, derived client types with no codegen or generics, and zero extra infrastructure.

---

### Quickstart (TL;DR)

1) Define your schema (Standard Schema or a common validator; plain TS-only also works)
```ts
// schema.ts
import { z } from 'zod';

export const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() })
} as const; // Standard Schema objects also work directly; no adapters needed
```

2) Mount the server handler (mutators inside `createSyncEngine`)
```ts
// server.ts
import { createSyncEngine } from 'just-sync';
import { sqliteNode } from 'just-sync/storage/sqlite-node';
import { z } from 'zod';
import { schema } from './schema';

export const sync = createSyncEngine({
  schema,
  adapter: sqliteNode({ url: 'file:./app.db' }),
  mode: 'sse', // 'sse' | 'sse-poll-fallback' | 'poll'
  mutators: {
    addTodo: {
      args: z.object({ title: z.string().min(1) }),
      async handler({ db }, { title }) {
        return db.insert('todos', { title, done: false });
      }
    }
  }
});

export const handler = sync.handler; // mount in your framework
```

3) Use the client (types derive automatically from the server)
```ts
// client.ts
import { createClient } from 'just-sync';

export const client = createClient({
  baseURL: '/api/sync',
  mode: 'sse'
});

await client.todos.insert({ title: 'Buy milk', done: false });
const sub = client.todos.watch({ where: ({ done }) => !done }, ({ data }) => render(data));
```

---

## Principles & Scope

- Database is the single source of truth (SoT): versions, events, idempotency persisted in your DB.
- No extra infrastructure: no separate queues/brokers/backplanes; a DB connection is enough.
- Serverless-ready: stateless handlers; durable resume via DB-backed outbox; opt-in polling.
- Great DX: minimal API, Standard Schema first-class, strong typing without codegen/generics.
- Audience: developers who want simple setup, self-contained libraries, and minimal infra.

Non-goals (MVP):
- No CDC/triggers to observe external writers (post‑MVP).
- No built-in auth provider (hooks only; bring your own).
- No rich query planner or server-side filter pushdown (basic windows only).
- No additional DBs beyond SQLite family at MVP time; ORM-backed remote SQLite follows.

---

## Architecture Snapshot

- Server: `createSyncEngine({ schema, adapter, mode, mutators, auth?, policies? })`.
  - Authoritative `version` per row (ordering/conflicts). `updatedAt` is for UX only.
- Transport: single handler exposing
  - `GET /events` (SSE)
  - `GET /changes` (pull changes; only in modes that permit polling)
  - `POST /mutate`, `POST /select`, `POST /mutators/:name`
- Client: `createClient({ baseURL, mode?: 'sse' | 'sse-poll-fallback' | 'poll', pollIntervalMs?, datastore? })`.
  - Default `mode: 'sse'`; no polling unless explicitly enabled.
- State & consistency:
  - DB-backed tables written transactionally with each mutation: `_sync_versions`, `_sync_outbox`, `_sync_ops`.
  - SSE resumes via `Last-Event-ID` reading `_sync_outbox` (no in-memory buffer).

---

## Schema Model (BYO, Standard Schema first-class)

Core:
- Single plain object keyed by table name.
- Accepts Standard Schema objects directly; also accepts Zod/Valibot/ArkType/TypeBox/Yup without user adapters; plain TS-only objects are allowed.
- Defaults: `primaryKey = ['id']`, `updatedAt = 'updatedAt'` (UX); server `version` governs ordering/conflicts.
- Per-table overrides (db table name, PKs, updatedAt name, id policy).

Examples:
```ts
// Standard Schema or Zod – both are accepted without adapters
import { z } from 'zod';
export const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() }),
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
export const schema = { todos: {} as unknown as Todo } as const;
```

---

## Server API

```ts
import { createSyncEngine } from 'just-sync';
import { sqliteNode } from 'just-sync/storage/sqlite-node';
import { z } from 'zod';
import { schema } from './schema';

export const sync = createSyncEngine({
  schema,
  adapter: sqliteNode({ url: 'file:./app.db' }),
  mode: 'sse',
  mutators: {
    addTodo: { args: z.object({ title: z.string().min(1) }), async handler({ db }, { title }) { return db.insert('todos', { title, done: false }); } },
    toggleAll: { args: z.object({ done: z.boolean() }), async handler({ db }, { done }) { const { pks } = await db.updateWhere('todos', { set: { done } }); return { ok: true, count: pks.length }; } }
  },
  auth: {
    // Provider-agnostic: Better Auth, Supabase, Clerk, custom JWT, etc.
    async getUser({ request }) { /* verify token/cookie */ return null as { userId: string, tenantId?: string } | null; }
  },
  policies: {
    rowFilter: ({ user, table }) => user?.tenantId ? { tenantId: user.tenantId } : null,
    authorize: ({ user }) => !!user
  }
});

export const handler = sync.handler;
```

Internal routes:
- `GET /events` – SSE stream (default realtime channel)
- `GET /changes` – pull changes feed (used only if mode permits polling)
- `POST /mutate` – unified insert/update/delete endpoint
- `POST /select` – read endpoint
- `POST /mutators/:name` – invoke a server mutator

Server behavior:
- IDs: server authoritative; generates ULIDs by default. Client-provided ids are honored only with an allow policy (e.g., valid ULID); composite PKs accepted as provided.
- `version` (row-level, monotonic) is the sole ordering/conflict authority; `updatedAt` is UX-only.
- `_sync_versions` upserted and `_sync_outbox` appended within the same transaction; SSE emitted after commit.
- Idempotency: `_sync_ops` stores `${clientId}:${clientOpId}` responses with TTL; dedupes across retries and restarts.

Request/response examples (abbrev.):
```http
POST /mutate
{"table":"todos","op":"update","pk":"t1","set":{"done":true},"ifVersion":1012,"clientOpId":"uuid"}

200 OK
{"row":{"id":"t1","done":true,"updatedAt":1726,"version":1013}}
```

```http
GET /changes?since=01J9Y0...
200 OK
{"events":[{"eventId":"01J9Y0...","table":"todos","pk":"t1","version":1013,"diff":{"set":{"done":true}}}],"hwm":"01J9Y0..."}
```

---

## Client API

Derived types (no generics/codegen):
- Types derive automatically from the server `sync.$types`.
- Monorepo: zero extra steps.
- Split-repo: add a types-only import file that references the server `sync` module to make `sync.$types` visible (no runtime import).

Constructing the client:
```ts
import { createClient } from 'just-sync';

export const client = createClient({ baseURL: '/api/sync', mode: 'sse' });

await client.mutators.addTodo({ title: 'Eggs' });
const { data } = await client.todos.select({ where: ({ done }) => !done, limit: 50 });
const sub = client.todos.watch({ where: ({ done }) => !done }, ({ data }) => render(data));
```

Optional datastores:
- `memory()` – in-memory, ephemeral (fastest startup).
- `absurd()` – browser SQLite via absurd-sql (IndexedDB-backed), worker by default.

---

## Realtime Semantics

Default mode is `sse` (no polling). Each event has a monotonic `id` (ULID). The server tails a DB-backed `_sync_outbox`.
- Resume: client sends `Last-Event-ID`; server streams from the next event. If retention is exceeded, client does a fresh snapshot and resumes from the new high-water mark.
- Polling: opt-in via `sse-poll-fallback` or `poll`; client calls `GET /changes?since=`.
- External writers: not observed in MVP; post‑MVP adds CDC/triggers.

Defaults:
- Keepalive: send `:keepalive` every 15s.
- Backoff: client exponential backoff (base ~500 ms, max ~5 s).
- Frame caps: server caps bytes per message and pages outbox reads.

---

## Consistency & Conflicts

- Server-issued `version` per row (monotonic) governs ordering and conflict resolution.
- Row-level LWW by `version` (no field-level merge in MVP). Optional `ifVersion` enables compare-and-set on updates.
- `_sync_versions(table_name, pk_canonical, version)` stores authoritative versions.
- `eventId`: ULID; ordering within a single process; clustered ordering is post‑MVP.
- `id` policy: server ULID preferred; client ULIDs can be accepted per-table via policy.

---

## Auth & Policies (provider-agnostic)

- `auth.getUser({ request })` → `{ userId, tenantId?, roles? } | null`.
- `policies.rowFilter({ user, table })` → implicit filter for reads and SSE/changes.
- `policies.authorize({ user, table, op, pk, input })` → boolean/throw.
- Multitenancy: store `tenantId` on `_sync_outbox` rows; server filters by tenant.
- Works with Better Auth, Supabase, Clerk, custom JWT/cookies.

---

## Errors

Standard JSON error shape:
`{ code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL', message: string, details?: unknown }`

Examples:
- Validation fails → `BAD_REQUEST { field, reason }`
- Version mismatch → `CONFLICT { expectedVersion, actualVersion }`
- Unauthorized → `UNAUTHORIZED { reason }`

---

## Package & Exports

- Package: `just-sync`
- ESM-only with export maps
- Server: `import { createSyncEngine } from 'just-sync'`
- Client: `import { createClient } from 'just-sync'`
- Server adapters: `import { sqliteNode } from 'just-sync/storage/sqlite-node'`
- Client datastores: `import { memory, absurd } from 'just-sync/storage/client'`
- Next.js helper: `import { toNextJsHandler } from 'just-sync/next-js'`
- Types: derived from `sync.$types` automatically (no generics/codegen)

---

## Adapters

- Local SQLite (Node): prefer the official Node SQLite driver when available; fallback (e.g., better‑sqlite3) auto-detected by `sqliteNode`.
- Remote SQLite (libsql/Turso, Cloudflare D1): ORM-backed adapters (Drizzle, Kysely) with the same engine contract (tx/insert/update/delete/select/window).
- Post‑MVP: additional DBs (Postgres, etc.) and realtime integrations (LISTEN/NOTIFY) behind the same API.

---

## Runtime & Compatibility

- Server runtime: Node.js 18+ (Bun compatible); SQLite driver determines exact minimum.
- Client: ESM-only; works in browsers and Node (SSR-safe). SSE via EventSource; fetch-based stream for Node.
- CORS & CSRF: library does not configure CORS/CSRF; recommend same-origin and POST for mutations.

---

## Query Semantics & Limits

- `select` windows with `{ select, orderBy, limit, cursor }`; predicates run client-side in MVP.
- Defaults: `limit` default 100, max 1000 (clamped); `orderBy` default `{ updatedAt: 'desc' }`.
- Cursor: opaque; encodes last ordering keys; stable for same `{ table, orderBy }`.

---

## Mutation Semantics & Idempotency

- Mutations run in a DB transaction: assign/normalize `id`, stamp `updatedAt`, assign `version`, upsert `_sync_versions`, append `_sync_outbox`.
- Idempotency: clients send `clientOpId`; server dedupes using `_sync_ops` (`${clientId}:${clientOpId}`), TTL default 10 minutes.
- Bulk ops by where: client resolves PKs via select, then server updates/deletes by PK.

---

## SSE Event Model (MVP)

Event emitted after commit; `id:` uses `eventId` (ULID) for resume.
Payload example:
```json
{
  "eventId": "01J9Y0C8WEN8...",
  "txId": "01J9Y0C8WF7N6...",
  "tables": [
    {
      "name": "todos",
      "type": "mutation",
      "pks": ["t1"],
      "rowVersions": { "t1": 1013 },
      "diffs": { "t1": { "set": { "done": true }, "unset": [] } }
    }
  ]
}
```

Diff semantics: shallow top-level; arrays replace wholesale; if a diff cannot be expressed, omit and let the client reselect.

---

## End-to-End Flow (Optimistic Write ➜ Realtime Update)

1) Client issues insert (optimistic): alloc temp id, apply local diff, send `POST /mutate` with `clientOpId`.
2) Server tx: assign `id` (if needed), `updatedAt`, `version`; upsert `_sync_versions`; append `_sync_outbox`; commit.
3) Client 200 OK: reconcile temp id → real id; ensure local version.
4) Client SSE event: apply newer `rowVersion` via diff or reselect; update subscriptions.
5) Reconnect: resume from `Last-Event-ID` or fresh snapshot if retention exceeded.

---

## Performance Targets & Methods

Targets (guidance; Node + local SQLite, single instance):
- p50 write 20–35 ms; p95 80–120 ms (single-row)
- p50 select(50) 10–25 ms; p95 60–90 ms
- ≥ 1k ops/s per instance with prepared statements and proper indexing

Methods:
- Prepared statements; minimal JSON; shallow diffs; paged outbox reads
- Indexes: PK, `updatedAt` (if used), `_sync_outbox(created_at)`, `_sync_outbox(table_name, version)`
- Backpressure: cap payload sizes; limit per-frame events; exponential backoff
- Connection pooling in long-lived processes; per-request connections in serverless

---

## CLI (MVP)

- `npx just-sync init --adapter sqlite --db-url "file:./app.db"`
- `npx just-sync generate:schema --adapter sqlite --out migrations/`

Behavior:
- Reads the exported `schema` and adapter config
- Emits adapter-specific DDL for tables, indexes, and `_sync_versions`/`_sync_outbox`/`_sync_ops`
- Generates idempotent migrations; does not change DB engine settings (WAL etc.)

---

## MVP Checklist

- Schema: single plain object; Standard Schema first-class; common validators and TS-only supported; table overrides
- Server: `createSyncEngine`; SQLite Node adapter; internal routes `/events`, `/changes`, `/mutate`, `/select`; SSE default
- Client: `createClient`; SSE default; derived types auto; teardown via `.close()`
- Reads: `select(id|query)` with `{ where, select, orderBy, limit, cursor }` (predicate client-side)
- Subs: `watch(id|query, cb, opts?)` unified API
- Writes: `insert`, `update(id|where)`, `delete(id|where)`, `upsert`; server authoritative; emits SSE on success
- Consistency: row-level LWW by `version`; `_sync_versions` authoritative; `_sync_outbox` for resume
- Idempotency: `_sync_ops` DB-backed store; TTL defaults
- Errors: standardized JSON codes
- CLI: schema generation and checks; user applies migrations
- Out-of-scope: external write capture, advanced queries, built-in auth provider

