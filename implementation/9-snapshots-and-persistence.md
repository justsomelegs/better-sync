## Snapshots & Persistence

### Objective
Describe client persistence, snapshots, compaction, and server batch application.

### Details
- Client: IDB default with `durability: "relaxed" | "strict"`; snapshot + compaction helpers.
```ts
// Client: take a snapshot and optionally compact
await sync.createSnapshot("todo");
// (compaction may run automatically; helpers will be documented in API)
```
- Server: transactional batch apply; coalesce duplicate ops; per-tenant cursor index.

#### For beginners:
The client stores data locally for speed/offline. Snapshots keep storage small, and the server applies grouped changes safely.

### MVP (Phase 1)
- Snapshot helper; compaction strategy; transactional batch apply on server.

### Phase 2 / Future
- Automatic snapshot scheduling; differential snapshots.

### Dependencies
- Client, Server, Storage & Adapters.

### Notes
- Ensure safe defaults for durability; document trade-offs clearly.
