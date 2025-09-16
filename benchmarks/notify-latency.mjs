import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync, createClient, sqliteAdapter } from '../dist/index.mjs';

const ITER = Number(process.env.BENCH_NOTIFY_ITER || 100);
const dbFile = join(tmpdir(), `bench_notify_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;

const db = sqliteAdapter({ url: dbUrl });
const schema = { bench_notes: { schema: z.object({ id: z.string().optional(), title: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } };

const sync = createSync({ schema, database: db, autoMigrate: true, sse: { keepaliveMs: 1000, bufferMs: 60000, bufferCap: 10000 } });
const server = http.createServer(toNodeHandler(sync.handler));
await new Promise((r) => server.listen(0, r));
const addr = server.address();
if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
const baseURL = `http://127.0.0.1:${addr.port}`;

const clientA = createClient({ baseURL, realtime: 'sse' });
const clientB = createClient({ baseURL, realtime: 'sse' });

// Prime server and create table with an initial insert
await clientA.insert('bench_notes', { title: 'seed' }).catch(() => {});
await clientA.select({ table: 'bench_notes', limit: 1 });
await clientB.select({ table: 'bench_notes', limit: 1 });
await new Promise((r) => setTimeout(r, 300));

let resolveEvt;
const latencies = [];

// Single watcher, resolves per-iteration promise
const stop = clientB.watch('bench_notes', (evt) => {
	if (evt && (evt.pks?.length || evt.changes || evt.change)) {
		if (resolveEvt) resolveEvt();
	}
});

console.log(`Benchmarking notify latency over ${ITER} iterations...`);
for (let i = 0; i < ITER; i++) {
	await new Promise((r) => setTimeout(r, 5));
	const t0 = process.hrtime.bigint();
	const p = new Promise((res) => (resolveEvt = res));
	await clientA.insert('bench_notes', { title: `n${i}` });
	await p;
	const t1 = process.hrtime.bigint();
	latencies.push(Number(t1 - t0) / 1e6);
}

stop();

latencies.sort((a, b) => a - b);
const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p95 = latencies[Math.floor(latencies.length * 0.95)];
const p99 = latencies[Math.floor(latencies.length * 0.99)];

console.log(`Notify latency (ms): avg=${avg.toFixed(2)} p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} p99=${p99.toFixed(2)}`);

await new Promise((r) => server.close(() => r()));

