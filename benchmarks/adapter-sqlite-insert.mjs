import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteAdapter } from '../dist/server.mjs';
import { Bench } from 'tinybench';

const rows = Number(process.env.BENCH_ROWS || 2000);
const dbFile = process.env.BENCH_FILE || join(tmpdir(), `bench_sqlite_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;

const db = sqliteAdapter({ url: dbUrl });
await db.ensureMeta?.();

await db.begin();
console.log(`Inserting ${rows} rows into ${dbUrl}...`);
const bench = new Bench({ iterations: 1, warmupIterations: 0 });
let run = 0;
bench.add('adapter-sqlite-insert', async () => {
  const runId = run++;
  for (let i = 0; i < rows; i++) {
    // eslint-disable-next-line no-await-in-loop
    await db.insert('bench_items', { id: `b${runId}-${i}`, name: `n${runId}-${i}`, updatedAt: Date.now(), version: 1 });
  }
});
await bench.run();
await db.commit();
console.table(bench.table());

