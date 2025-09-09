# Postgres-backed server with local-first sync (types and mapping)

This example shows how to use a Postgres database on the server while keeping a local-first client database (IndexedDB/sql.js). It covers:
- How the client stores and syncs data locally
- How the server persists changes in Postgres
- How to map Postgres-specific types (uuid, jsonb, numeric, arrays, timestamps) to portable JSON for the protocol
- Recommended schema for the op_log and snapshots in Postgres

## Overview
- Client: local storage (IDB in browser) + RPC/WS transport → pushes/pulls JSON changesets
- Server: Postgres storage provider (or ORM adapter) → appends to `op_log` and serves changes using a monotonic cursor
- Protocol: JSON-only on the wire; types are normalized for portability (e.g., timestamps → ISO8601 strings)

## 1) Client setup (local)
Use IndexedDB by default. Keep your app responsive offline; the engine will push/pull when online.

```ts
import { createSyncClient } from "better-sync";
import { idb } from "better-sync/providers/storage";
import { rpc } from "better-sync/providers/transport";

const sync = createSyncClient({
  models, // defined below with type-safe schemas
  baseUrl: "http://localhost:3000", // absolute origin
  storage: idb({ dbName: "app" }),
  transport: rpc({ baseUrl: "http://localhost:3000" }),
});
```

## 2) Server setup (Postgres)
Use a dedicated Postgres storage provider or bring your own ORM via `createOrmAdapter`.

```ts
import { betterSync } from "better-sync";
import { postgres } from "better-sync/providers/storage"; // dedicated PG adapter
import { jwt } from "better-sync/providers/auth";

export const server = betterSync({
  basePath: "/api/sync",
  storage: postgres({
    connectionString: process.env.DATABASE_URL!,
    ensureSchema: true,                     // create tables if missing (dev/test)
    autoMigrate: process.env.NODE_ENV !== "production",
    // dialect options can be provided here if needed
  }),
  auth: jwt({ jwksUrl: process.env.JWKS_URL! }),
});
```

Alternatively, BYO ORM (Drizzle/Kysely/Prisma) using `createOrmAdapter`:

```ts
import { createOrmAdapter } from "better-sync/storage";
import { db, changeTable, snapshotTable } from "./db/drizzle";

const storage = createOrmAdapter({
  withTransaction: (fn) => db.transaction(fn),
  insertChanges: async ({ tx, rows }) => {
    await (tx ?? db).insert(changeTable).values(rows);
  },
  selectChangesSince: async ({ vector, limit }) => {
    return (tx ?? db).select().from(changeTable)
      .where(changeTable.seq.gt(vector.seq))
      .orderBy(changeTable.seq)
      .limit(limit ?? 1000);
  },
  readSnapshot: ({ model, id }) => db.select().from(snapshotTable)
    .where(snapshotTable.model.eq(model).and(snapshotTable.id.eq(id)))
    .then(r => r[0] ?? null),
  writeSnapshot: ({ model, id, value }) => (tx ?? db).insert(snapshotTable).values({ model, id, value })
    .onConflictDoUpdate({ target: [snapshotTable.model, snapshotTable.id], set: { value } }),
});
```

## 3) Mapping Postgres types to portable JSON
The wire format is JSON; convert DB-native types to JSON-friendly counterparts:

- uuid → string
- json/jsonb → JSON (as-is)
- numeric/decimal → string (to avoid precision loss) or number when safe; pick one and be consistent
- bigint → string (portable) or number when safe (< 2^53)
- timestamp/timestamptz → ISO8601 string (e.g., `new Date().toISOString()`)
- bytea → base64 string
- arrays → JSON arrays

You can encode/decode at the storage boundary or in model schemas. A common pattern is using schemas with transforms.

### Zod schema example with transforms
```ts
import { z } from "zod";
import { defineModel } from "better-sync/models";

const PgNumeric = z.string().transform((s) => s); // keep as string across the wire
const PgUUID = z.string().uuid();
const PgTimestamp = z.string().datetime(); // ISO8601 on the wire

export const Todo = z.object({
  id: PgUUID,
  title: z.string(),
  done: z.boolean(),
  priority: PgNumeric,        // numeric/decimal stored as string
  updated_at: PgTimestamp,    // timestamptz serialized as ISO
  tags: z.array(z.string()).default([]),
  meta: z.record(z.any()).default({}), // jsonb
});

export const models = {
  todo: defineModel.fromZod(Todo),
};
```

## 4) Postgres op_log and snapshot schema
Recommended minimal tables. The provider can create these when `ensureSchema: true`.

```sql
-- Append-only change log
CREATE TABLE IF NOT EXISTS op_log (
  seq          BIGSERIAL PRIMARY KEY,           -- monotonic cursor
  op_id        UUID NOT NULL UNIQUE,            -- idempotency
  tenant_id    TEXT NOT NULL,
  model        TEXT NOT NULL,
  pk           TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
  actor        TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  payload      JSONB NOT NULL,                  -- normalized row/patch
  payload_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS op_log_tenant_seq_idx ON op_log(tenant_id, seq);
CREATE INDEX IF NOT EXISTS op_log_model_pk_idx  ON op_log(model, pk);

-- Optional snapshots (for compaction)
CREATE TABLE IF NOT EXISTS snapshots (
  tenant_id  TEXT NOT NULL,
  model      TEXT NOT NULL,
  id         TEXT NOT NULL,
  value      JSONB NOT NULL,
  PRIMARY KEY (tenant_id, model, id)
);
```

Notes:
- `seq` serves as the server-issued cursor (monotonic per-tenant with the compound index).
- Keep `op_id` unique to make pushes idempotent; re-sent changes are ignored.
- `payload` is normalized JSON for portability.

## 5) Conflict resolution (server)
Use HLC/LWW by default. On equal timestamps, delete-wins, then break ties by actorId lexical order. This is deterministic and portable.

```ts
export const server = betterSync({
  // ...
  conflict: "lww", // default
  // or a custom resolver with typed info (local vs remote)
});
```

## 6) End-to-end example
Client writes a todo locally; engine pushes JSON changes; server persists in PG and acks with the new cursor.

```ts
// client
await sync.applyChange("todo", {
  type: "insert",
  id: "c3a9f2d0-1f7a-4e9e-b0e9-0c7a5e3eaa99",
  value: {
    id: "c3a9f2d0-1f7a-4e9e-b0e9-0c7a5e3eaa99",
    title: "Write docs",
    done: false,
    priority: "3.50",              // numeric as string
    updated_at: new Date().toISOString(),
    tags: ["docs"],
    meta: { source: "web" },        // jsonb
  },
});
```

Server stores the change in `op_log` and returns the next `seq` (cursor). On pull, the client converts wire types back to its runtime types following the same schema.

## 7) Tips
- Choose a consistent mapping for `numeric`/`bigint` (string is safest across JS runtimes).
- Keep date/time as ISO strings across the wire; parse on the app boundary if native Date is desired.
- For arrays/jsonb, pass through as JSON.
- Use `encoder: "json"` (default) or `"msgpack"` for denser payloads.
- Always include a per-tenant scope in keys/cursors.
