## Security & Multi-tenancy

### Objective
Capture authn/authz hooks, tenant boundaries, and rate limiting.

### Details
#### Tenant helpers
```ts
const t1 = createSyncClient({ baseUrl, storage: idb({ dbName: "app" }) }).withTenant("t1");
await t1.applyChange("todo", { type: "insert", id: "1", value: { title: "A" } });
await server.api.withTenant("t1").apply({ changeSet, ctx: { userId } });
```
- Multi-tenant apps isolate data; each tenant has its own cursor.

#### Rate limiting (plugin)
```ts
import { rateLimit } from "better-sync/plugins/rate-limit";
plugins: [rateLimit({ windowMs: 60_000, max: 600, key: (ctx) => ctx.userId ?? ctx.tenantId ?? ctx.ip })];
```
- Returns `SYNC:RATE_LIMITED` with `retryAfterMs` and `Retry-After` header.

#### Auth
- `auth` provider (e.g., JWT), `authorize(req)` → `{ userId, tenantId, roles }`.
- Row-level `canRead/canWrite` checks.

### MVP (Phase 1)
- JWT provider; `authorize`; `canRead/canWrite`; tenant helpers; rate limit plugin.

### Phase 2 / Future
- Pluggable auth providers; fine-grained audit logging.

### Dependencies
- Server; Protocol & Transport.

### Notes
- Keep tenant context explicit in API to avoid cross-tenant leakage.
