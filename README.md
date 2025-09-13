## just-sync monorepo (MVP)

- Package: `packages/just-sync` (ESM, TypeScript)
- Example: `examples/hono-app` (Hono server)

Quickstart

```bash
npm i
npm run build
npm run dev -w examples/hono-app
```

Then visit `http://localhost:8787` and call endpoints like `POST /api/sync/mutate`.

