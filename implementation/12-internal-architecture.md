## Internal Architecture

### Objective
Describe internal serializer API, testkit, and contributor infrastructure.

### Details
#### Internal Serializer API (storage boundary)
```ts
export interface ModelSerializer<TWire = any, TRow = any> {
  encode(row: TRow): TWire;          // app/db → wire (JSON-safe)
  decode(wire: TWire): TRow;          // wire → app/db
  wireVersion?: number;               // bump if the wire shape changes
}
```
- Default conversions: uuid→string; bigint/numeric→string; timestamp→ISO 8601; bytea→base64; arrays→JSON; json/jsonb→JSON.
- Testing guidance: round-trip, stability with `wireVersion`, property-based tests.
- `sync.json` note: include `wireVersion` per model family if you evolve wire shapes.

#### Contributors (code infrastructure)
- `@bettersync/testkit`: fake transport/storage, deterministic scheduler/clock, conformance runners.
- Type stability tests; error factory `syncError(code, message, meta?)` with `SyncErrorCode` union.
```ts
import { createConformanceSuite } from "@bettersync/testkit";
import { sqlite } from "better-sync/providers/storage";
const suite = createConformanceSuite({ storage: sqlite({ file: ":memory:" }) });
await suite.run();
```

### MVP (Phase 1)
- Serializer interface finalized; basic testkit and conformance for SQLite/IDB; error factory.

### Phase 2 / Future
- Full cross-adapter conformance; generator-based test suites; compatibility matrix.

### Dependencies
- Storage & Adapters; Errors & Reliability.

### Notes
- Keep serializer stable to preserve protocol compatibility.
