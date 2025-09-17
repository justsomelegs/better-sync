## Performance Benchmarks and Improvement Log

This document records baseline and subsequent performance measurements for the library.

Format:
- NDJSON lines under each dated heading
- Fields: name, rows|iterations, elapsedMs, node, adapter, optional ops and latency percentiles

#### 2025-09-17 – Baseline vs Current (Rows=2000, Node v22.16.0)
```json
{"name":"client-insert","rows":2000,"elapsedMs":4702,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"client-insert-e2e","rows":2000,"elapsedMs":4655,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"client-select-window","rows":2000,"elapsedMs":527,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"notify-latency","iterations":2000,"elapsedMs":16194,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":6,"avg":3}
```

Optimized:
```json
{"name":"client-insert","rows":2000,"elapsedMs":4472,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"client-insert-e2e","rows":2000,"elapsedMs":4391,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"client-select-window","rows":2000,"elapsedMs":512,"node":"v22.16.0","adapter":"sqlite(sql.js)"}
{"name":"notify-latency","iterations":2000,"elapsedMs":16098,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":5,"avg":3,"ops":124.2575894236216}
```

#### 2025-09-17 – Notify latency tuning
```json
{"name":"notify-latency","iterations":2000,"elapsedMs":15861,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":3,"p90":4,"p99":5,"avg":3,"ops":126.09545425887396}
{"name":"notify-latency","iterations":2000,"elapsedMs":13444,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":1,"p90":2,"p99":3,"avg":1,"ops":148.76524843796489}
{"name":"notify-latency","iterations":2000,"elapsedMs":13463,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":1,"p90":2,"p99":4,"avg":1,"ops":148.55529971031717}
{"name":"notify-latency","iterations":2000,"elapsedMs":13460,"node":"v22.16.0","adapter":"sqlite(sql.js)","p50":1,"p90":2,"p99":4,"avg":1,"ops":148.58841010401187}
```

#### 2025-09-17 – Adapter switch to libsql (file: URL)
```json
{"name":"client-insert","rows":2000,"elapsedMs":25,"ops":80000,"node":"v22.16.0","adapter":"libsql(file)"}
{"name":"client-insert-e2e","rows":2000,"elapsedMs":66,"ops":30303.0303030303,"node":"v22.16.0","adapter":"libsql(file)"}
{"name":"client-select-window","rows":2000,"elapsedMs":516,"ops":3875.968992248062,"node":"v22.16.0","adapter":"libsql(file)"}
{"name":"notify-latency","iterations":2000,"elapsedMs":21020,"node":"v22.16.0","adapter":"libsql(file)","p50":5,"p90":7,"p99":9,"avg":5,"ops":95.14747859181732}
```

