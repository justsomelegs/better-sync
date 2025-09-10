## Server

### Objective
Document the server API, handlers, authorization, and RBAC hooks.

### Details
```ts
import { betterSync } from "better-sync";
import { sqlite } from "better-sync/storage";
import { jwt } from "better-sync/auth";

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

#### For beginners:
- `storage` saves changes (SQLite here). `ensureSchema` creates required tables in dev; `autoMigrate` updates safely in dev/test.
- `auth` verifies identity (JWT shown), `authorize` builds a request context.
- `canRead/canWrite` are row-level access checks.
- `server.fetch()` mounts your endpoints.

#### Handlers vs direct API
- Handlers: `server.fetch` for HTTP/WS mounting.
- Direct server API: `server.api.*` for SSR/server actions without HTTP hop.
```ts
import express from "express";
import { server } from "./server";
const app = express();
app.use("/api/sync", server.fetch());
app.listen(3000);
```

### MVP (Phase 1)
- Server constructor, fetch handler, `authorize`, `canRead/canWrite`, JWT auth provider.

### Phase 2 / Future
- More auth providers; richer plugins.

### Dependencies
- Storage & Adapters; Security & Multi-tenancy; Protocol & Transport.

### Notes
- Recommend migrations via DB tooling; avoid auto-migrating on startup.
