## Protocol & Transport

### Objective
Document defaults and options for the wire protocol and transports.

### Details
- WebSocket default; heartbeat ~30s; exponential backoff with jitter (start ~250–500ms, cap ~30s).
- Server cursors are opaque and monotonic per tenant; client never trusts local clock.
```ts
import { ws } from "better-sync/transport";
const sync = createSyncClient({
  models,
  baseUrl: "http://localhost:3000",
  storage: idb({ dbName: "app" }),
  transport: ws({ url: "ws://localhost:3000/api/sync", heartbeatMs: 30000 }),
});
```

#### SSR / server actions
- Use `server.api.*` directly with `createRequestContext(request)`; avoid HTTP hop.
```ts
import { createRequestContext } from "better-sync/server";
import { server } from "@/lib/sync/server";
const ctx = await createRequestContext(request);
const result = await server.api.apply({ changeSet, ctx });
```

### MVP (Phase 1)
- WS-first transport with HTTP fallback; heartbeat; jittered reconnects; opaque cursors.

### Phase 2 / Future
- Additional transports; msgpack framing option.

### Dependencies
- Client, Server, Storage & Adapters.

### Notes
- Prefer WS with a clean HTTP fallback strategy for environments without WS.
