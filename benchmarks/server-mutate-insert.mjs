import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync } from '../dist/index.mjs';
import { sqliteAdapter } from '../dist/server.mjs';
let Tinybench; try { Tinybench = await import('tinybench'); } catch {}

const rows = Number(process.env.BENCH_ROWS || 2000);
const dbFile = process.env.BENCH_FILE || join(tmpdir(), `bench_server_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;
const db = sqliteAdapter({ url: dbUrl });
const schema = { bench_items: { schema: z.object({ id: z.string().optional(), name: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } };

const sync = createSync({ schema, database: db, autoMigrate: true });
const server = http.createServer(toNodeHandler(sync.handler));
await new Promise((r) => server.listen(0, r));
const addr = server.address();
if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
const base = `http://127.0.0.1:${addr.port}`;

console.log(`E2E /mutate insert ${rows} rows...`);
if (Tinybench?.Bench) {
  const bench = new Tinybench.Bench({ iterations: 1 });
  bench.add('server-mutate-insert', async () => {
    for (let i = 0; i < rows; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'bench_items', rows: { id: `s${i}`, name: `n${i}` } }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
  });
  await bench.run();
  const task = bench.tasks[0];
  const ms = task.result?.sum || 0;
  const rowsPerSec = Math.round((rows / ms) * 1000);
  console.log(bench.table());
  console.log(`Throughput: ${rowsPerSec} rows/s`);
} else {
  const t0 = Date.now();
  for (let i = 0; i < rows; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'bench_items', rows: { id: `s${i}`, name: `n${i}` } }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
  const ms = Date.now() - t0;
  console.log(`Inserted ${rows} rows via HTTP in ${ms}ms (${Math.round((rows / ms) * 1000)} rows/s)`);
}
await new Promise((r) => server.close(() => r()))

