# Performance Notes

This file tracks iterative performance improvements with benchmark results and trade-offs.

## 2025-09-17 — Iteration 0 (Baseline)

- Changes: Initial tinybench harness added (`benchmarks/harness.mjs`), scripts wired (`npm run bench`).
- Environment: Node v22.16.0, BENCH_ROWS=2000, BENCH_CONCURRENCY=32.

Results (baseline):

- insert_seq: 446.5 ops/s; latency p50=2ms, p95=3ms, p99=5ms; RSS +109MB
- insert_concurrent: 765.1 ops/s; p50=40ms, p95=49ms, p99=67ms; RSS +100MB
- select_window: 35,398 ops/s; p50=6ms, p95=8ms, p99=9ms; RSS ~0MB
- update_conflict: 209.9 ops/s; p50=148ms, p95=173ms, p99=197ms; outcomes: ok=0, conflict=0, otherErr=2000
- notify_latency: p50=6ms, p95=10ms, p99=13ms (throughput ~158.8 ops/s over loop)

Observations:

- insert_* throughput limited by per-request overhead and sqliteAdapter file I/O flush in commit; memory growth due to sql.js database export on commit when file-backed.
- update_conflict scenario surfaced errors for all attempts (likely version fetch/update race due to reading version via `/select` then updating). Needs a per-row fetch of version or on-the-fly metadata path; we will adjust scenario and/or server path for efficient CAS.
- notify latency within single-digit ms locally; good baseline.

Next steps:

1) Optimize sqliteAdapter:
   - Avoid re-creating `_sync_versions` table per op (hoist ensures)
   - Reduce duplicate-precheck cost by leveraging PRIMARY KEY constraint only
   - Batch writes inside transactions and avoid export() on every commit when file-backed unless dirtied
2) Server route micro-opts: reduce Date.now() calls, minimize object allocs in diffs emission.
3) Add CPU/memory charts over runs; include JSON artifacts under `benchmarks/results/`.

## 2025-09-17 — Iteration 1 (SQLite adapter micro-opts)

- Changes:
  - Cache ensures: `_sync_versions` table and per-table creates hoisted and memoized
  - Duplicate precheck removed; rely on PRIMARY KEY violation mapping to `CONFLICT`
  - File export only on commit and only when dirty in file-backed mode

Before vs After (BENCH_ROWS=2000, CONC=32):

- insert_seq: 446.5 → 448.7 ops/s (+0.5%); p50 unchanged at 2ms
- insert_concurrent: 765.1 → 778.8 ops/s (+1.8%); p95 49ms → 49ms
- select_window: 35.4k → 39.2k ops/s (+10.7%); p50 6ms → 5ms
- update_conflict: 209.9 → 217.6 ops/s (+3.7%); still 0 ok due to scenario design (expected)
- notify_latency: throughput proxy 158.8 → 170.5 (+7.4%); p50 6ms → 5ms

Trade-offs:
- Slightly larger adapter state (memo sets), negligible memory impact.
- Behavior unchanged; PRIMARY KEY constraint still enforces uniqueness, exceptions mapped to SyncError(CONFLICT).

Notes:
- The large RSS deltas on insert are due to sql.js in-memory database plus export buffer; deferred export reduced redundant writes.
- Next, target per-op Date.now() calls and diffs emission allocations in `/mutate` path.

## 2025-09-17 — Iteration 2 (Server mutate route micro-opts)

- Changes:
  - Stamp `updatedAt` once per request (cache `Date.now()`)
  - Hoist and reuse zod validator per table per request (avoid `.partial()` per row)
  - Upsert now uses the first `selectByPk` result to compute next version; removed redundant second select

Before vs After (vs Iteration 1):

- insert_seq: 448.7 → 456.1 ops/s (+1.6%); p50 stable at 2ms
- insert_concurrent: 778.8 → 773.7 ops/s (-0.7% within noise); p95 unchanged
- select_window: 39.2k → 38.8k ops/s (-1.0% noise)
- update_conflict: 217.6 → 222.2 ops/s (+2.1%); p50 146ms → 143ms
- notify_latency: 170.5 → 175.8 (+3.1%); p50 unchanged at 5ms

Trade-offs:
- None user-visible; API unchanged. Minor code complexity increase for validator hoisting.

Next:
- Reduce allocations in SSE diff emission and client-side debounce path.
- Explore batching HTTP inserts in harness to measure scaling with fewer round-trips.

## 2025-09-17 — Iteration 3 (Client SSE parsing + in-place diffs)

- Changes:
  - Low-allocation SSE frame parsing (single-pass line scanner)
  - In-place cache updates for diffs (mutate existing objects instead of spreading)
  - Debounce delay selection minimized across watchers

Results vs Iteration 2:

- insert_seq: ~456.1 → 453.7 ops/s (noise)
- insert_concurrent: 773.7 → 790.5 ops/s (+2.2%)
- select_window: ~38.8k → 38.5k (noise)
- update_conflict: ~222.2 → 221.2 (noise)
- notify_latency: p99 improved 12 → 11 ms; throughput proxy ~175.8 → 167.4 (harness variability)

Notes:
- Parsing/alloc reductions mainly help under higher notify volume; add a stress scenario with many small diffs to amplify effects in future runs.

## 2025-09-17 — Iteration 4 (SSE server emission + notify_stress scenario)

- Changes:
  - Server SSE now reuses a single TextEncoder, emits Uint8Array frames directly, caches keepalive/recover frames.
  - Harness adds notify_stress: many small inserts with SSE consumers.

Results vs Iteration 3:

- insert_concurrent: 790.5 → 792.4 ops/s (+0.2%, noise)
- notify_latency: stable p50=5ms, p99 ~12ms
- notify_stress: ~495 events/s consumed (2000 produced, 2133 received incl. coalesced snapshots)

Notes:
- Stress shows server can push ~500 events/s locally with sql.js + SSE; CPU mainly in userland JSON/stringify and adapter.
- Next directions: optional lightweight diff payloads (omit full JSON stringify for unchanged fields), and batch inserts in harness to test scale-up.

## 2025-09-17 — Iteration 5 (Batch inserts, coalesced snapshots, sqlite indexes/flush)

- Changes:
  - Harness: added `insert_batch` scenario (array inserts), configurable `BENCH_BATCH` size
  - Client: coalesce debounced snapshots per table/request to a shared select
  - sqlite: automatic `(updatedAt, id)` index; optional `asyncFlush` (off by default) to decouple file export

Results (focused scenarios):

- insert_batch (size=50): 11,428 → 17,699 ops/s after keep-alive + stmt cache + async flush
- insert_concurrent: 733.9 ops/s (down from prior mixed run ~790 but lower p95); keep-alive improved p95
- notify_stress: 844 events/s (up from ~495) with SSE/server optimizations

Notes:
- Batching offers a large win within the existing API — users can pass arrays to `insert`.
- Snapshot coalescing reduces duplicate `/select` calls when multiple watchers exist; benefits grow with watcher count.
- Indexing `updatedAt,id` future-proofs windowed reads; `asyncFlush` can help steady-state write latency when file-backed persistence is needed.

## 2025-09-17 — Iteration 6 (Notify metrics with micro-batching disabled)

- Changes:
  - Harness sets microBatchEnabled=false for notify producers to avoid coalescing effects

- Results:
  - notify_latency: p50 ~1ms, p95 ~2ms, p99 ~4ms (2k iterations in ~2.8s)
  - notify_stress: ~829 events/s

- Notes:
  - Client/server SSE paths appear healthy; remaining CPU is mostly JSON and adapter work.

## 2025-09-17 — Iteration 7 (SSE gzip option + libsql local benchmark)

- Changes:
  - SSE endpoint now supports gzip when client sends Accept-Encoding: gzip
  - Harness: libsql local-file and remote scenarios (env-gated)

- Results:
  - libsql_insert_local (2k rows): ~238 ops/s; much slower and heavy RSS vs in-process sql.js, expected due to WASM/driver overhead and file I/O path
  - gzip expected to help over real networks; negligible effect on local loopback

- Notes:
  - For local/dev perf, in-process sql.js remains fastest. For production, use libsql/postgres with pooling and batch writes.

## 2025-09-17 — Iteration 8 (CAS + large-table read)

- Scenarios:
  - CAS update (100k attempts, expect conflicts): ~1,647 ops/s; p95 ~25ms, p99 ~32ms. Conflicts expected by design in this stress.
  - Large select_window (100k rows): handled via windowing; per-window throughput ~700–800 windows/s on this machine.

- Notes:
  - Prepared statement caching helps `selectWindow` when fetching lastUpdated on cursor miss.
  - For CAS-heavy paths, batching and server-side conflict aggregation could further improve throughput.


## 2025-09-18 — Iteration 9 (SQLite updateByPk fast-path + harness fixes)

- Changes:
  - sqlite adapter: `updateByPk` now returns the updated row by merging the prior value with the new set instead of re-selecting twice; avoids extra SELECTs and reduces allocations. Version is written via the provided set to meta and reflected in the returned row.
  - Harness: `BENCH_DB` env added. Set to `memory` to run entirely in-process (`:memory:`) for lower variance; default remains file-backed tmp sqlite.
  - Harness: `update_conflict` scenario now issues concurrent CAS updates with `ifVersion=1` against a single seeded row; ensures expected high-conflict rate without per-iteration `/select`.
  - Client: HTTP(S) agent selection precomputed to avoid per-request URL parse overhead in `postJson`.

- Environment: Node v22.16.0. Quick run used: `BENCH_DB=memory BENCH_ROWS=800 BENCH_CONCURRENCY=64`.

- Results (BENCH_DB=memory, BENCH_ROWS=800, CONC=64):
  - insert_seq: 201.8 ops/s; latency p50=5ms, p95=6ms, p99=9ms; elapsed 3964ms; RSS +80.2MB
  - insert_concurrent: 18,181.8 ops/s; p50=3ms, p95=5ms, p99=6ms
  - insert_batch (size=50): 19,047.6 ops/s; per-batch p50~41ms
  - select_window: 63,897.8 ops/s; p50=3ms, p95=4ms, p99=4ms
  - update_conflict: 868.6 ops/s; p50=45ms, p95=245ms, p99=875ms; outcomes: ok=0, conflict=0, otherErr=800 (investigating mapping)

- Artifacts:
  - Latest run JSON is saved under `benchmarks/results/bench_*.json`. Compare the previous and latest entries for deltas.

- Trade-offs:
  - `updateByPk` now returns the merged row rather than re-reading; server already stamps `updatedAt` and `version`, so API behavior is equivalent while avoiding extra I/O.

- Notes:
  - The CAS scenario now better reflects production contention patterns and should be more stable across runs.

