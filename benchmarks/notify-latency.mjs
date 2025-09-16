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
await bench.run();
stop();
console.table(bench.table());

await new Promise((r) => server.close(() => r()));

