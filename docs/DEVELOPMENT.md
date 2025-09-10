## [ DEVELOPMENT ] - "How to Develop Better Sync"

### Who this is for
- **Package developers**: building and maintaining `better-sync` and its providers/plugins.
- **Contributors**: adding features or fixes across the monorepo.

This is a practical, hands-on, step-by-step guide to take the project from empty repo → working MVP → publishable packages. It follows the DX and architecture in `docs/PLAN.md` and `implementation/*`, uses npm workspaces, ESM-only output, and encourages skeleton/smoke tests early.

---

### [ PREREQS ] - "Tools you need"
- Node.js 18+ and npm (bundled with Node)
- Git (for version control)
- A code editor (VS Code recommended)
- Optional: GitHub account (for CI/CD and releases)

Quick checks:
```bash
node -v   # v18.x or v20+
npm -v    # v9+
git --version
```

---

### Step 1 — Initialize the repository and workspaces

1. Create and initialize the repo
```bash
mkdir better-sync && cd better-sync
npm init -y
git init
```

2. Create root `package.json` with workspaces and scripts
```json
{
  "name": "better-sync-monorepo",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "changeset": "changeset",
    "release": "changeset version && turbo run build && changeset publish"
  },
  "workspaces": ["packages/*", "examples/*"]
}
```

3. Add baseline config files
- Create `tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true
  }
}
```
- Create `biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/1.7.0/schema.json",
  "formatter": { "enabled": true },
  "linter": { "enabled": true },
  "files": { "ignore": ["dist", "**/*.config.*"] }
}
```
- Optional `.npmrc`:
```ini
legacy-peer-deps=false
```
- Optional `.gitignore`:
```gitignore
node_modules
dist
*.log
.env
```

4. Install dev tooling
```bash
npm i -D typescript turbo @biomejs/biome vitest tsx changesets
npx changeset init
```

5. Create folders
```bash
mkdir -p packages/better-sync
mkdir -p packages/@better-sync/{auth,transport,storage}
mkdir -p packages/plugins
mkdir -p packages/testkit
mkdir -p examples/{node-basic,nextjs-app}
```

Verification checklist:
- `workspaces` paths exist
- `tsconfig.base.json` and `biome.json` are present
- `node_modules` contains dev tools

---

### Step 2 — Scaffold the core package (ESM-only)

1. Create `packages/better-sync/package.json`
```json
{
  "name": "better-sync",
  "version": "0.0.0",
  "type": "module",
  "sideEffects": false,
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs" },
    "./storage": { "types": "./dist/storage.d.ts", "import": "./dist/storage.mjs" },
    "./transport": { "types": "./dist/transport.d.ts", "import": "./dist/transport.mjs" },
    "./auth": { "types": "./dist/auth.d.ts", "import": "./dist/auth.mjs" },
    "./plugins/*": "./dist/plugins/*.mjs",
    "./models": { "types": "./dist/models.d.ts", "import": "./dist/models.mjs" }
  },
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b -w",
    "test": "vitest",
    "lint": "biome check .",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

2. Create `packages/better-sync/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": []
}
```

3. Create `packages/better-sync/src/index.ts` (public API entry)
```ts
/**
 * better-sync — framework-agnostic, DB-agnostic sync engine.
 * @example
 * import { createSyncClient } from "better-sync";
 * const sync = createSyncClient({ baseUrl: "http://localhost:3000" });
 */
export { createSyncClient } from "./public/client.js";
export { betterSync } from "./public/server.js";
export * from "./public/types.js";
```

4. Create `packages/better-sync/src/public/client.ts`
```ts
import type { SyncClient, SyncClientConfig } from "./types.js";

/**
 * Create a sync client.
 * Uses WebSocket by default with HTTP fallback.
 * @example
 * const sync = createSyncClient({ baseUrl: "http://localhost:3000" });
 * await sync.connect();
 */
export function createSyncClient(config: SyncClientConfig): SyncClient {
  return {
    async connect() { /* TODO: ws connect, heartbeat, backoff */ },
    async applyChange() { /* TODO: queue + backpressure */ return { ok: true, value: { queued: true } }; },
    async drain() { /* TODO: wait for queue flush */ },
    getQueueStats() { return { size: 0, pendingBatches: 0, bytes: 0 }; },
    shouldBackOff() { return false; },
    subscribeQuery() { /* TODO: live query */ return { unsubscribe() {} }; },
    createSnapshot() { /* TODO */ },
    withTenant() { /* TODO */ return this as any; },
  } as unknown as SyncClient;
}
```

5. Create `packages/better-sync/src/public/server.ts`
```ts
import type { SyncServer, SyncServerConfig } from "./types.js";

/**
 * Create a sync server instance.
 * @example
 * const server = betterSync({ basePath: "/api/sync" });
 * app.use("/api/sync", server.fetch());
 */
export function betterSync(config: SyncServerConfig): SyncServer {
  return {
    fetch() { /* TODO: return HTTP/WS handler */ return (_req: any, _res: any, next?: any) => next?.(); },
    api: {
      async apply() { /* TODO: batch apply with cursor */ return { ok: true, value: { applied: true } }; },
      withTenant() { /* TODO */ return this; },
      registerShape() { /* TODO */ },
    },
  } as unknown as SyncServer;
}
```

6. Create `packages/better-sync/src/public/types.ts` (initial minimal types)
```ts
export type Result<T> = { ok: true; value: T } | { ok: false; error: SyncError };
export type SyncErrorCode =
  | "SYNC:UNAUTHORIZED"
  | "SYNC:FORBIDDEN"
  | "SYNC:CURSOR_STALE"
  | "SYNC:RATE_LIMITED";
export interface SyncError { code: SyncErrorCode; message: string; helpUrl?: string; meta?: Record<string, unknown> }

export interface SyncClientConfig {
  baseUrl: string;
  basePath?: string; // defaults to /api/sync
  // TODO: storage, transport, auth, conflict policy, dev flags, metrics
}
export interface SyncClient {
  connect(): Promise<void>;
  applyChange(...args: any[]): Promise<Result<{ queued: boolean }>>;
  drain(): Promise<void>;
  getQueueStats(): { size: number; pendingBatches: number; bytes: number };
  shouldBackOff(): boolean;
  subscribeQuery(...args: any[]): { unsubscribe(): void };
  createSnapshot(...args: any[]): Promise<void> | void;
  withTenant(id?: string): SyncClient;
}

export interface SyncServerConfig {
  basePath?: string; // defaults to /api/sync
  // TODO: storage, auth, authorize, canRead/canWrite, conflict
}
export interface SyncServer {
  fetch(): any; // framework handler adapter
  api: {
    apply(...args: any[]): Promise<Result<{ applied: boolean }>>;
    withTenant(id?: string): SyncServer["api"];
    registerShape(...args: any[]): Promise<void> | void;
  };
}
```

Verification checklist:
- `npm run build` in root creates `packages/better-sync/dist` with `.mjs` and `.d.ts`
- Importing from `better-sync` resolves ESM entry

---

### Step 3 — Add provider packages (storage, transport, auth)

Create minimal provider skeletons that compile and can be imported via syntactic sugar.

1. Storage: `packages/@better-sync/storage/package.json`
```json
{
  "name": "@better-sync/storage",
  "version": "0.0.0",
  "type": "module",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs" } },
  "scripts": { "build": "tsc -b", "dev": "tsc -b -w", "test": "vitest", "lint": "biome check .", "typecheck": "tsc -p tsconfig.json --noEmit" }
}
```

2. Storage: `packages/@better-sync/storage/src/index.ts`
```ts
export { idb } from "./providers/idb.js";
export { sqlite, postgres } from "./providers/server-sql.js";
```

3. Storage providers
```ts
// packages/@better-sync/storage/src/providers/idb.ts
export function idb(options: { dbName: string }) {
  return { kind: "idb", options } as const; // TODO: real implementation
}

// packages/@better-sync/storage/src/providers/server-sql.ts
export function sqlite(options: { file: string; ensureSchema?: boolean; autoMigrate?: boolean }) {
  return { dialect: "sqlite", options } as const; // TODO
}
export function postgres(options: { connectionString?: string; pool?: unknown }) {
  return { dialect: "postgres", options } as const; // TODO
}
```

4. Transport: `packages/@better-sync/transport`
```ts
// src/index.ts
export { ws } from "./ws.js";
export { rpc } from "./rpc.js";

// src/ws.ts
export function ws(options: { url: string; heartbeatMs?: number }) {
  return { type: "ws", options } as const; // TODO: real WS impl
}

// src/rpc.ts
export function rpc(options: { baseUrl: string }) {
  return { type: "rpc", options } as const; // TODO: HTTP fallback
}
```

5. Auth: `packages/@better-sync/auth`
```ts
// src/index.ts
export { jwt } from "./jwt.js";
// src/jwt.ts
export function jwt(options: { jwksUrl: string }) {
  return { type: "jwt", options } as const; // TODO: verify tokens
}
```

6. Re-export provider sugar from `better-sync` (optional convenience)
```ts
// packages/better-sync/src/public/providers.ts (optional)
export * from "@better-sync/storage";
export * from "@better-sync/transport";
export * from "@better-sync/auth";
```

Verification checklist:
- `npm run build` emits dist for all provider packages
- Import paths work:
```ts
import { idb, sqlite, postgres } from "better-sync/storage";
import { ws, rpc } from "better-sync/transport";
import { jwt } from "better-sync/auth";
```

---

### Step 4 — Wire minimal client/server flows

1. Client connect and backoff (skeleton)
- Implement `connect()` to use `ws({ url })`, send handshake, start heartbeat (~30s), set exponential backoff with jitter for reconnects.
- Return quickly and run connection loop in background.

2. Apply and queueing (skeleton)
- `applyChange()` returns `{ ok, value: { queued: true } }` and enqueues batch if WS is open; else persists to local queue and schedules retry.
- `drain()` resolves when queue has flushed.

3. Server API and handler (skeleton)
- `server.api.apply()` validates batch, writes to storage, advances cursor, returns `{ ok, value: { applied: true } }`.
- `server.fetch()` adapts to framework (Express/Next/etc.). For now return a no-op handler you can mount.

4. Error model and helpers
- Introduce `syncError(code, message, meta?)` factory and use stable `SYNC:*` codes.
- Map common HTTP statuses: 401/403/409/429.

5. Wire format and serializers (internal design stub)
- Define `ModelSerializer<TWire, TRow>` with `encode(row): TWire` and `decode(wire): TRow`.
- Recommend defaults: uuid→string; bigint/decimal→string; timestamp→ISO 8601; bytea→base64; arrays→JSON arrays.

---

### Step 5 — Examples (local manual test)

1. Minimal server (examples/node-basic/server.ts)
```ts
import express from "express";
import { betterSync } from "better-sync";
import { sqlite } from "better-sync/storage";
import { jwt } from "better-sync/auth";

const app = express();
const server = betterSync({
  basePath: "/api/sync",
  storage: sqlite({ file: "./data.db", ensureSchema: true, autoMigrate: true }),
  auth: jwt({ jwksUrl: "https://example.com/.well-known/jwks.json" })
});
app.use("/api/sync", server.fetch());
app.listen(3000, () => console.log("server on http://localhost:3000"));
```

2. Minimal client (examples/node-basic/client.ts)
```ts
import { createSyncClient } from "better-sync";
import { idb } from "better-sync/storage";
import { ws } from "better-sync/transport";

const sync = createSyncClient({
  baseUrl: "http://localhost:3000",
  storage: idb({ dbName: "app" }),
  transport: ws({ url: "ws://localhost:3000/api/sync" })
});
await sync.connect();
const res = await sync.applyChange("todo", { type: "insert", id: "1", value: { title: "A" } });
console.log(res);
```

Run example:
```bash
# in one terminal
node examples/node-basic/server.ts
# in another terminal
node examples/node-basic/client.ts
```

---

### Step 6 — Testing strategy (skeleton + smoke)

1. Configure Vitest per package (e.g., `packages/better-sync/vitest.config.ts`)
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

2. Create first smoke test (client)
```ts
// packages/better-sync/test/client.smoke.test.ts
import { describe, it, expect } from "vitest";
import { createSyncClient } from "../src/public/client.js";

describe("client", () => {
  it("connects (skeleton)", async () => {
    const c = createSyncClient({ baseUrl: "http://localhost:3000" });
    await c.connect();
    expect(c.getQueueStats().size).toBe(0);
  });
});
```

3. Conformance suite (later)
- Add `@bettersync/testkit` with fake transport/storage and run push/pull/cursor/conflict matrix across providers.

Run tests:
```bash
npm test
```

---

### Step 7 — Lint, format, and typecheck
- Format+lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Build all: `npm run build`

Fix any issues before committing.

---

### Step 8 — CI and Releases

1. Add GitHub Actions CI (root: `.github/workflows/ci.yml`)
```yaml
name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

2. Add release workflow (optional) to publish Changesets on main.

3. Release locally or via CI
```bash
npx changeset   # record changes
npm run release # version, build, publish
```

Publishing checklist:
- [ ] All packages build (ESM-only), types emitted
- [ ] Unit + conformance tests pass
- [ ] Exports map updated for new entries
- [ ] JSDoc `@example` blocks present
- [ ] Changeset written and committed

---

### Step 9 — Roadmap-driven implementation order (detailed)

Follow the modules in `implementation/*`. For each, implement MVP first, add Phase 2 later.

1) Client
- `connect()` with WS default, HTTP fallback, heartbeat (~30s), jittered backoff (start 250–500ms, cap ~30s)
- Local-first write path; enqueue ops; persist queue between sessions
- Backpressure API: `drain()`, `getQueueStats()`, `shouldBackOff()`
- Metrics hook: `metrics.on(event, data)`

2) Server
- `betterSync()` with `basePath` default `/api/sync`
- `authorize(req)` → `{ userId, tenantId, roles }`
- `canRead/canWrite` row-level guards
- `server.fetch()` HTTP/WS adapters; `server.api.*` for SSR direct calls

3) Storage & Adapters
- Client: `idb()` default; optional `sqljs()`
- Server: `sqlite()` default; `postgres()` next
- DB-agnostic wire normalization defaults; per-model overrides
- Transactional batch apply; coalescing; per-tenant cursor index

4) Protocol & Transport
- Opaque, monotonic server cursors
- WS-first with clean HTTP fallback
- SSR/server actions helper: `createRequestContext(request)`

5) Live Queries & Shapes
- `subscribeQuery({ model, where, select }, cb)`; immediate callback with current data
- Server-side validation and ACLs
- Shapes: `registerShape`, per-tenant shape cursors; `sync.pinShape()`

6) Errors & Reliability
- `SYNC:*` catalog with `{ code, message, helpUrl, meta }`
- Map to HTTP: 401/403/409/429
- Result-returning APIs on hot paths

7) Snapshots & Persistence
- Client `createSnapshot(model)` + compaction helpers
- Server batch apply safety

8) Security & Multi-tenancy
- JWT provider; `authorize` context; tenant helpers `.withTenant("t1")`
- Rate limit plugin with `retryAfterMs` and `Retry-After`

9) Devtools & DX Helpers
- `dev.autoServer` (dev only)
- `sync.json` metadata endpoint

---

### Step 10 — Troubleshooting (quick fixes)
- **ESM import errors**: Ensure `"type": "module"` and using `.js` extensions in internal imports.
- **Types not found**: Confirm `types` path in `package.json` and `outDir` set to `dist`.
- **Build emits nothing**: Check `include: ["src"]` and `rootDir: "src"` in `tsconfig.json`.
- **WS connection fails**: Use full URLs (e.g., `ws://localhost:3000/api/sync`), validate `baseUrl/basePath` logic.
- **Auth 401/403**: Verify `jwt({ jwksUrl })` and that `authorize(req)` returns a valid context.

---

### For beginners (what each keyword means as you go)
- **Local-first**: write to the local database immediately; sync in background so UI is instant.
- **Cursor**: server-issued bookmark that says how far we’ve synced; safe to retry.
- **LWW/HLC**: last-write-wins using a hybrid logical clock so clocks don’t need to match.
- **Backpressure**: slow down or queue when there’s too much to send.
- **ACL**: access control logic like `canRead`/`canWrite` to protect rows.
- **Normalization**: convert DB-specific types into JSON-safe values on the wire (e.g., bigint → string).

---

### Appendix — Useful snippets

Minimal model helper (future):
```ts
// better-sync/models
export const defineModel = {
  fromZod<T>(_schema: T, _opts?: any) {
    return {} as any; // TODO: types and runtime validation
  },
};
```

Internal serializer interface (storage boundary):
```ts
export interface ModelSerializer<TWire = any, TRow = any> {
  encode(row: TRow): TWire;          // app/db → wire (JSON-safe)
  decode(wire: TWire): TRow;          // wire → app/db
  wireVersion?: number;               // bump if the wire shape changes
}
```

---

### References
- `docs/PLAN.md` — product & API plan
- `docs/PACKAGES.md` — package split and import ergonomics
- `docs/STACK.md` — tooling and monorepo layout
- `implementation/*` — module-by-module objectives and details
