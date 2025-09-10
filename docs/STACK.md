## Better Sync Stack & Development Guide

### Objective
Describe the technical stack and provide a practical, beginner-friendly guide to developing, testing, and releasing the Better Sync packages, modeled after the better-auth developer experience.

### Stack Overview (better-auth-style)
- **Language/Runtime**: TypeScript (strict) on Node.js 18+; ESM-only output (modern standard).
- **Package Manager**: npm workspaces (monorepo), reproducible installs.
- **Build**: TypeScript project references (`tsc -b`) for builds; exports map per entry.
- **Testing**: Vitest (unit), conformance via `@bettersync/testkit`, optional Playwright for e2e.
- **Lint/Format**: Biome (formatter + linter in one) for speed and consistency.
- **Docs**: JSDoc with `@example` (Typedoc or Docusaurus site later).
- **Releases**: Changesets (versioning, changelog), GitHub Actions publish pipeline.
- **CI**: GitHub Actions (install, cache, lint, test, build, release) with Turbo caching.
- **Targets**: Browser and Node; Turbo repo orchestration.

#### For beginners:
- **npm** is the default package manager that comes with Node. We use npm workspaces for the monorepo.
- **ESM** is the modern JavaScript module format. We ship ESM-only to simplify builds and interop.
- **tsc** (TypeScript compiler) builds the code and emits type definitions for editors.

### Monorepo Layout
```
/ packages/
  better-sync/                 # single package (core + providers + subpath exports)
/ examples/
  node-basic/                  # minimal Node example
  nextjs-app/                  # optional framework example
/ docs/
  STACK.md
  PLAN.md
```

### Package Conventions
- **ESM-only** package with exports map; ship `module` and `types`.
- **Typed public API** only; internal utils kept private.
- **Entry points**:
  - `better-sync` (core)
  - `better-sync/storage` (storage APIs)
  - `better-sync/transport` (transports)
  - `better-sync/auth` (auth providers)
  - `better-sync/plugins/*` (optional plugins)
  - `better-sync/models` (model helpers)

Example `package.json` excerpt (ESM-only):
```json
{
  "name": "better-sync",
  "type": "module",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./storage": { "types": "./dist/storage/index.d.ts", "import": "./dist/storage/index.js" },
    "./transport": { "types": "./dist/transport/index.d.ts", "import": "./dist/transport/index.js" },
    "./auth": { "types": "./dist/auth/index.d.ts", "import": "./dist/auth/index.js" }
  }
}
```

### Build (TypeScript project references)
Use `tsc -b` (build mode) with a base config and per-package `tsconfig.json`.

`tsconfig.base.json` sketch:
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "strict": true,
    "moduleResolution": "Bundler",
    "skipLibCheck": true
  }
}
```

Per-package `tsconfig.json` sketch:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "compilerOptions": {
    "rootDir": "src"
  },
  "references": []
}
```

Root build runs `turbo run build` which calls `tsc -b` in each package.

### Scripts (root)
```json
{
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "changeset": "changeset",
    "release": "changeset version && turbo run build && changeset publish"
  },
  "workspaces": ["packages/*", "examples/*"]
}
```

### Linting & Formatting
- **Biome** replaces ESLint + Prettier with a single fast tool for formatting and linting.

`biome.json` sketch:
```json
{
  "$schema": "https://biomejs.dev/schemas/1.7.0/schema.json",
  "formatter": { "enabled": true },
  "linter": { "enabled": true },
  "files": { "ignore": ["dist", "**/*.config.*"] }
}
```
### Testing
- **Vitest** for unit tests.
- **Conformance** via `@bettersync/testkit` across adapters/transports.
- Optional **Playwright** e2e for browser flows.

Example conformance:
```ts
import { createConformanceSuite } from "@bettersync/testkit";
import { sqlite } from "better-sync/storage";

const suite = createConformanceSuite({ storage: sqlite({ file: ":memory:" }) });
await suite.run();
```

### Install baseline
- Single install:
```bash
npm install better-sync
```
- Optional auth provider:
```bash
# No extra install; use subpath import better-sync/auth
```

### Packages We Use (and why)
- **npm**: default package manager; npm workspaces manage the monorepo.
- **Turbo**: task runner and remote cache; orchestrates builds/tests across packages.
- **Biome**: unified formatter + linter; simpler setup than ESLint+Prettier.
- **TypeScript**: strict types across all packages; emits `.d.ts` for consumers.
- **tsc**: TypeScript compiler for building packages and emitting `.d.ts`.
- **Vitest**: fast unit tests with great TypeScript support.
- **Playwright** (optional): browser e2e tests.
- **GitHub Actions**: CI pipelines for lint/test/build/release; leverages Turbo cache.
- **Changesets**: versioning and publishing; human-readable changelogs.

(Modeled after better-auth’s modern TS tooling and monorepo setup.)

### Development Workflow
1. Install dependencies
```bash
npm i
```
2. Build once or watch
```bash
npm run build
# or per-package via Turbo scopes
npx turbo run dev --filter=better-sync --parallel
```
3. Run tests
```bash
npm test
```
4. Lint & typecheck
```bash
npm run lint && npm run typecheck
```
5. Run examples during dev
```bash
npx turbo run dev --filter=./examples/nextjs-app --parallel
```

#### For beginners:
- Run `npm i` to install. `npm run build` compiles packages. `npm test` runs tests and tells you if anything broke. `npm run dev` (via Turbo) watches files and rebuilds fast while you edit.

### Versioning & Releases (Changesets)
- Use `changeset` to record changes per PR.
```bash
npx changeset
# choose package(s), bump type, write message
```
- On main: `npm run release` will version, build, and publish via CI.
- Keep releases atomic and well-typed; include migration notes when needed.

### CI (GitHub Actions outline)
- Jobs: setup Node, install with npm ci, restore Turbo cache, build, test, lint, typecheck.
- Enable Turbo remote cache for faster PR feedback.
- Release workflow triggers on `changeset` status or tags.

### Docs Authoring (JSDoc-first)
- Require JSDoc on all public APIs with `@example` blocks so editors show usage.
```ts
/**
 * Apply a change to a model.
 * @example
 * const res = await sync.applyChange("todo", { type: "insert", id: "1", value: { title: "A" } });
 * if (res.ok) console.log("applied");
 */
export function applyChange() {}
```

### Choosing Providers (examples use syntactic sugar)
```ts
import { idb } from "better-sync/storage";         // client
import { sqlite, postgres } from "better-sync/storage"; // server
import { ws, rpc } from "better-sync/transport";
import { jwt } from "better-sync/auth";
```
- Prefer provider helpers for clarity and better types.

### Adding a New Storage Adapter (developer guide)
1. Add source under `packages/better-sync/src/storage/providers/<name>.ts`.
2. Export functions from `packages/better-sync/src/storage/index.ts`.
3. Run conformance: `@bettersync/testkit` (push/pull/cursor/conflict test matrix).
4. Ensure subpath export continues to tree-shake.
5. Document defaults (wire normalization) and edge cases.

### Publishing Checklist
- [ ] All packages build (ESM-only), types emitted.
- [ ] Unit + conformance tests pass.
- [ ] Exports map contains new entry points.
- [ ] JSDoc examples added/updated.
- [ ] Changeset added and versioned.

### Notes
- Keep APIs framework-agnostic and database-agnostic.
- Favor **result-returning** APIs on hot paths with stable `SYNC:*` error codes.
- Ensure adapters normalize wire types to JSON-safe values by default.
- Stack and repo flow inspired by `better-auth` ([GitHub](https://github.com/better-auth/better-auth)).
