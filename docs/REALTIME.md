## Realtime & Diffs

This document explains how just-sync delivers realtime updates, how clients resume after disconnects, and how diffs are applied client-side.

### Transport

- Server-Sent Events (SSE) at `GET /events` with keepalives, Last-Event-ID resume, and an in-memory ring buffer.
- Clients pass `Last-Event-ID` (or `?since`) to request missed events within the buffer window; on miss, a `recover` event is sent and the client performs a fresh snapshot.

### Event payloads

Frames look like:

```
id: 01J...
event: mutation
data: {"eventId":"...","txId":"...","tables":[{"name":"todos","type":"mutation","pks":["t1"],"rowVersions":{"t1":1013},"diffs":{"t1":{"set":{"done":true,"version":1013,"updatedAt":1726...},"unset":[]}}}]}

```

Fields:
- `eventId`: SSE id (ULID) for resume/dedupe
- `txId`: transaction id grouping changes
- `tables[]`: one entry per affected table
  - `pks`: changed primary keys
  - `rowVersions`: per-row versions (monotonic)
  - `diffs` (optional): per-row shallow diffs `{ set, unset }`

### Client behavior

- On event receipt, the client:
  1. Applies diffs to its cache immediately when provided
  2. Notifies active watchers for the affected table
  3. Debounces a snapshot refresh per table (to guarantee correctness and cover non-diffed cases)

- If diffs are not provided, the client notifies and then snapshots per watcher (debounced).

### Reconnect backoff

- The client uses exponential backoff with jitter for SSE reconnects.
- Config via `reconnectBackoff?: { baseMs?: number; maxMs?: number; jitterMs?: number }` and hooks: `hooks.onRetry({ attempt, reason })`.

Example:

```ts
createClient({
  baseURL: '/api/sync',
  reconnectBackoff: { baseMs: 400, maxMs: 8000, jitterMs: 300 },
  hooks: { onRetry: ({ attempt, reason }) => console.log('retry', attempt, reason) },
  debug: true
});
```

### Debugging

- Client `debug: true` logs POST timings, SSE connects/retries, and diff-apply counts.
- Server may optionally log SSE replay counts when resuming (see internal debug hooks).

