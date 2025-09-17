Benchmarks

This folder contains reproducible benchmarks for the sync engine using tinybench.

Harness scenarios:
- insert_seq: sequential inserts via HTTP client
- insert_concurrent: concurrent inserts via HTTP client
- select_window: paginated reads until exhaustion
- update_conflict: concurrent updates with ifVersion
- notify_latency: end-to-end watcher latency distribution

How to run
1) Build the library so Node can import dist outputs
   npm run build

2) Run the harness (writes JSON to benchmarks/results/)
   npm run bench

Examples
```bash
BENCH_ROWS=10000 BENCH_CONCURRENCY=64 npm run bench
BENCH_SCENARIOS=insert_concurrent,select_window BENCH_ROWS=5000 npm run bench
```

Environment variables
- BENCH_ROWS: Number of ops/seed rows (default: 2000)
- BENCH_CONCURRENCY: Parallelism for concurrent scenarios (default: 32)
- BENCH_SCENARIOS: Comma-separated scenario names
- BENCH_OUTPUT_DIR: Directory for JSON results (default: benchmarks/results)

Legacy micro-benches (still available)
- adapter-sqlite-insert.mjs
- server-mutate-insert.mjs
- server-select-window.mjs
- notify-latency.mjs
Run all: npm run bench:legacy

Notes
- These are micro-benchmarks intended to compare relative performance and detect regressions.
- Ensure your machine is relatively idle for consistent results.
