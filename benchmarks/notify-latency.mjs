import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync, sqliteAdapter } from '../dist/index.mjs';

const ITER = Number(process.env.BENCH_NOTIFY_ITER || 100);
const TIMEOUT_MS = Number(process.env.BENCH_NOTIFY_TIMEOUT || 5000);
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

// Seed table by calling HTTP mutate directly
await fetch(`${baseURL}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'bench_notes', rows: { id: 'seed', title: 'seed' } }) }).catch(() => {});

// Create SSE connection to /events
const res = await fetch(`${baseURL}/events`);
if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
const reader = res.body.getReader();

let resolveEvt;
let sinceId = undefined;
const latencies = [];

async function waitForMutation(tableName, deadline) {
	const decoder = new TextDecoder();
	let buffer = '';
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) throw new Error('SSE stream closed');
		buffer += decoder.decode(value, { stream: true });
		let idx;
		while ((idx = buffer.indexOf('\n\n')) !== -1) {
			const frame = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			if (frame.startsWith('id: ')) {
				const lines = frame.split('\n');
				let idLine = lines.find((l) => l.startsWith('id: '));
				let dataLine = lines.find((l) => l.startsWith('data: '));
				if (idLine && dataLine) {
					const eventId = idLine.slice(4).trim();
					const payload = JSON.parse(dataLine.slice(6));
					sinceId = eventId;
					if (payload?.tables && Array.isArray(payload.tables)) {
						const hit = payload.tables.find((t) => t?.name === tableName);
						if (hit) return;
					}
				}
			}
		}
	}
	throw new Error('notify timeout');
}

console.log(`Benchmarking notify latency over ${ITER} iterations (SSE direct)...`);
for (let i = 0; i < ITER; i++) {
	await new Promise((r) => setTimeout(r, 5));
	const t0 = process.hrtime.bigint();
	const deadline = Date.now() + TIMEOUT_MS;
	// trigger mutation
	const req = fetch(`${baseURL}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'bench_notes', rows: { title: `n${i}` } }) });
	try {
		await waitForMutation('bench_notes', deadline);
		const t1 = process.hrtime.bigint();
		latencies.push(Number(t1 - t0) / 1e6);
	} catch (e) {
		console.warn(`Iteration ${i} timed out waiting for notification`);
	}
}

if (latencies.length > 0) {
	latencies.sort((a, b) => a - b);
	const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
	const p50 = latencies[Math.floor(latencies.length * 0.5)];
	const p95 = latencies[Math.floor(latencies.length * 0.95)];
	const p99 = latencies[Math.floor(latencies.length * 0.99)];
	console.log(`Notify latency (ms): avg=${avg.toFixed(2)} p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} p99=${p99.toFixed(2)} over ${latencies.length}/${ITER} successes`);
} else {
	console.log('No successful notification measurements collected');
}

await new Promise((r) => server.close(() => r()));

