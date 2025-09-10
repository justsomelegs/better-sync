## Packages Overview (MVP)

### Objective
Explain the single-package layout and how users import from it.

### Package layout
- `better-sync` (single package)
  - `better-sync` (core APIs)
  - `better-sync/auth` (auth providers like `jwt`)
  - `better-sync/transport` (transports like `ws`, `rpc`)
  - `better-sync/storage` (storage providers like `sqlite`, `postgres`, `idb`)

### Why this layout?
- **DX-first**: one install, clear subpath imports: `better-sync/{auth,transport,storage}`.
- **Tree-shakeable**: subpaths keep bundles small.
- **Simple testing**: one Vitest config; smoke tests live in the core package.

### Example imports
```ts
import { createClient } from "better-sync";
import { jwt } from "better-sync/auth";
import { ws, rpc } from "better-sync/transport";
import { sqlite, idb } from "better-sync/storage";
```
