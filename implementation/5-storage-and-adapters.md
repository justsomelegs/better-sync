## Storage & Adapters

### Objective
Explain storage provider choices, adapter design, and DB-agnostic wire format.

### Details
#### Picking a local database (client)
- IndexedDB (browser) default; sql.js/libsql (WASM) for in-browser SQL.
```ts
import { idb } from "better-sync/storage";
const storage = idb({ dbName: "app" });
// Or WASM SQL
// import { sqljs } from "better-sync/storage";
// const storage = sqljs({ file: ":memory:" });
```

#### Dialect and adapter selection (server)
- Prefer explicit providers (`sqlite()`, `postgres()`, etc.); dialect implied.
- Optional generic factory with `dialect` for BYO ORM.
```ts
import { postgres } from "better-sync/storage";
export const server = betterSync({
  storage: postgres({ pool }),
});
```
```ts
import { createOrmAdapter } from "better-sync/adapters";
import { drizzle } from "drizzle-orm";
const storage = createOrmAdapter({
  dialect: "postgres",
  orm: drizzle(db),
  schema,
  wire: { normalize: "auto" },
});
export const server = betterSync({ storage });
```

#### DB-agnostic wire format
- Default automatic normalization by adapter; overridable globally, per adapter, or per model.
- Typical defaults: uuid→string; bigint/numeric→string; timestamp→ISO 8601 string; bytea→base64; arrays→JSON arrays.
```ts
import { postgres } from "better-sync/storage";
export const server = betterSync({
  storage: postgres({ connectionString: process.env.DATABASE_URL }),
});
```
```ts
import { sqlite } from "better-sync/storage";
const storage = sqlite({ file: "./data.db", wire: { normalize: "off" } });
```
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

### MVP (Phase 1)
- Client IDB; server SQLite provider; adapter normalization defaults; per-model override hooks.

### Phase 2 / Future
- Postgres/MySQL adapters; msgpack encoder.

### Dependencies
- Protocol & Transport; Internal Serializer API.

### Notes
- Keep dialect within providers for better types and tree-shaking.
