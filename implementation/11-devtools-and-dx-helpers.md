## Devtools & DX Helpers

### Objective
Collect developer-focused features that improve setup, debugging, and iteration.

### Details
#### Metrics & debug hooks
```ts
const sync = createSyncClient({
  // ...
  metrics: {
    on(event, data) {
      console.log("sync-event", event, data);
    },
  },
});
```
- Optional `metrics.on(event, data)` for push/pull/conflict/retry; OpenTelemetry adapters later.

#### Dev convenience
- `dev.autoServer`: enabled in development, disabled in production; auto-mounts the server handler at `basePath`.
```ts
const sync = createSyncClient({
  // ...
  dev: { autoServer: false },
});
```

#### sync.json metadata endpoint
- GET `${baseUrl}${basePath}/sync.json` → `{ protocolVersion, features, basePath, methods }`.
```ts
const res = await fetch("http://localhost:3000/api/sync/sync.json");
const meta = await res.json();
```

### MVP (Phase 1)
- Metrics hook; `dev.autoServer`; `sync.json` endpoint.

### Phase 2 / Future
- OpenTelemetry adapters; richer visual devtools panel.

### Dependencies
- Client; Server.

### Notes
- Keep debug hooks optional and lightweight.
