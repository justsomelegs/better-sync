# TS Sync Engine

TypeScript-only sync engine with bring-your-own-database adapters. No extra infra. Serverless-ready.

## Quickstart

1. Install deps and build:

```bash
pnpm i
pnpm build
```

2. Run example:

```bash
pnpm example
```

## Usage

```ts
import { createSyncEngine, defineCollection, InMemoryAdapter } from "ts-sync-engine";

interface Todo { id: string; title: string; done: boolean }
const Todos = defineCollection<Todo>({
  name: "todos",
  version: 1,
  parse: (x) => {
    const t = x as Partial<Todo>;
    if (!t || typeof t.id !== "string" || typeof t.title !== "string" || typeof t.done !== "boolean") throw new Error("Invalid todo");
    return { id: t.id, title: t.title, done: t.done };
  },
});

const engine = createSyncEngine({ db: new InMemoryAdapter(), schemas: { todos: Todos } });
await engine.put("todos", "t1", { id: "t1", title: "Build", done: false });
const changes = await engine.pull({ since: 0 });
```

## Adapters

- InMemory (for tests)
- SQLite/libSQL via `SQLiteAdapter`
- Postgres via `PostgresAdapter`

Bring your own connection/client; the library only calls simple methods.

## Principles

- Bring your own DB
- No extra infrastructure
- Serverless-ready
- Explicit, typed APIs

