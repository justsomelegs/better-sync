## Getting Started

### Install
Single install:
```bash
npm install better-sync
```
Optional auth provider:
```bash
npm install @better-sync/auth
```

### Import
```ts
import { createSyncClient } from "better-sync";
import { ws } from "better-sync/transport"; // included by default in core deps
import { idb } from "better-sync/storage";   // included by default in core deps
import { jwt } from "better-sync/auth";
```

### Minimal example (client)
```ts
import { createSyncClient } from "better-sync";
import { idb } from "better-sync/storage";
import { ws } from "better-sync/transport";

const sync = createSyncClient({
  baseUrl: "http://localhost:3000",
  storage: idb({ dbName: "app" }),
  transport: ws({ url: "ws://localhost:3000/api/sync" }),
});
await sync.connect();
```

### Minimal example (server)
```ts
import { betterSync } from "better-sync";
import { sqlite } from "better-sync/storage";
import { jwt } from "better-sync/auth";

export const server = betterSync({
  basePath: "/api/sync",
  storage: sqlite({ file: "./data.db" }),
  auth: jwt({ jwksUrl }),
});
```

### Notes
- `better-sync` ships with default transport and storage helpers; auth is optional.
- Import ergonomics follow better-auth’s style: `better-sync/{transport,storage,auth}`.
