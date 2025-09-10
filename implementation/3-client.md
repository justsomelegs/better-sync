## Client

### Objective
Document the client API, configuration, and developer ergonomics.

### Details
```ts
import { createSyncClient } from "better-sync";
import { idb } from "better-sync/storage";
import { rpc } from "better-sync/transport";

const sync = createSyncClient({
  models,
  baseUrl: "http://localhost:3000",
  storage: idb({ dbName: "app" }),
  transport: rpc({ baseUrl: "http://localhost:3000" }),
  auth: { headers: () => ({ Authorization: `Bearer ${token()}` }) },
  conflict: "lww",
  dev: { autoServer: true },
});

await sync.connect();
```
- Config notes: `baseUrl` required; `basePath` defaults to `/api/sync` (`${baseUrl}${basePath}`).
- Token refresh: `tokenRefresher` hook dedups concurrent 401s, retries with backoff.

#### For beginners:
This creates the client, sets server location, local storage, and auth. After `connect()`, syncing begins automatically.

#### Backpressure & batching
- Defaults: 1000 changes or ~256KB compressed per batch; compression >8KB.
- `{ queued: boolean }` on apply; `sync.drain()`; `getQueueStats()`; `shouldBackOff()`.
```ts
const res = await sync.applyChange("todo", { type: "update", id: "1", patch: { title: "X" } });
if (res.ok && res.value.queued) {
  await sync.drain();
}
const stats = sync.getQueueStats();
if (sync.shouldBackOff()) {
  // pause UI-heavy actions
}
```

### MVP (Phase 1)
- `createSyncClient`, connect, apply, backpressure helpers, metrics hooks.

### Phase 2 / Future
- Additional transports, richer client-side devtools.

### Dependencies
- Protocol & Transport, Storage & Adapters, Errors & Reliability.

### Notes
- Include JSDoc `@example` for all public client APIs.
