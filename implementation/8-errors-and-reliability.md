## Errors & Reliability

### Objective
Define error model, codes, and reliability mechanisms.

### Details
#### Error model (SYNC:*)
- Shape: `{ code: string; message: string; helpUrl?: string; meta?: Record<string, unknown> }`.
- Examples: `SYNC:UNAUTHORIZED`, `SYNC:CURSOR_STALE`, `SYNC:CHANGE_REJECTED`, `SYNC:RATE_LIMITED`, `SYNC:SCHEMA_UPGRADE_REQUIRED`.
```json
{
  "error": {
    "code": "SYNC:UNAUTHORIZED",
    "message": "Missing or invalid token.",
    "helpUrl": "https://docs.better-sync.dev/errors#SYNC:UNAUTHORIZED"
  },
  "meta": { "path": "/api/sync" }
}
```
- Typical HTTP mapping: 401/403/409/429; include `helpUrl` and `meta`.

#### Reliability: backpressure & batching
- Defaults: 1000 changes or ~256KB per batch; compression >8KB.
- Apply returns `{ queued }`; `sync.drain()`, `getQueueStats()`, `shouldBackOff()`.

### MVP (Phase 1)
- Error codes and result-returning APIs; backpressure helpers; retry/jitter.

### Phase 2 / Future
- Retry budgets; circuit breakers; OpenTelemetry integration.

### Dependencies
- Client, Protocol & Transport.

### Notes
- Errors should be stable and linkable; prefer non-throwing hot paths.
