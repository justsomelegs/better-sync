## just-sync

Type-safe sync engine for TypeScript with excellent DX. Server + client, realtime via SSE, SQLite-first with pluggable adapters.

### Install

```bash
npm install just-sync
```

### Quickstart

1) Define a schema (Zod or TS-only)

```ts
// schema.ts
import { z } from 'zod';
export const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean(), updatedAt: z.number() })
} as const;
```

2) Mount the server handler

```ts
// server.ts
import { createSync } from 'just-sync';
import { sqliteAdapter } from 'just-sync/storage/server';
import { schema } from './schema';

export const sync = createSync({ schema, database: sqliteAdapter({ url: 'file:./app.db' }) });
export const handler = sync.handler; // mount in your framework
```

3) Use the client

```ts
// client.ts
import { createClient } from 'just-sync';
export const client = createClient({ baseURL: '/api/sync' });

await client.todos.insert({ title: 'Buy milk', done: false });
const unsub = client.todos.watch((evt) => render(evt.data));
// later: unsub()
```

### Next.js route handlers

```ts
// app/api/sync/route.ts
import { toNextJsHandler } from 'just-sync/next-js';
import { handler as syncHandler } from '../../server';
export const { GET, POST } = toNextJsHandler(syncHandler);
```

### Better Auth-style typing (optional but recommended)

Create a type-only augmentation once for full IntelliSense across tables and mutators.

```ts
// sync-env.d.ts
import type { schema } from './server/schema';
import type { sync } from './server/sync'; // the result of createSync

declare module 'just-sync' {
  interface AppTypes {
    Schema: typeof schema;
    Mutators: typeof sync['mutators'];
  }
}
```

Now `createClient({ ... })` is fully typed without generics.

### Client API highlights

- `client.<table>.select({ where?, select?, orderBy?, limit?, cursor? })`
- `client.<table>.insert(row)` / `update(pk, patch, { ifVersion? })` / `delete(pk)` / `upsert(row|rows, { merge? })`
- `client.watch('table' | { table, where?, select?, orderBy?, limit? }, cb, { initialSnapshot?, debounceMs? })`
  - Returns a handle with: `unsubscribe()`, `status: 'connecting'|'live'|'retrying'`, `error`, `getSnapshot()`
- `client.close()` to teardown SSE/polling and watchers
- Local datastores: `memory()` (in-memory), `absurd()` (SQLite via sql.js/IndexedDB + Worker)

### CLI (SQLite)

```bash
npx just-sync generate:schema --adapter sqlite --out migrations --schema ./server/schema.ts
```

Generates:
- `_sync_versions` meta table
- App tables from your schema, honoring custom `primaryKey` and `updatedAt`
- Index on `updatedAt`

### Adapters

- SQLite (built-in, file-backed via sql.js export)
- Postgres (LISTEN/NOTIFY post-MVP)
- libsql/Turso
- Drizzle, Prisma adapters for query builders

### Realtime

- SSE with `Last-Event-ID` resume and small ring buffer
- Client dedupes by event id and performs debounced snapshots per table
- Optional diffs in mutation events for faster UI updates; see `docs/REALTIME.md`

### Errors

JSON errors with `{ code, message, details }`. Common codes: `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, `INTERNAL`.

### Examples

- `examples/nextjs` – route handlers + client watch
- `examples/node` – minimal server mounting

See `MVP_SPEC.md` for the deeper specification and roadmap.

### Request Context (Auth-ready)

Derive per-request context (user/session/tenant) via `createSync({ context })` and consume it inside mutators:

```ts
export const sync = createSync({
  schema,
  database: sqliteAdapter({ url: 'file:./app.db' }),
  context: async (req) => {
    const cookie = req.headers.get('cookie') || '';
    const session = await myAuth.getSessionFromCookie(cookie);
    return { userId: session?.user?.id ?? null, roles: session?.user?.roles ?? [] };
  },
  mutators: {
    addTodo: {
      args: z.object({ title: z.string().min(1) }),
      handler: async ({ db, ctx }, { title }) => {
        if (!ctx.userId) throw new SyncError('BAD_REQUEST', 'Unauthenticated');
        return db.insert('todos', { title, done: false, ownerId: ctx.userId });
      }
    }
  }
});
```

See `docs/CONTEXT.md` for a comprehensive guide (JWT, cookies, Clerk/Auth0).

