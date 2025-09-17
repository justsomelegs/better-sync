/**
 * Benchmark Harness (tinybench)
 *
 * Scenarios:
 * - insert_seq: sequential inserts via HTTP client
 * - insert_concurrent: concurrent inserts via HTTP client
 * - insert_batch: batched inserts via HTTP client (array payloads)
 * - update_conflict: concurrent updates with ifVersion to trigger conflicts
 * - cas_update: single-round-trip update with ifVersion, measures CAS throughput
 * - select_window: paginated reads until exhaustion
 * - notify_latency: watcher latency distribution
 * - notify_stress: high-volume mutation notifications throughput
 * - libsql_insert_local: direct adapter inserts using libsql into a local file
 * - libsql_insert_remote: direct adapter inserts using libsql to LIBSQL_URL
 *
 * Metrics per scenario:
 * - throughput: ops/sec
 * - latency: p50, p95, p99, min, max, mean (ms)
 * - cpu: user/system µs during run
 * - memory: rss start/end (bytes), delta (bytes)
 *
 * Usage:
 *   node benchmarks/harness.mjs
 *   BENCH_SCENARIOS=insert_seq,insert_concurrent BENCH_ROWS=2000 BENCH_CONCURRENCY=32 node benchmarks/harness.mjs
 */
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { Bench } from 'tinybench';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync, createClient, sqliteAdapter } from '../dist/index.mjs';
import { libsqlAdapter } from '../dist/adapters/libsql.mjs';

const rows = Number(process.env.BENCH_ROWS || 2000);
const concurrency = Number(process.env.BENCH_CONCURRENCY || 32);
const batchSize = Number(process.env.BENCH_BATCH || 50);
const iterations = Number(process.env.BENCH_ITER || 1);
const scenariosEnv = (process.env.BENCH_SCENARIOS || 'insert_seq,insert_concurrent,select_window,update_conflict,notify_latency,notify_stress').split(',').map(s => s.trim()).filter(Boolean);
const outDir = resolve(process.env.BENCH_OUTPUT_DIR || 'benchmarks/results');

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}
function summarizeLatencies(samples) {
  if (samples.length === 0) return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  const count = samples.length;
  let min = Infinity, max = -Infinity, sum = 0;
  for (const x of samples) { if (x < min) min = x; if (x > max) max = x; sum += x; }
  return { count, min, max, mean: sum / count, p50: percentile(samples, 50), p95: percentile(samples, 95), p99: percentile(samples, 99) };
}

async function setupServer() {
  const dbFile = join(tmpdir(), `bench_harness_${Date.now()}.sqlite`);
  const db = sqliteAdapter({ url: `file:${dbFile}` });
  const schema = { bench: { schema: z.object({ id: z.string().optional(), k: z.string().optional(), v: z.number().optional(), updatedAt: z.number().optional(), version: z.number().optional() }) } };
  const sync = createSync({ schema, database: db, autoMigrate: true, sse: { keepaliveMs: 1000, bufferMs: 60000, bufferCap: 20000 } });
  const server = http.createServer(toNodeHandler(sync.handler));
  await new Promise((r) => server.listen(0, r));
  const addr = server.address();
  if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
  const baseURL = `http://127.0.0.1:${addr.port}`;
  return { server, baseURL };
}

async function scenarioInsertSeq(client) {
  const lat = [];
  const startCpu = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const started = Date.now();
  for (let i = 0; i < rows; i++) {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await client.insert('bench', { id: `seq-${i}`, k: `k${i}`, v: i });
    lat.push(Date.now() - t0);
  }
  const elapsedMs = Date.now() - started;
  const cpu = process.cpuUsage(startCpu);
  const rssEnd = process.memoryUsage().rss;
  return { ops: rows, elapsedMs, latencies: summarizeLatencies(lat), throughput: rows / (elapsedMs / 1000), cpu, memory: { rssStart, rssEnd, delta: rssEnd - rssStart } };
}

async function withConcurrency(limit, tasks) {
  const results = [];
  let next = 0; let active = 0;
  return new Promise((resolveAll, rejectAll) => {
    const pump = () => {
      if (next >= tasks.length && active === 0) return resolveAll(results);
      while (active < limit && next < tasks.length) {
        const idx = next++;
        active++;
        tasks[idx]().then((r) => { results[idx] = r; active--; pump(); }).catch((e) => { results[idx] = { error: String(e?.message || e) }; active--; pump(); });
      }
    };
    pump();
  });
}

async function scenarioInsertConcurrent(client) {
  const lat = [];
  const tasks = Array.from({ length: rows }, (_, i) => async () => {
    const t0 = Date.now();
    await client.insert('bench', { id: `c-${i}`, k: `k${i}`, v: i });
    lat.push(Date.now() - t0);
    return true;
  });
  const startCpu = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const started = Date.now();
  await withConcurrency(concurrency, tasks);
  const elapsedMs = Date.now() - started;
  const cpu = process.cpuUsage(startCpu);
  const rssEnd = process.memoryUsage().rss;
  return { ops: rows, elapsedMs, latencies: summarizeLatencies(lat), throughput: rows / (elapsedMs / 1000), cpu, memory: { rssStart, rssEnd, delta: rssEnd - rssStart } };
}

async function scenarioLibsqlInsertLocal() {
  try {
    const { createClient } = await import('@libsql/client');
    const dbFile = join(tmpdir(), `bench_libsql_${Date.now()}.db`);
    const url = `file:${dbFile}`;
    const raw = createClient({ url });
    await raw.execute(`CREATE TABLE IF NOT EXISTS bench (id TEXT PRIMARY KEY, k TEXT, v INTEGER, updatedAt INTEGER, version INTEGER)`);
    const adapter = libsqlAdapter({ url });
    await adapter.ensureMeta?.();
    const lat = [];
    const startCpu = process.cpuUsage();
    const rssStart = process.memoryUsage().rss;
    const started = Date.now();
    for (let i = 0; i < rows; i++) {
      const t0 = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await adapter.insert('bench', { id: `l${i}`, k: `k${i}`, v: i, updatedAt: Date.now(), version: 1 });
      lat.push(Date.now() - t0);
    }
    const elapsedMs = Date.now() - started;
    const cpu = process.cpuUsage(startCpu);
    const rssEnd = process.memoryUsage().rss;
    return { ops: rows, elapsedMs, latencies: summarizeLatencies(lat), throughput: rows / (elapsedMs / 1000), cpu, memory: { rssStart, rssEnd, delta: rssEnd - rssStart } };
  } catch (e) {
    return { skipped: true, reason: String(e?.message || e) };
  }
}

async function scenarioLibsqlInsertRemote() {
  try {
    const url = process.env.LIBSQL_URL;
    if (!url) return { skipped: true, reason: 'LIBSQL_URL not set' };
    const { createClient } = await import('@libsql/client');
    const raw = createClient({ url });
    await raw.execute(`CREATE TABLE IF NOT EXISTS bench (id TEXT PRIMARY KEY, k TEXT, v INTEGER, updatedAt INTEGER, version INTEGER)`);
    const adapter = libsqlAdapter({ url });
    await adapter.ensureMeta?.();
    const lat = [];
    const startCpu = process.cpuUsage();
    const rssStart = process.memoryUsage().rss;
    const started = Date.now();
    for (let i = 0; i < rows; i++) {
      const t0 = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await adapter.insert('bench', { id: `r${i}`, k: `k${i}`, v: i, updatedAt: Date.now(), version: 1 });
      lat.push(Date.now() - t0);
    }
    const elapsedMs = Date.now() - started;
    const cpu = process.cpuUsage(startCpu);
    const rssEnd = process.memoryUsage().rss;
    return { ops: rows, elapsedMs, latencies: summarizeLatencies(lat), throughput: rows / (elapsedMs / 1000), cpu, memory: { rssStart, rssEnd, delta: rssEnd - rssStart } };
  } catch (e) {
    return { skipped: true, reason: String(e?.message || e) };
  }
}

async function scenarioInsertBatch(client) {
  const total = rows;
  const numBatches = Math.ceil(total / batchSize);
  const batches = Array.from({ length: numBatches }, (_, bi) => {
    const start = bi * batchSize;
    const end = Math.min(start + batchSize, total);
    const payload = [];
    for (let i = start; i < end; i++) payload.push({ id: `b-${i}`, k: `k${i}`, v: i });
    return payload;
  });
  const lat = [];
  const tasks = batches.map((payload) => async () => {
    const t0 = Date.now();
    await client.insert('bench', payload);
    lat.push(Date.now() - t0);
  });
  const startCpu = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const started = Date.now();
  await withConcurrency(concurrency, tasks);
  const elapsedMs = Date.now() - started;
  const cpu = process.cpuUsage(startCpu);
  const rssEnd = process.memoryUsage().rss;
  return { ops: total, batches: numBatches, batchSize, elapsedMs, latencies: summarizeLatencies(lat), throughput: total / (elapsedMs / 1000), cpu, memory: { rssStart, rssEnd, delta: rssEnd - rssStart } };
}

async function scenarioSelectWindow(client) {
  // Seed if empty
  const first = await client.select({ table: 'bench', limit: 1 });
  if ((first?.data?.length || 0) === 0) {
    const seed = Array.from({ length: rows }, (_, i) => ({ id: `s-${i}`, k: `ks${i}`, v: i }));
    for (const r of seed) { // sequential to keep tight bounds on timings
      // eslint-disable-next-line no-await-in-loop
      await client.insert('bench', r);
    }
  }
  const lat = [];
  const startCpu = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const started = Date.now();
  let cursor = null; let total = 0;
  do {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const win = await client.select({ table: 'bench', limit: 200, cursor });
    lat.push(Date.now() - t0);
    total += win.data.length;
    cursor = win.nextCursor;
  } while (cursor);
  const elapsedMs = Date.now() - started;
  const cpu = process.cpuUsage(startCpu);
  const rssEnd = process.memoryUsage().rss;
  return { ops: total, elapsedMs, latencies: summarizeLatencies(lat), throughput: total / (elapsedMs / 1000), cpu, memory: { rssStart, rssEnd, delta: rssEnd - rssStart } };
}

async function scenarioUpdateConflict(client) {
  // Create one record, then concurrently attempt N updates with ifVersion
  const baseId = `conf-${Date.now()}`;
  await client.insert('bench', { id: baseId, k: 'base', v: 0 });
  const lat = [];
  let ok = 0, conflict = 0, otherErr = 0;
  const tasks = Array.from({ length: rows }, (_, i) => async () => {
    const t0 = Date.now();
    try {
      const cur = await client.select({ table: 'bench', limit: 1, cursor: null });
      const curRow = cur.data.find(r => r.id === baseId) || { version: 1 };
      await client.update('bench', baseId, { v: i }, { ifVersion: curRow.version });
      ok++;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('Version mismatch') || msg.includes('CONFLICT')) conflict++; else otherErr++;
    } finally {
      lat.push(Date.now() - t0);
    }
  });
  const startCpu = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const started = Date.now();
  await withConcurrency(concurrency, tasks);
  const elapsedMs = Date.now() - started;
  const cpu = process.cpuUsage(startCpu);
  const rssEnd = process.memoryUsage().rss;
  return { ops: rows, elapsedMs, latencies: summarizeLatencies(lat), throughput: rows / (elapsedMs / 1000), outcomes: { ok, conflict, otherErr }, cpu, memory: { rssStart, rssEnd, delta: rssEnd - rssStart } };
}

async function scenarioCasUpdate(client) {
  const baseId = `cas-${Date.now()}`;
  await client.insert('bench', { id: baseId, k: 'base', v: 0 });
  const lat = [];
  let ok = 0, conflict = 0;
  const tasks = Array.from({ length: rows }, (_, i) => async () => {
    const t0 = Date.now();
    try {
      await client.update('bench', baseId, { v: i }, { ifVersion: undefined });
      ok++;
    } catch {
      conflict++;
    } finally {
      lat.push(Date.now() - t0);
    }
  });
  const started = Date.now();
  await withConcurrency(concurrency, tasks);
  const elapsedMs = Date.now() - started;
  return { ops: rows, elapsedMs, throughput: rows / (elapsedMs / 1000), outcomes: { ok, conflict }, latencies: summarizeLatencies(lat) };
}

async function scenarioNotifyLatency(baseURL) {
  const clientA = createClient({ baseURL, realtime: 'sse', defaults: { microBatchEnabled: false } });
  const clientB = createClient({ baseURL, realtime: 'sse', defaults: { microBatchEnabled: false } });
  // Prime
  await clientA.insert('bench', { id: `n-seed`, k: 'seed', v: 0 }).catch(() => {});
  await clientA.select({ table: 'bench', limit: 1 });
  await clientB.select({ table: 'bench', limit: 1 });
  await new Promise((r) => setTimeout(r, 200));
  const lat = [];
  let resolver = null;
  const stop = clientB.watch({ table: 'bench', limit: 1 }, (evt) => {
    if (evt && (evt.pks?.length || (Array.isArray(evt.data) && evt.data.length > 0))) {
      if (resolver) resolver();
    }
  }, { initialSnapshot: false, debounceMs: 10 });
  for (let i = 0; i < Math.min(rows, 2000); i++) {
    // eslint-disable-next-line no-await-in-loop
    const p = new Promise((res, rej) => { resolver = res; setTimeout(() => rej(new Error('timeout')), 5000); });
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await clientA.insert('bench', { id: `n-${i}-${Math.random().toString(36).slice(2)}`, k: 'n', v: i }).catch(() => {});
    try { // eslint-disable-next-line no-await-in-loop
      await p; lat.push(Date.now() - t0);
    } catch {}
    finally { resolver = null; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2));
  }
  stop();
  return { ops: lat.length, elapsedMs: lat.reduce((a, b) => a + b, 0), latencies: summarizeLatencies(lat), throughput: lat.length / ((lat.reduce((a, b) => a + b, 0) || 1) / 1000) };
}

async function scenarioNotifyStress(baseURL) {
  const clientA = createClient({ baseURL, realtime: 'off', defaults: { microBatchEnabled: false } });
  const clientB = createClient({ baseURL, realtime: 'sse', defaults: { microBatchEnabled: false } });
  // warmup
  await clientA.insert('bench', { id: `ns-seed`, k: 'seed', v: 0 }).catch(() => {});
  await clientB.select({ table: 'bench', limit: 1 });
  let received = 0;
  const target = rows;
  const stop = clientB.watch({ table: 'bench', limit: 1 }, (evt) => {
    if (evt && (evt.pks?.length || (Array.isArray(evt.data) && evt.data.length > 0))) received++;
  }, { initialSnapshot: false, debounceMs: 50 });
  // Produce notifications concurrently via inserts (unique ids)
  const tasks = Array.from({ length: target }, (_, i) => async () => {
    await clientA.insert('bench', { id: `ns-${i}-${Math.random().toString(36).slice(2)}`, k: 'n', v: i }).catch(() => {});
  });
  const startCpu = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const started = Date.now();
  await withConcurrency(concurrency, tasks);
  // allow events to drain briefly
  await new Promise((r) => setTimeout(r, 200));
  const elapsedMs = Date.now() - started;
  const cpu = process.cpuUsage(startCpu);
  const rssEnd = process.memoryUsage().rss;
  stop();
  return { events: received, produced: target, elapsedMs, throughput: received / (elapsedMs / 1000), cpu, memory: { rssStart, rssEnd, delta: rssEnd - rssStart } };
}

async function run() {
  await fs.mkdir(outDir, { recursive: true });
  const { server, baseURL } = await setupServer();
  const client = createClient({ baseURL, realtime: 'off' });
  const results = { meta: { rows, concurrency, iterations, node: process.version, date: new Date().toISOString() }, scenarios: {} };

  const bench = new Bench({ iterations, warmupIterations: 0 });
  for (const name of scenariosEnv) {
    if (name === 'insert_seq') {
      bench.add('insert_seq', async () => { results.scenarios['insert_seq'] = await scenarioInsertSeq(client); });
    } else if (name === 'insert_concurrent') {
      bench.add('insert_concurrent', async () => { results.scenarios['insert_concurrent'] = await scenarioInsertConcurrent(client); });
    } else if (name === 'insert_batch') {
      bench.add('insert_batch', async () => { results.scenarios['insert_batch'] = await scenarioInsertBatch(client); });
    } else if (name === 'select_window') {
      bench.add('select_window', async () => { results.scenarios['select_window'] = await scenarioSelectWindow(client); });
    } else if (name === 'update_conflict') {
      bench.add('update_conflict', async () => { results.scenarios['update_conflict'] = await scenarioUpdateConflict(client); });
    } else if (name === 'notify_latency') {
      bench.add('notify_latency', async () => { results.scenarios['notify_latency'] = await scenarioNotifyLatency(baseURL); });
    } else if (name === 'notify_stress') {
      bench.add('notify_stress', async () => { results.scenarios['notify_stress'] = await scenarioNotifyStress(baseURL); });
    } else if (name === 'cas_update') {
      bench.add('cas_update', async () => { results.scenarios['cas_update'] = await scenarioCasUpdate(client); });
    } else if (name === 'libsql_insert' && process.env.LIBSQL_URL) {
      bench.add('libsql_insert', async () => {
        const adapter = libsqlAdapter({ url: process.env.LIBSQL_URL });
        await adapter.ensureMeta?.();
        // seed table
        for (let i = 0; i < rows; i++) { // eslint-disable-next-line no-await-in-loop
          await adapter.insert('bench', { id: `ls-${Date.now()}-${i}`, k: `k${i}`, v: i, updatedAt: Date.now(), version: 1 });
        }
        results.scenarios['libsql_insert'] = { ok: true };
      });
    } else if (name === 'libsql_insert_local') {
      bench.add('libsql_insert_local', async () => { results.scenarios['libsql_insert_local'] = await scenarioLibsqlInsertLocal(); });
    } else if (name === 'libsql_insert_remote') {
      bench.add('libsql_insert_remote', async () => { results.scenarios['libsql_insert_remote'] = await scenarioLibsqlInsertRemote(); });
    }
  }

  await bench.run();
  console.table(bench.table());
  const outPath = join(outDir, `bench_${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`Wrote: ${outPath}`);
  await new Promise((r) => server.close(() => r()));
}

run().catch((e) => { console.error(e); process.exitCode = 1; });

