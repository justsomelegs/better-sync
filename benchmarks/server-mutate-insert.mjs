/**
 * Benchmark: client-insert-e2e
 *
 * What it measures
 * - End-to-end HTTP insert throughput with the public client API over the running server.
 * - Validates the full mutate path including validation, stamping, id/version handling, and adapter write.
 *
 * Why we benchmark it
 * - Mirrors how real applications will write data via the client SDK.
 * - Quantifies per-request overhead in a sequential scenario (no artificial concurrency here).
 *
 * Production relevance
 * - Serves as a conservative baseline. Expect much higher throughput with parallelism (e.g., 10–100 concurrent
 *   inserts), HTTP keep-alive, and production DB drivers (libsql/postgres) with pooling.
 *
 * Tuning
 * - BENCH_ROWS controls the total inserts performed within the Tinybench task.
 */
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync, createClient } from '../dist/index.mjs';
import { sqliteAdapter } from '../dist/server.mjs';
import { Bench } from 'tinybench';

const rows = Number(process.env.BENCH_ROWS || 2000);
const dbFile = process.env.BENCH_FILE || join(tmpdir(), `bench_server_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;
const JSON_MODE = process.env.BENCH_JSON === '1';
const db = sqliteAdapter({ url: dbUrl });
const schema = { bench_items: { schema: z.object({ id: z.string().optional(), name: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } };

const sync = createSync({ schema, database: db, autoMigrate: true });
const server = http.createServer(toNodeHandler(sync.handler));
await new Promise((r) => server.listen(0, r));
const addr = server.address();
if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
const base = `http://127.0.0.1:${addr.port}`;

const client = createClient({ baseURL: base, realtime: 'off' });
console.log(`E2E client.insert ${rows} rows...`);
const bench = new Bench({ iterations: 1, warmupIterations: 0 });
let run = 0;
bench.add('client-insert-e2e', async () => {
  const runId = run++;
  for (let i = 0; i < rows; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.insert('bench_items', { id: `s${runId}-${i}`, name: `n${runId}-${i}` });
  }
});
const t0 = Date.now();
await bench.run();
const elapsedMs = Date.now() - t0;
if (JSON_MODE) {
  const out = { name: 'client-insert-e2e', rows, elapsedMs, node: process.version, adapter: 'sqlite(sql.js)' };
  console.log(JSON.stringify(out));
} else {
  console.table(bench.table());
}
await new Promise((r) => server.close(() => r()))

