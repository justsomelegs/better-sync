## Vision & Developer Experience

### Objective
Capture the external product vision and core developer experience guarantees.

### Details
- Framework-agnostic, DB-agnostic sync engine with better-auth-grade DX.
- Local-first by default, strong typing, minimal setup, portable JSON protocol.
- Constructors: `createSyncClient(config)` (client), `betterSync(config)` (server).
- Absolute client `baseUrl` is required (e.g., `http://localhost:3000`).
- Server `basePath` is optional, default `/api/sync`.
- WebSocket default with HTTP polling fallback; heartbeat and jittered reconnects.
- SYNC:* namespaced error codes with helpUrl; result-returning APIs on hot paths.
- JSDoc with `@example` across public APIs.

#### For beginners:
This library keeps data in sync between users/devices. You make one client and one server instance with a small config. `baseUrl` is your server address, `basePath` is the endpoint path (default `/api/sync`). WebSocket is an always-on connection for instant updates; HTTP polling is the fallback.

### MVP (Phase 1)
- Ship constructors with minimal required config: `baseUrl` on client, sensible server defaults.
- Result-returning APIs and SYNC:* error catalog.
- WebSocket-first transport with heartbeat and jittered reconnects.

### Phase 2 / Future
- Expanded docs with richer examples; additional DX helpers.

### Dependencies
- Protocol & Transport defaults.
- Errors & Reliability.

### Notes
- Keep beginner explanations inline in docs.
