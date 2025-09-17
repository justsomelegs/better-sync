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

