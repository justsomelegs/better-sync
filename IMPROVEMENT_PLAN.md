## just-sync: Code and DX Improvement Plan

This plan proposes concrete, non-placeholder enhancements to just-sync’s codebase and developer experience. It is organized by priority, with rationale and actionable acceptance criteria. Use this document as the single backlog for implementation.

### Guiding principles
- **DX first**: zero-config defaults, excellent typing (Better Auth-style), and intuitive APIs.
- **Predictable sync**: server-authoritative versions, robust SSE resume, and explicit adapters.
- **No half measures**: every item below is actionable to completion without stubs.

---

### P0 – Correctness, Stability, and Coherent API (Ship immediately)

- **Standardize version semantics end-to-end**
  - Current: versions are stored in `_sync_versions`, but `selectWindow` cursors vary between adapters; default ordering and cursor encoding differ (e.g., SQLite vs memory vs libsql/postgres).
  - Plan: enforce a single canonical pagination model across all adapters:
    - Default order: `{ updatedAt: 'desc', id: 'asc' }` with `id` as deterministic tie-breaker.
    - Cursor payload shape: `{ table, orderBy, last: { keys: Record<string, string|number>, id: string } }` base64-encoded. Adapters must decode/encode identically.
    - Acceptance: all adapters return the same sort and cursor semantics; `e2e` tests cover round-trips, changing `orderBy`, and boundary conditions.

- **Unify error mapping and JSON error envelope**
  - Current: adapters construct `SyncError` inconsistently or throw raw errors mapped later; message/code mapping differs (e.g., libsql/pg conflict mapping).
  - Plan: add a tiny helper to map raw DB errors → `SyncError` with `{ code, message, details }`. Ensure all routes respond with `responseFromError` only.
  - Acceptance: adapter tests show `CONFLICT` on unique violations, `NOT_FOUND` on missing PK updates/deletes, and `BAD_REQUEST` on invalid inputs. Server tests assert consistent error bodies.

- **Idempotency consistency for all writes and mutators**
  - Current: `/mutate` and `/mutators/:name` use idempotency, but acceptance of `clientOpId` and stored values differ in shape.
  - Plan: standardize store payloads to `{ result }` for mutators and direct result for mutations; always set `{ duplicated: true }` flag on hits.
  - Acceptance: tests verify dedupe across retries for each op, ensuring identical responses and no double effects.

- **SSE resume hardening**
  - Current: ring buffer exists with keepalive; resume via `Last-Event-ID` works but lacks backpressure/overflow tests.
  - Plan: expand tests for buffer evictions, long gaps, and immediate replay on resume. Ensure client reconnect backoff and re-snapshot path are documented.
  - Acceptance: `sseResume` tests cover resume within buffer and fallback to fresh snapshot when buffer cannot satisfy.

---

### P1 – Developer Experience Upgrades (High priority)

- **App-wide type augmentation (Better Auth-style)**
  - Current: `AppTypes` interface exists but lacks fully guided DX and helpers.
  - Plan: add a short “Getting Typed” doc and ensure `createClient` honors `AppTypes` without generics. Provide a tiny `sync-env.d.ts` example in README.
  - Acceptance: DX doc with copy-paste snippet; `tsc` example project validates type inference for tables and mutators.

- **Client API ergonomics**
  - Add `client.close()` to terminate SSE/poll timers cleanly.
  - `watch` return handle: include `status`, optional `error`, and `getSnapshot()` for current cached value.
  - Support per-subscription `debounceMs` reliably; ensure immediate notify for mutation followed by debounced snapshot.
  - Acceptance: unit tests for handle lifecycle, snapshot correctness, debounce behavior, and cleanup.

- **Consistent local datastore contract**
  - Current: `memory` and `absurd` exist with differing capabilities; `reconcile` is effectively a no-op.
  - Plan: define and enforce a reconciliation rule: incoming rows with `version` must replace local if newer; older versions ignored. Implement in `apply/reconcile` paths for both stores.
  - Acceptance: datastore tests verify version-aware merges, cursor-based paging, and delete handling.

- **CLI polish and schema-aware DDL**
  - Current: CLI generates baseline SQLite migration. Lacks primary-key/updatedAt overrides and basic indexes.
  - Plan: read `primaryKey` and `updatedAt` from app schema when present, emit idempotent DDL with PK and index on `updatedAt`. Emit `_sync_versions` table always.
  - Acceptance: snapshot tests for generated SQL from several schema shapes; docs updated with usage.

---

### P2 – Adapter and Runtime Consistency (Important)

- **Adapter API completeness**
  - Ensure `ensureMeta()` is implemented and invoked uniformly on startup (when `autoMigrate` is true) and that it never fails silently.
  - Standardize transaction semantics: nested `begin()` respected per adapter (either reference-counted or fail-fast). Today SQLite uses depth; memory is trivial; PG/libsql should pass-through single-level semantics.
  - Acceptance: contract tests run against all adapters to validate begin/commit/rollback flows and meta table presence.

- **Drizzle adapter table resolution**
  - Current: private `__setResolve` is used; document its internal contract and add integration tests with a minimal Drizzle schema to ensure `id` field mapping works.
  - Acceptance: e2e test proves inserts/updates/selectWindow via Drizzle on SQLite/libsql.

- **Cursor and pagination parity**
  - Align memory/libsql/postgres/SQLite on the same cursor encoding and `orderBy` behavior. Remove divergent `encodeCursor/decodeCursor` variants and centralize.
  - Acceptance: cross-adapter suite passes identical pagination tests including stable cursor reuse across app restarts.

---

### P3 – Auth-Ready Surfaces (DX, no enforcement yet)

- **Auth context passthrough**
  - Provide an optional `context` factory to `createSync` that extracts request metadata (e.g., userId from headers/cookies) and passes to mutators.
  - Maintain strict no-op authorization enforcement in MVP; only shape the DX so adding auth later is frictionless.
  - Acceptance: mutator receives `{ db, ctx }` with typed context; tests confirm context propagation.

- **Idempotency key header support**
  - Accept `Idempotency-Key` header on `/mutate` and `/mutators/:name` as an alternative to `clientOpId` (first wins if both provided).
  - Acceptance: tests verify header-based dedupe.

---

### P4 – Realtime and Observability (Quality of life)

- **Structured SSE payloads with optional diffs**
  - Current: emits `tables[{ name, pks, rowVersions }]` without diffs.
  - Plan: optionally include shallow `diffs` maps when changes are known (e.g., update mutations). Client uses diffs to update snapshots without full reselection; fallback remains reselect.
  - Acceptance: client tests assert diff application; server tests assert event framing compatibility.

- **Instrumentation hooks**
  - Add minimal hooks or logging options to trace mutations and SSE emits (counts, durations). No external deps; console logger with toggle.
  - Acceptance: integration test toggles logging and asserts no behavior change.

---

### P5 – Documentation & Examples (Essential for adoption)

- **Top-level README overhaul**
  - Quickstart aligned with actual API (server mount, client usage, mutators, SSE/poll fallback).
  - Type augmentation section with `sync-env.d.ts` example.
  - Adapter selection matrix and features.

- **Examples folder**
  - `examples/nextjs`: Route handlers using `toNextJsHandler`, client hooks, subscription demo.
  - `examples/node`: Minimal Hono/Express mounting with in-memory SQLite.
  - Include schema + CLI migration generation usage.

---

### P6 – Nice-to-haves Post-MVP (doable without placeholders)

- **Client retry/backoff policy**
  - Implement exponential backoff for SSE reconnects with jitter and ceiling; document defaults and allow override in client config.

- **Bulk operations ergonomics**
  - Provide `updateMany`/`deleteMany` client methods that accept an array of PKs; execute sequentially with best-effort semantics and batched idempotency keys.

- **Request-scoped requestId**
  - Echo `X-Request-Id` and include in error `details` to aid logs correlation.

---

### Acceptance Test Additions

- Cross-adapter pagination parity, including cursor reuse and sort stability.
- Idempotency across `/mutate` and `/mutators` with body and header keys.
- SSE resume under buffer churn, with fallback to snapshot on miss.
- Client datastore reconcile rules (version-aware apply/ignore) for memory and absurd stores.
- Drizzle integration tests: CRUD + windowing using table resolver.

---

### Task Backlog (actionable, checkable)

1) Standardize cursor/ordering across adapters; update shared helpers; align tests.
2) Normalize error mapping; assert consistent JSON error envelopes.
3) Strengthen idempotency behavior and duplication flags for all ops.
4) Add SSE resume/overflow tests; document reconnect/backoff behavior.
5) Implement `client.close()` and enrich `watch` handle with `status`, `error`, `getSnapshot`. (Done)
6) Enforce version-aware reconcile in local datastores; add tests.
7) Enhance CLI DDL generation from schema (PK, updatedAt, indexes); snapshot tests.
8) Add `createSync({ context })` request context passthrough for auth-ready DX.
9) Accept `Idempotency-Key` header in routes; tests.
10) Optional `diffs` in SSE payload; client-side diff application with fallback.
11) Minimal logging hooks; opt-in console instrumentation.
12) README rewrite + examples for Next.js and Node; typed setup docs.
13) Drizzle adapter resolver documentation and integration tests.

---

### Notes on Non-Goals (kept explicit)
- No external-writes CDC/triggers yet.
- No server-side query pushdown beyond windows; predicates remain client-side.
- No multi-process SSE fanout or distributed ordering guarantees beyond ULID monotonicity within a single process.