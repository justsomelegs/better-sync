## Sync Flow & Key Concepts

### Objective
Explain how syncing works end-to-end and define key concepts.

### Details
#### How syncing works
- Local-first: client persists changes immediately and syncs in background.
- Push/Pull with server-issued opaque cursor; idempotent, batched changes.
- Conflicts: LWW with HLC; delete-wins on equal timestamps; actorId lexical tie-breaker.
- Retry/backoff: exponential with jitter; resume from last acknowledged cursor.

#### End-to-end flow (first 5 minutes)
1. Create the server with `betterSync({ ... })`.
2. Start app and create client with `createSyncClient({ baseUrl, storage })`.
3. Call `await sync.connect()` to obtain a cursor.
4. Make a change locally for instant UI.
5. Client pushes change; server stores and advances cursor.
6. Conflicts resolved on server; client updates view.
7. Automatic retries on network failure.

#### Key concepts (for beginners)
- Client: app in browser/device with local DB for speed/offline.
- Server: central store and conflict resolver.
- baseUrl/basePath: server address and path.
- WebSocket vs HTTP: realtime vs polling fallback.
- Cursor: server bookmark of progress.
- Change (op): insert/update/delete.
- Conflict: predictable resolution so devices converge.
- Shape: filter describing slice of data to sync.
- Snapshot: saved current state to avoid replay from genesis.
- Tenant: multi-tenant grouping with isolated cursors.

### MVP (Phase 1)
- Local-first storage, push/pull, cursoring, retries, LWW+HLC.

### Phase 2 / Future
- Alternative conflict strategies; richer backoff strategies.

### Dependencies
- Client, Server, Storage & Adapters, Protocol & Transport.

### Notes
- Keep beginner explanations visible in each section.
