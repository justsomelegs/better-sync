## Request Context in just-sync

`createSync({ context })` lets you derive a per-request context object from the incoming `Request`. This enables seamless integration with any auth/session library (NextAuth, Better Auth, Clerk, Auth0, custom JWT, etc.) and cleanly passes identity/tenant metadata into your mutators.

### What is request context?

Request context is an object you return for each HTTP request handled by `just-sync`. It’s provided to your mutator handlers as `handler({ db, ctx }, args)`. Common fields include `userId`, `roles`, `tenantId`, and request metadata such as `ip` or `userAgent`.

### Defining context

Provide a `context` function when creating your sync instance:

```ts
import { createSync } from 'just-sync';
import { sqliteAdapter } from 'just-sync/storage/server';

type MyContext = { userId: string | null; roles: string[]; tenantId?: string };

export const sync = createSync({
  schema,
  database: sqliteAdapter({ url: 'file:./app.db' }),
  context: async (req): Promise<MyContext> => {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    const user = token ? await verifyJwt(token) : null;
    const tenantId = req.headers.get('X-Tenant-Id') || undefined;
    return { userId: user?.sub ?? null, roles: user?.roles ?? [], tenantId };
  },
  mutators: {
    addTodo: {
      args: z.object({ title: z.string().min(1) }),
      async handler({ db, ctx }, { title }) {
        if (!ctx.userId) throw new SyncError('BAD_REQUEST', 'Unauthenticated');
        return db.insert('todos', { title, done: false, ownerId: ctx.userId, updatedAt: Date.now(), version: 1 });
      }
    }
  }
});
```

Notes:
- The `context` function runs for every request, including `/mutate`, `/mutators/:name`, `/select`, and SSE `/events` (if needed in future). Today, `context` is delivered to mutators and mutation routes; it can be extended to reads if you need authorization for read windows.
- Keep context resolution fast and side-effect free. Cache user lookups using stateless tokens or lightweight fetches.

### Using with popular auth solutions

Below are examples of deriving `context` with common approaches:

#### Cookie session (Better Auth / NextAuth style)

```ts
context: async (req) => {
  const cookie = req.headers.get('cookie') || '';
  const session = await myAuth.getSessionFromCookie(cookie);
  return { userId: session?.user?.id ?? null, roles: session?.user?.roles ?? [] };
}
```

#### JWT in Authorization header

```ts
context: async (req) => {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const claims = token ? await verifyJwt(token) : null;
  return { userId: claims?.sub ?? null, roles: claims?.roles ?? [] };
}
```

#### Clerk / Auth0 / Custom providers

```ts
context: async (req) => {
  const user = await clerkOrAuth0.getUserFromRequest(req);
  return { userId: user?.id ?? null, roles: user?.roles ?? [], tenantId: user?.orgId };
}
```

#### Better Auth (Next.js App Router)

The Better Auth SDK typically exposes an initialized `auth` instance with helpers to read the current session from a `Request` or cookies. Depending on your setup, one of the following patterns will apply. Replace `~/server/auth` with where you initialize your Better Auth instance.

```ts
// server/sync.ts
import { createSync, SyncError } from 'just-sync';
import { sqliteAdapter } from 'just-sync/storage/server';
import { z } from 'zod';
import { auth } from '~/server/auth'; // your Better Auth instance

export const sync = createSync({
  schema,
  database: sqliteAdapter({ url: 'file:./app.db' }),
  context: async (req) => {
    // Variant A: Better Auth can read from the Request directly
    try {
      const session = await auth.getSession?.(req);
      if (session) return { userId: session.user.id, roles: session.user.roles ?? [] };
    } catch {}

    // Variant B: derive from cookies (if your helper expects raw cookies)
    const cookie = req.headers.get('cookie') || '';
    try {
      const session = await auth.getSessionFromCookie?.(cookie);
      if (session) return { userId: session.user.id, roles: session.user.roles ?? [] };
    } catch {}

    return { userId: null, roles: [] };
  },
  mutators: {
    createNote: {
      args: z.object({ title: z.string().min(1) }),
      async handler({ db, ctx }, { title }) {
        if (!ctx.userId) throw new SyncError('BAD_REQUEST', 'Unauthenticated');
        return db.insert('notes', {
          id: undefined,
          title,
          ownerId: ctx.userId,
          updatedAt: Date.now(),
          version: 1
        });
      }
    }
  }
});

// app/api/sync/route.ts (Next.js route handler)
import { toNextJsHandler } from 'just-sync/next-js';
import { sync } from '~/server/sync';
export const { GET, POST } = toNextJsHandler(sync.handler);
```

Tips:
- Pick the Better Auth helper that matches your setup (Request-based or cookies-based) and remove the other variant.
- If roles/permissions are part of the session, include them in `ctx` to enforce mutator-level authorization.

### Enforcing authorization in mutators

Mutators receive `ctx` so you can enforce fine-grained authorization and multi-tenancy policies:

```ts
toggleDone: {
  args: z.object({ id: z.string(), done: z.boolean() }),
  async handler({ db, ctx }, { id, done }) {
    if (!ctx.userId) throw new SyncError('BAD_REQUEST', 'Unauthenticated');
    const row = await db.selectByPk('todos', id, ['id', 'ownerId']);
    if (!row) throw new SyncError('NOT_FOUND', 'Todo not found');
    if (row.ownerId !== ctx.userId) throw new SyncError('BAD_REQUEST', 'Forbidden');
    return db.updateByPk('todos', id, { done, updatedAt: Date.now(), version: (row as any).version ? (row as any).version + 1 : 1 });
  }
}
```

### Typing your context end-to-end

For full type safety in your app, annotate your context type and leverage module augmentation to propagate it to your client code’s expectations where appropriate.

```ts
type MyContext = { userId: string | null; roles: string[] };
export const sync = createSync<{ /* Mutators */ }>({
  schema,
  database: adapter,
  context: (req): MyContext | Promise<MyContext> => {/* ... */}
});
```

### Idempotency and context

When using `Idempotency-Key` or `clientOpId`, repeated requests should yield the same effect. Your `context` should not inject side effects in mutators (e.g., don’t generate new identifiers in `context` itself). Keep it to identity/metadata derivation.

### Debugging and observability

- Enable client `debug: true` to log requests and latencies, and wrap your server with request-id echoing (already built-in in errors).
- Include a `requestId` header in the client when available and forward it in logs to correlate client/server traces.

### Security considerations

- Always validate and sanitize inputs in mutators (use Zod schemas).
- Treat `context` as untrusted until your auth library has verified tokens/sessions.
- Consider tenant isolation strategies (row-level checks, tenantId scoping, separate databases).

