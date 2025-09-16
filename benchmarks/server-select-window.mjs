import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync } from '../dist/index.mjs';
import { sqliteAdapter } from '../dist/server.mjs';

const rows = Number(process.env.BENCH_ROWS || 2000);
const dbFile = process.env.BENCH_FILE || join(tmpdir(), `bench_select_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;
const db = sqliteAdapter({ url: dbUrl });
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

console.log(`E2E /select window over ${rows} rows...`);
const t0 = Date.now();
let total = 0;
let cursor = null;

do {
	const res = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'bench_items', limit: 200, cursor }) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const json = await res.json();
	total += json.data.length;
	cursor = json.nextCursor;
} while (cursor);

const ms = Date.now() - t0;
console.log(`Selected ${total} rows via HTTP in ${ms}ms (${Math.round((total / ms) * 1000)} rows/s)`);
await new Promise((r) => server.close(() => r()))

