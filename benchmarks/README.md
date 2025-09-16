Benchmarks

This folder contains simple, reproducible benchmarks for the sync engine.

Scenarios included:
- adapter-sqlite-insert: Raw adapter inserts into file-backed SQLite
- server-mutate-insert: End-to-end HTTP /mutate inserts via createSync
- server-select-window: End-to-end HTTP /select window fetch

How to run
1) Build the library so Node can import dist outputs
   npm run build

2) (Recommended) Install Tinybench for nicer stats
   npm i -D tinybench

3) Run the benchmarks
   npm run bench

Environment variables
- BENCH_ROWS: Number of rows to insert/select (default: 2000)
- BENCH_FILE: File path for SQLite (default: OS tmp dir)

Notes
- These are micro-benchmarks intended to compare relative performance and detect regressions.
- If tinybench is not installed, scripts fall back to simple manual timing.
- Ensure your machine is relatively idle for consistent results.

