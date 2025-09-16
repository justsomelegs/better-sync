import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteAdapter } from '../dist/server.mjs';
let Tinybench; try { Tinybench = await import('tinybench'); } catch {}

const rows = Number(process.env.BENCH_ROWS || 2000);
const dbFile = process.env.BENCH_FILE || join(tmpdir(), `bench_sqlite_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;

const db = sqliteAdapter({ url: dbUrl });
await db.ensureMeta?.();

await db.begin();
console.log(`Inserting ${rows} rows into ${dbUrl}...`);
if (Tinybench?.Bench) {
  const bench = new Tinybench.Bench({ iterations: 1 });
  bench.add('adapter-sqlite-insert', async () => {
    for (let i = 0; i < rows; i++) {
      // eslint-disable-next-line no-await-in-loop
      await db.insert('bench_items', { id: `b${i}`, name: `n${i}`, updatedAt: Date.now(), version: 1 });
    }
  });
  await bench.run();
  await db.commit();
  const task = bench.tasks[0];
  const ms = task.result?.sum || 0;
  const rowsPerSec = Math.round((rows / ms) * 1000);
  console.log(bench.table());
  console.log(`Throughput: ${rowsPerSec} rows/s`);
} else {
  const t0 = Date.now();
  for (let i = 0; i < rows; i++) {
    // eslint-disable-next-line no-await-in-loop
    await db.insert('bench_items', { id: `b${i}`, name: `n${i}`, updatedAt: Date.now(), version: 1 });
  }
  await db.commit();
  const ms = Date.now() - t0;
  console.log(`Inserted ${rows} rows in ${ms}ms (${Math.round((rows / ms) * 1000)} rows/s)`);
}

