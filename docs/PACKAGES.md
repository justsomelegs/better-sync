## Packages Overview (MVP)

### Objective
Explain how the repository is split into packages and how users import from them.

### Packages
- better-sync: Aggregator with subpath exports.
  - `better-sync` (core re-exports)
  - `better-sync/auth`
  - `better-sync/transport`
  - `better-sync/storage`
  - `better-sync/plugins/*` (future)
- @better-sync/core: Core types and shared utilities.
- @better-sync/auth: Auth providers (e.g., `jwt`).
- @better-sync/transport: Transports (e.g., `ws`, `rpc`).
- @better-sync/storage: Storage providers (e.g., `sqlite`, `postgres`, `idb`, `sqljs`).

### Why this split?
- Simple imports for users: `better-sync/{auth,transport,storage}`.
- Leaf packages can be versioned and tested independently.
- The aggregator keeps DX smooth and tree-shakeable.

### Example imports
```ts
import { createSyncClient } from "better-sync";
import { jwt } from "better-sync/auth";
import { ws, rpc } from "better-sync/transport";
import { sqlite, idb } from "better-sync/storage";
```
