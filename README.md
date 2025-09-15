# just-sync (MVP)

Type-safe sync engine (server + client) with optimistic UI and SSE realtime.

## Install

```bash
npm install just-sync
```

Node.js >= 18, ESM projects only.

## Quickstart

1) Define your schema (Zod example)

```ts
// schema.ts
import { z } from 'zod';
export const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() })
} as const;
```

2) Server: mount the handler

```ts
import { createSync } from 'just-sync';
import { sqliteAdapter } from 'just-sync/storage/server';
import { schema } from './schema';

export const sync = createSync({ schema, database: sqliteAdapter({ url: 'file:./app.db' }) });
export const handler = sync.handler;
```

3) Client: use it

```ts
import { createClient } from 'just-sync';
export const client = createClient({ baseURL: '/api/sync' });
await client.todos.insert({ title: 'Buy milk', done: false });
```

## Next.js

```ts
import { toNextJsHandler } from 'just-sync/next-js';
import { handler } from '@/server/sync';
export const { GET, POST } = toNextJsHandler(handler);
```

## Mutators

```ts
import { z } from 'zod';
export const sync = createSync({
  schema,
  database: sqliteAdapter({ url: 'file:./app.db' }),
  mutators: {
    addTodo: {
      args: z.object({ title: z.string().min(1) }),
      async handler({ db }, { title }) { return db.insert('todos', { title, done: false }); }
    }
  }
});
// client
await client.mutators.addTodo({ title: 'Buy eggs' });
```

## CLI

```bash
npx just-sync generate:schema --adapter sqlite --out migrations/ --schema ./schema.ts
```

Emits `_sync_versions` and optional app tables with PK and `updatedAt`.

See `MVP_SPEC.md` for full spec.