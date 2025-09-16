import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteAdapter } from '../dist/server.mjs';

const rows = Number(process.env.BENCH_ROWS || 2000);
const dbFile = process.env.BENCH_FILE || join(tmpdir(), `bench_sqlite_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;

const db = sqliteAdapter({ url: dbUrl });
await db.ensureMeta?.();

await db.begin();
console.log(`Inserting ${rows} rows into ${dbUrl}...`);
const t0 = Date.now();
for (let i = 0; i < rows; i++) {
	await db.insert('bench_items', { id: `b${i}`, name: `n${i}`, updatedAt: Date.now(), version: 1 });
}
await db.commit();
const ms = Date.now() - t0;
console.log(`Inserted ${rows} rows in ${ms}ms (${Math.round((rows / ms) * 1000)} rows/s)`);

