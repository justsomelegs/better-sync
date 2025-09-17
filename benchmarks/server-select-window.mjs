/**
 * Benchmark: client-select-window
 *
 * What it measures
 * - End-to-end paginated reads using the public client API: client.select({ table, limit, cursor }).
 * - Iteratively fetches windows until all rows are read; reports average time per window.
 *
 * Why we benchmark it
 * - Models list/feed screens that page through results where cursor-based pagination dominates perceived latency.
 *
 * Production relevance
 * - Highlights server route overhead + adapter read throughput for pagination, useful for sizing limits and estimating
 *   UI responsiveness under load.
 *
 * Tuning
 * - BENCH_ROWS defines total seeded rows.
 * - Adjust per-call limit in the body below to evaluate tradeoffs between payload size and round trips.
 */
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync, createClient } from '../dist/index.mjs';
import { sqliteAdapter, libsqlAdapter } from '../dist/index.mjs';
import { Bench } from 'tinybench';

const rows = Number(process.env.BENCH_ROWS || 2000);
const dbFile = process.env.BENCH_FILE || join(tmpdir(), `bench_select_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;
const JSON_MODE = process.env.BENCH_JSON === '1';
const useLibsql = process.env.BENCH_ADAPTER === 'libsql';
const db = useLibsql
  ? libsqlAdapter({ url: process.env.LIBSQL_URL || `file:${dbFile}` })
  : sqliteAdapter({ url: dbUrl, flushMode: process.env.BENCH_FLUSH_MODE || 'sync' });
const schema = { bench_items: { schema: z.object({ id: z.string().optional(), name: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } };

// Seed
for (let i = 0; i < rows; i++) {
	await db.insert('bench_items', { id: `w${i}`, name: `n${i}`, updatedAt: Date.now(), version: 1 });
}

const sync = createSync({ schema, database: db, autoMigrate: true });
const server = http.createServer(toNodeHandler(sync.handler));
await new Promise((r) => server.listen(0, r));
const addr = server.address();
if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
const base = `http://127.0.0.1:${addr.port}`;

const client = createClient({ baseURL: base, realtime: 'off' });
console.log(`E2E client.select window over ${rows} rows...`);
const bench = new Bench({ iterations: 1, warmupIterations: 0 });
bench.add('client-select-window', async () => {
  let cursor = null;
  let total = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await client.select({ table: 'bench_items', limit: 200, cursor });
    total += res.data.length;
    cursor = res.nextCursor;
  } while (cursor);
});
const t0 = Date.now();
await bench.run();
const elapsedMs = Date.now() - t0;
if (JSON_MODE) {
  const out = { name: 'client-select-window', rows, elapsedMs, ops: rows / (elapsedMs / 1000), node: process.version, adapter: 'sqlite(sql.js)' };
  console.log(JSON.stringify(out));
} else {
  console.table(bench.table());
}
await new Promise((r) => server.close(() => r()))

