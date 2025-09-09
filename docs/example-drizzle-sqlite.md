# SvelteKit + Drizzle (SQLite) with Better Sync

This example shows a SvelteKit project using Drizzle + SQLite on the server and a local‑first client. It includes:
- Drizzle tables for `op_log` and `snapshots`
- A `StorageAdapter` via `createOrmAdapter`
- A SvelteKit route mounted at `/api/sync` that delegates to `betterSync`
- A minimal client setup you can import in Svelte components

## Project structure (suggested)

```
src/
  lib/
    server/
      db/
        index.ts
        schema.ts
      sync/
        storage.ts
        server.ts
    client/
      sync.ts
  routes/
    api/
      sync/
        +server.ts
```

## 1) Install

```bash
pnpm add drizzle-orm better-sqlite3
pnpm add -D drizzle-kit
# or: npm i drizzle-orm better-sqlite3 && npm i -D drizzle-kit
```

## 2) Drizzle schema (SQLite)

```ts
// src/lib/server/db/schema.ts
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const opLog = sqliteTable('op_log', {
  seq: integer('seq').primaryKey({ autoIncrement: true }), // server cursor (monotonic)
  opId: text('op_id').notNull().unique(),                  // idempotency key
  tenantId: text('tenant_id').notNull(),
  model: text('model').notNull(),
  pk: text('pk').notNull(),
  op: text('op').notNull(),                                // 'insert' | 'update' | 'delete'
  actor: text('actor').notNull(),
  updatedAt: text('updated_at').notNull(),                 // ISO string
  payload: text('payload').notNull(),                      // JSON-serialized row/patch
});

export const snapshots = sqliteTable('snapshots', {
  tenantId: text('tenant_id').notNull(),
  model: text('model').notNull(),
  id: text('id').notNull(),
  value: text('value').notNull(),                          // JSON-serialized snapshot
}, (t) => ({
  pk: [t.tenantId, t.model, t.id],                         // composite primary key
}));
```

## 3) Migrations (drizzle-kit)

Create a `drizzle.config.ts` at the project root:

```ts
// drizzle.config.ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/lib/server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
} satisfies Config;
```

Add scripts:

```json
// package.json
{
  "scripts": {
    "drizzle:generate": "drizzle-kit generate",
    "drizzle:migrate": "drizzle-kit migrate"
  }
}
```

Usage:

```bash
pnpm drizzle:generate  # generate SQL from your schema
pnpm drizzle:migrate   # apply migrations to ./data.db
```

## 4) Drizzle database init (no runtime migrations)

Apply migrations via CLI in your dev/CI workflow. Do not auto‑migrate at runtime.

```ts
// src/lib/server/db/index.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

export const sqlite = new Database('./data.db');
export const db = drizzle(sqlite);
// Migrations are applied out‑of‑process via drizzle-kit CLI
```

## 5) Storage adapter via Drizzle (BYO ORM)

```ts
// src/lib/server/sync/storage.ts
import { db } from '$lib/server/db';
import { eq, and, gt, asc } from 'drizzle-orm';
import { opLog, snapshots } from '$lib/server/db/schema';
import { createOrmAdapter } from 'better-sync/adapters';

export const storage = createOrmAdapter({
  withTransaction: async (fn) => db.transaction(fn),

  insertChanges: async ({ tx, rows }) => {
    const d = tx ?? db;
    await d.insert(opLog).values(
      rows.map((r) => ({
        tenantId: r.tenantId,
        model: r.model,
        pk: r.pk,
        op: r.op,
        actor: r.actor,
        updatedAt: r.updated_at, // ISO string
        payload: JSON.stringify(r.payload),
        opId: r.op_id,
      }))
    );
  },

  selectChangesSince: async ({ tenantId, vector, limit }) => {
    const since = Number(vector?.seq ?? 0);
    const rows = await db
      .select()
      .from(opLog)
      .where(and(eq(opLog.tenantId, tenantId), gt(opLog.seq, since)))
      .orderBy(asc(opLog.seq))
      .limit(limit ?? 1000);

    return rows.map((r) => ({
      seq: r.seq,
      op_id: r.opId,
      tenantId: r.tenantId,
      model: r.model,
      pk: r.pk,
      op: r.op as 'insert' | 'update' | 'delete',
      actor: r.actor,
      updated_at: r.updatedAt,
      payload: JSON.parse(r.payload),
    }));
  },

  readSnapshot: async ({ tenantId, model, id }) => {
    const row = await db
      .select({ value: snapshots.value })
      .from(snapshots)
      .where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.model, model), eq(snapshots.id, id)))
      .then((r) => r[0]);
    return row ? JSON.parse(row.value) : null;
  },

  writeSnapshot: async ({ tx, tenantId, model, id, value }) => {
    const d = tx ?? db;
    await d
      .insert(snapshots)
      .values({ tenantId, model, id, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: [snapshots.tenantId, snapshots.model, snapshots.id],
        set: { value: JSON.stringify(value) },
      });
  },
});
```

Notes:
- We serialize JSON into `TEXT` for SQLite (`payload`, `value`).
- `seq` is the server cursor. The client uses opaque cursors; it never relies on its local clock.
- Migrations: generate/apply with drizzle‑kit CLI only. Avoid auto‑migrating in production servers.

## 6) betterSync server (SvelteKit)

```ts
// src/lib/server/sync/server.ts
import { betterSync } from 'better-sync';
import { jwt } from 'better-sync/providers/auth';
import { storage } from '$lib/server/sync/storage';

export const server = betterSync({
  basePath: '/api/sync',
  storage,
  auth: jwt({ jwksUrl }),
  conflict: 'lww',
  authorize: async (req) => ({ userId, tenantId, roles }),
  canRead: (ctx, table, row) => true,
  canWrite: (ctx, table, row) => true,
});

export const handler = server.fetch();
```

## 7) SvelteKit route: mount `/api/sync`

```ts
// src/routes/api/sync/+server.ts
import type { RequestHandler } from './$types';
import { handler } from '$lib/server/sync/server';

export const GET: RequestHandler = async ({ request }) => handler(request);
export const POST: RequestHandler = async ({ request }) => handler(request);
export const OPTIONS: RequestHandler = async ({ request }) => handler(request);
```

This delegates SvelteKit requests to the `betterSync` server. WebSocket support is provided by the transport; HTTP fallback works via the same route.

## 8) Client (IndexedDB + RPC)

```ts
// src/lib/client/sync.ts
import { createSyncClient } from 'better-sync';
import { idb } from 'better-sync/providers/storage';
import { rpc } from 'better-sync/providers/transport';

export const sync = createSyncClient({
  models,
  baseUrl: 'http://localhost:5173', // dev: SvelteKit default port; adjust for prod
  storage: idb({ dbName: 'app' }),
  transport: rpc({ baseUrl: 'http://localhost:5173' }),
  auth: { headers: () => ({ Authorization: `Bearer ${token()}` }) },
  conflict: 'lww',
  dev: { autoServer: true },
});
```

Use in a Svelte component:

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { sync } from '$lib/client/sync';
  onMount(async () => {
    await sync.connect();
  });
</script>
```

## 9) Optional: wire normalization

SQLite is JSON‑friendly; defaults usually need no changes. If you ever need custom serializers:

```ts
// Globally (off)
// storage: sqlite({ file: './data.db', wire: { normalize: 'off' } })

// Per-model override
// storage: sqlite({ file: './data.db', wire: { serializers: { todo: { encode, decode } } } })
```

## 10) End‑to‑end (apply a change)

```ts
// In any client module (browser)
await sync.applyChange('todo', {
  type: 'insert',
  id: '1',
  value: { id: '1', title: 'Write docs', done: false, updated_at: new Date().toISOString() },
});
```

That’s it—SvelteKit + Drizzle (SQLite) on the server, local‑first client in the browser.
