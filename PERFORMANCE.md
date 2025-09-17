## Performance Benchmarks and Improvement Log

This document records baseline and subsequent performance measurements for the library. Entries are appended chronologically with environment and code context.

### Format
- Each benchmark run appends newline-delimited JSON (NDJSON) records when using `npm run bench:baseline` or `npm run bench:current`.
- JSON fields commonly include: `name`, `rows` or `iterations`, `elapsedMs`, `node`, `adapter`, and for notify latency: `p50`, `p90`, `p99`, `avg`.

### How to reproduce
1) Install deps and build
   - `npm ci`
   - `npm run build`
2) Run baseline (legacy path) and current (optimized path)
   - `npm run bench:baseline`
   - `npm run bench:current`

### Entries
Append-only section. Newest at bottom.


#### 2025-09-17 – Baseline vs Current (Rows=2000, Node v22.16.0)

```json
{"name":"client-insert","rows":2000,"elapsedMs":4702,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"client-insert-e2e","rows":2000,"elapsedMs":4655,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"client-select-window","rows":2000,"elapsedMs":527,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"notify-latency","iterations":2000,"elapsedMs":16194,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":6,"avg":3}
```

Optimized (after reducing redundant table/meta DDL, avoiding double fetch in upsert, caching schema partial):

```json
{"name":"client-insert","rows":2000,"elapsedMs":4472,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"client-insert-e2e","rows":2000,"elapsedMs":4391,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"client-select-window","rows":2000,"elapsedMs":512,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"notify-latency","iterations":2000,"elapsedMs":16098,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":5,"avg":3,"ops":124.2575894236216}
```

Notes:
- Insert throughput improved ~4–6% in this environment.
- Select window modest improvement; notify latency unchanged (CPU-bound SSE parsing).

#### 2025-09-17 – Notify latency with flush tuning

```json
{"name":"notify-latency","iterations":2000,"elapsedMs":15861,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":5,"avg":3,"ops":126.09545425887396}
{"name":"notify-latency","iterations":2000,"elapsedMs":13444,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":1,"p90":2,"p99":3,"avg":1,"ops":148.76524843796489}
{"name":"notify-latency","iterations":2000,"elapsedMs":13463,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":1,"p90":2,"p99":4,"avg":1,"ops":148.55529971031717}
```

Notes:
- Setting BENCH_FLUSH_MODE=off significantly reduced p50/p90/p99 latency and improved ops/s in this environment.
- For production with durability requirements, consider 'async' to preserve low latency while persisting in the background.

> just-sync@0.0.0 bench:json
> BENCH_JSON=1 node benchmarks/adapter-sqlite-insert.mjs && BENCH_JSON=1 node benchmarks/server-mutate-insert.mjs && BENCH_JSON=1 node benchmarks/server-select-window.mjs && BENCH_JSON=1 node benchmarks/notify-latency.mjs

Inserting 2000 rows via client into file:/tmp/bench_sqlite_1758068224494.sqlite...
{"name":"client-insert","rows":2000,"elapsedMs":4702,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
E2E client.insert 2000 rows...
{"name":"client-insert-e2e","rows":2000,"elapsedMs":4655,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
E2E client.select window over 2000 rows...
{"name":"client-select-window","rows":2000,"elapsedMs":527,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
Benchmarking notify latency over 2000 iterations (client.watch)...
{"name":"notify-latency","iterations":2000,"elapsedMs":16194,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":6,"avg":3}

> just-sync@0.0.0 bench:json
> BENCH_JSON=1 node benchmarks/adapter-sqlite-insert.mjs && BENCH_JSON=1 node benchmarks/server-mutate-insert.mjs && BENCH_JSON=1 node benchmarks/server-select-window.mjs && BENCH_JSON=1 node benchmarks/notify-latency.mjs

Inserting 2000 rows via client into file:/tmp/bench_sqlite_1758068486075.sqlite...
{"name":"client-insert","rows":2000,"elapsedMs":4472,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
E2E client.insert 2000 rows...
{"name":"client-insert-e2e","rows":2000,"elapsedMs":4391,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
E2E client.select window over 2000 rows...
{"name":"client-select-window","rows":2000,"elapsedMs":512,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
Benchmarking notify latency over 2000 iterations (client.watch)...
{"name":"notify-latency","iterations":2000,"elapsedMs":16098,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":5,"avg":3}
Benchmarking notify latency over 2000 iterations (client.watch)...
{"name":"notify-latency","iterations":2000,"elapsedMs":15861,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":5,"avg":3,"ops":126.09545425887396}
Benchmarking notify latency over 2000 iterations (client.watch)...
{"name":"notify-latency","iterations":2000,"elapsedMs":13444,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":1,"p90":2,"p99":3,"avg":1,"ops":148.76524843796489}
Benchmarking notify latency over 2000 iterations (client.watch)...
{"name":"notify-latency","iterations":2000,"elapsedMs":13463,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":1,"p90":2,"p99":4,"avg":1,"ops":148.55529971031717}
