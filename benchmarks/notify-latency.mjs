/**
 * Benchmark: notify-latency (client.watch)
 *
 * What it measures
 * - End-to-end latency from a mutation (client.insert) to the watcher notification callback firing on another client.
 * - Uses SSE realtime with immediate notify + debounced snapshot semantics to mirror default client behavior.
 *
 * Why we benchmark it
 * - This is the user-perceived “reactivity” metric for collaborative UI. Lower is better.
 *
 * Production relevance
 * - Numbers here are from a single-process, local loopback environment; real deployments add network RTT and proxying.
 * - Still useful for detecting regressions in client/server notify pipelines and debounce/resume correctness.
 *
 * Tuning
 * - BENCH_NOTIFY_ITER controls number of iterations (default 2000).
 * - BENCH_NOTIFY_TIMEOUT caps per-iteration wait time.
 */
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync, createClient, sqliteAdapter } from '../dist/index.mjs';
import { Bench } from 'tinybench';

const ITER = Number(process.env.BENCH_NOTIFY_ITER || 2000);
const TIMEOUT_MS = Number(process.env.BENCH_NOTIFY_TIMEOUT || 5000);
const dbFile = join(tmpdir(), `bench_notify_${Date.now()}.sqlite`);
const dbUrl = `file:${dbFile}`;
const JSON_MODE = process.env.BENCH_JSON === '1';

const db = sqliteAdapter({ url: dbUrl, flushMode: process.env.BENCH_FLUSH_MODE || 'sync' });
const schema = { bench_notes: { schema: z.object({ id: z.string().optional(), title: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } };

const sync = createSync({ schema, database: db, autoMigrate: true, sse: { keepaliveMs: 1000, bufferMs: 60000, bufferCap: 10000, payload: process.env.BENCH_SSE_PAYLOAD === 'minimal' ? 'minimal' : 'full' } });
const server = http.createServer(toNodeHandler(sync.handler));
await new Promise((r) => server.listen(0, r));
const addr = server.address();
if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
const baseURL = `http://127.0.0.1:${addr.port}`;

const clientA = createClient({ baseURL, realtime: 'sse' });
const clientB = createClient({ baseURL, realtime: 'sse' });

// Prime: initial snapshot and one seed insert
await clientA.insert('bench_notes', { title: 'seed' }).catch(() => {});
await clientA.select({ table: 'bench_notes', limit: 1 });
await clientB.select({ table: 'bench_notes', limit: 1 });
await new Promise((r) => setTimeout(r, 300));

let resolver = null;
const latencies = [];

const stop = clientB.watch({ table: 'bench_notes', limit: 1 }, (evt) => {
  if (evt && (evt.pks?.length || (Array.isArray(evt.data) && evt.data.length > 0))) {
    if (resolver) resolver();
  }
}, { initialSnapshot: false, debounceMs: 10 });

console.log(`Benchmarking notify latency over ${ITER} iterations (client.watch)...`);
const bench = new Bench({ iterations: ITER, warmupIterations: 0 });
bench.add('notify-latency', async () => {
  await new Promise((r) => setTimeout(r, 5));
  const start = Date.now();
  const p = new Promise((res, rej) => {
    resolver = res;
    setTimeout(() => rej(new Error('notify timeout')), TIMEOUT_MS);
  });
  await clientA.insert('bench_notes', { title: `n${Math.random().toString(36).slice(2)}` });
  try {
    await p;
    latencies.push(Date.now() - start);
  } catch (e) {
    // swallow to continue iterations
  } finally {
    resolver = null;
  }
});
const t0 = Date.now();
await bench.run();
stop();
const elapsedMs = Date.now() - t0;
if (JSON_MODE) {
  const summary = latencies.length > 0 ? {
    p50: percentile(latencies, 50),
    p90: percentile(latencies, 90),
    p99: percentile(latencies, 99),
    avg: average(latencies),
    ops: latencies.length / (elapsedMs / 1000)
  } : { p50: null, p90: null, p99: null, avg: null, ops: null };
  const out = { name: 'notify-latency', iterations: ITER, elapsedMs, node: process.version, adapter: 'sqlite(sql.js)', ...summary };
  console.log(JSON.stringify(out));
} else {
  console.table(bench.table());
}

await new Promise((r) => server.close(() => r()));

function percentile(arr, p) { if (arr.length === 0) return null; const sorted = [...arr].sort((a,b)=>a-b); const idx = Math.floor((p/100) * (sorted.length - 1)); return sorted[idx]; }
function average(arr) { if (arr.length === 0) return null; return Math.round(arr.reduce((a,b)=>a+b,0)/arr.length); }

