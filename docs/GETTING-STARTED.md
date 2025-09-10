## Getting Started

### Install
Single install:
```bash
npm install better-sync
```
Optional auth provider:
```bash
# Auth lives under better-sync/auth subpath; no extra install needed
```

### Import
```ts
import { createClient } from "better-sync";
import { ws } from "better-sync/transport"; // included by default in core deps
import { idb } from "better-sync/storage";   // included by default in core deps
import { jwt } from "better-sync/auth";
```

### Minimal example (client)
```ts
import { createClient } from "better-sync";
import { idb } from "better-sync/storage";
import { ws } from "better-sync/transport";

const sync = createClient({)
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

### [ DATA TYPES ] - "Serializers for BigInt, Date, UUID"
```ts
import { createClient, defineSchema } from "better-sync";

// Example row type with non-JSON primitives
type Invoice = { id: string; amount: bigint; issuedAt: Date; customerId: string };

// Schema is type-only (no runtime); use defineSchema for DX
const schema = defineSchema({ invoice: {} as Invoice });

// Serializers translate app rows to wire-safe JSON and back
const client = createClient<typeof schema>({
  baseUrl: "http://localhost:3000",
  serializers: {
    invoice: {
      encode(row) {
        return {
          ...row,
          amount: row.amount.toString(),            // bigint → string
          issuedAt: row.issuedAt.toISOString(),     // Date → ISO 8601 string
        };
      },
      decode(wire) {
        return {
          ...wire,
          amount: BigInt(wire.amount),              // string → bigint
          issuedAt: new Date(wire.issuedAt),        // ISO string → Date
        } as Invoice;
      },
      wireVersion: 1,
    },
  },
});

// Typed update: patch/values are checked against your schema
await client.applyChange("invoice", {
  type: "update",
  id: "inv_1",
  patch: { amount: 123n }, // type-safe
});

// Typed query: select narrows the row type in the callback
client.subscribeQuery({ model: "invoice", select: ["id", "amount"] }, rows => {
  const amt = rows[0].amount; // bigint
});
```

- **UUIDs**: keep as strings on the wire; your app types can remain `string`.
- **Decimals**: prefer strings on the wire; convert to `Decimal`/`number` in `decode`.
- **Timestamps**: use ISO 8601 strings on the wire.

### [ ORMS ] - "Prisma and Drizzle typing"
```ts
// Prisma
import { Prisma } from "@prisma/client";
import { createClient, defineSchema } from "better-sync";

type Invoice = Prisma.InvoiceGetPayload<{ select: { id: true; amount: true; issuedAt: true; customerId: true } }>;
const schema = defineSchema({ invoice: {} as Invoice });

const prismaClient = createClient<typeof schema>({
  baseUrl: "http://localhost:3000",
  serializers: {
    invoice: {
      encode(r) {
        return { ...r, amount: r.amount.toString(), issuedAt: r.issuedAt.toISOString() };
      },
      decode(w) {
        return { ...w, amount: new Prisma.Decimal(w.amount), issuedAt: new Date(w.issuedAt) } as Invoice;
      },
    },
  },
});

// Drizzle
import { invoices } from "./db/schema"; // your Drizzle schema
// Drizzle infers types from schema
type DrizzleInvoice = typeof invoices.$inferSelect;
const drizzleSchema = defineSchema({ invoice: {} as DrizzleInvoice });

const drizzleClient = createClient<typeof drizzleSchema>({
  baseUrl: "http://localhost:3000",
  serializers: {
    invoice: {
      encode(r) { return { ...r, issuedAt: (r.issuedAt as Date).toISOString() }; },
      decode(w) { return { ...w, issuedAt: new Date(w.issuedAt) } as DrizzleInvoice; },
    },
  },
});
```

- **Prisma Decimal**: move as string on the wire; reconstruct with `new Prisma.Decimal(value)`.
- **Drizzle**: use `$inferSelect`/`$inferInsert` to type models; encode dates/BigInts as strings.
