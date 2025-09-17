Benchmarks

This folder contains simple, reproducible benchmarks for the sync engine.

Scenarios included:
- adapter-sqlite-insert: Raw adapter inserts into file-backed SQLite
- server-mutate-insert: End-to-end HTTP /mutate inserts via createSync
- server-select-window: End-to-end HTTP /select window fetch

How to run
1) Build the library so Node can import dist outputs
   npm run build

2) Tinybench is required for all benchmarks
   Already added as a devDependency.

3) Run the benchmarks
   npm run bench

 Structured JSON output
 - Set BENCH_JSON=1 to emit one JSON line per scenario
   npm run bench:json

 Baseline vs current
 - Baseline (emulates older adapter behavior; records to PERFORMANCE.md)
   npm run bench:baseline
 - Current (optimized path; appends to PERFORMANCE.md)
   npm run bench:current

Environment variables
- BENCH_ROWS: Number of rows to insert/select (default: 2000)
- BENCH_FILE: File path for SQLite (default: OS tmp dir)
- BENCH_JSON: When '1', emits structured JSON rather than console.table
- JS_BENCH_BASELINE: When '1', sqlite adapter runs slower, legacy-like path
- BENCH_FLUSH_MODE: 'sync' | 'async' | 'off' to control file flush latency
 - BENCH_ADAPTER: 'sqlite' (default) or 'libsql' to switch adapters
 - LIBSQL_URL: Optional custom URL for libsql (defaults to file: path)

Notes
- These are micro-benchmarks intended to compare relative performance and detect regressions.
- Ensure your machine is relatively idle for consistent results.

