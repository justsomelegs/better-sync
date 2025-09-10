## MVP Progress Tracker

Legend: [ ] not started, [x] done, [~] in progress

### Foundations
- [x] Monorepo scaffold (npm workspaces + Turbo + Biome + Changesets + tsc)
- [x] Aggregator package `better-sync` with subpath exports (`/auth`, `/transport`, `/storage`)
- [x] Consolidated to single package: providers under `packages/better-sync/src/{auth,transport,storage}`
- [x] Batteries‑included defaults: core depends on default transport + storage
- [x] Docs: STACK, DEVELOPMENT, GETTING‑STARTED, PACKAGES

### Core Sync Engine
- [ ] Local‑first client storage plumbing (IDB helpers)
- [ ] Server storage plumbing (SQLite helpers)
- [ ] Push/Pull with server‑issued cursors (idempotent, batched)
- [ ] Conflict resolution: LWW with HLC (delete‑wins tie break)

### Protocol & Transport
- [ ] WebSocket default with HTTP fallback
- [ ] Heartbeat (~30s), exponential backoff with jitter
- [ ] Opaque, monotonic server cursors; client doesn’t trust local clock

### Live Queries & Shapes
- [ ] `subscribeQuery` API + server validation/ACLs
- [ ] Partial replication shapes (per‑tenant cursors; cache invalidation)

### Reliability & Errors
- [ ] SYNC:* error model (codes + helpUrl + HTTP mapping)
- [ ] Backpressure & batching (`queued`, `drain`, `getQueueStats`, `shouldBackOff`)

### Persistence & Snapshots
- [ ] Client snapshots + optional compaction
- [ ] Server transactional batch apply + coalescing + per‑tenant cursor index

### Security & Multi‑tenancy
- [ ] JWT auth provider
- [ ] `authorize`, `canRead`, `canWrite` hooks
- [ ] Rate limit plugin (`SYNC:RATE_LIMITED`, `retryAfterMs`)

### Dev DX & Metadata
- [ ] `dev.autoServer`
- [ ] Metrics hooks (`metrics.on(event, data)`) 
- [ ] `sync.json` metadata endpoint

### Testing & CI
- [x] Biome configured
- [x] Turbo pipeline configured
- [ ] Vitest baseline (tests to be added alongside features)
- [x] Changesets configured

### Links
- Roadmap: `implementation/0-roadmap.md`
- Vision & DX: `implementation/1-vision-and-dx.md`
- Sync flow: `implementation/2-sync-flow-and-concepts.md`
- Client: `implementation/3-client.md`  |  Server: `implementation/4-server.md`
- Storage & Adapters: `implementation/5-storage-and-adapters.md`
- Protocol & Transport: `implementation/6-protocol-and-transport.md`
- Live Queries & Shapes: `implementation/7-live-queries-and-shapes.md`
- Errors & Reliability: `implementation/8-errors-and-reliability.md`
- Snapshots & Persistence: `implementation/9-snapshots-and-persistence.md`
- Security & Multi‑tenancy: `implementation/10-security-and-multi-tenancy.md`
- Devtools & DX Helpers: `implementation/11-devtools-and-dx-helpers.md`
- Internal Architecture: `implementation/12-internal-architecture.md`
- Package Roadmap: `implementation/13-roadmap.md`
