## Package Roadmap

### Objective
Summarize initial MVP scope and future phases.

### Details
- MVP: SQLite + IDB, WS default with HTTP fallback, live queries, shapes, LWW+HLC, result-based apply, rate-limit plugin, ensureSchema/autoMigrate, SYNC:* errors, dev.autoServer, metrics hooks.
- Next: Postgres/MySQL adapters, msgpack encoder, CRDT plugin pack, OpenTelemetry, richer devtools.

### MVP (Phase 1)
- Implement all MVP items above across client/server/storage/protocol.

### Phase 2 / Future
- Ship additional adapters and ecosystem integrations.

### Dependencies
- All preceding modules.

### Notes
- Keep roadmap short and tied to realistic release milestones.
