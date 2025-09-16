import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync, createClient } from '../dist/index.mjs';
import { sqliteAdapter } from '../dist/server.mjs';
import { Bench } from 'tinybench';

const rows = Number(process.env.BENCH_ROWS || 2000);
const dbFile = process.env.BENCH_FILE || join(tmpdir(), `bench_sqlite_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;

const db = sqliteAdapter({ url: dbUrl });
await db.ensureMeta?.();
const schema = { bench_items: { schema: z.object({ id: z.string().optional(), name: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } };
const sync = createSync({ schema, database: db, autoMigrate: true });
const server = http.createServer(toNodeHandler(sync.handler));
await new Promise((r) => server.listen(0, r));
const addr = server.address();
if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
const base = `http://127.0.0.1:${addr.port}`;
const client = createClient({ baseURL: base, realtime: 'off' });

console.log(`Inserting ${rows} rows via client into ${dbUrl}...`);
const bench = new Bench({ iterations: 1, warmupIterations: 0 });
let run = 0;
bench.add('client-insert', async () => {
	const runId = run++;
	for (let i = 0; i < rows; i++) {
		// eslint-disable-next-line no-await-in-loop
		await client.insert('bench_items', { id: `b${runId}-${i}`, name: `n${runId}-${i}` });
	}
});
await bench.run();
console.table(bench.table());
await new Promise((r) => server.close(() => r()))

