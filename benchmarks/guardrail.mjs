#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const RESULTS_DIR = resolve('benchmarks/results');
const SCENARIOS = process.env.GUARD_SCENARIOS || 'insert_batch,notify_latency,notify_stress';
const ROWS = process.env.GUARD_ROWS || '2000';
const CONC = process.env.GUARD_CONCURRENCY || '32';
const BATCH = process.env.GUARD_BATCH || '50';

function listResultFilesSync(entries) {
  return entries
    .filter((e) => e.name.startsWith('bench_') && e.name.endsWith('.json'))
    .map((e) => ({ name: e.name, mtime: e.mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map((x) => x.name);
}

async function readLatestPair() {
  try {
    const entries = await fs.readdir(RESULTS_DIR, { withFileTypes: true });
    const stats = await Promise.all(entries.map(async (e) => ({ name: e.name, ...(await fs.stat(join(RESULTS_DIR, e.name))) })));
    const files = listResultFilesSync(stats);
    const latest = files.at(-1) ? join(RESULTS_DIR, files.at(-1)) : null;
    const prev = files.at(-2) ? join(RESULTS_DIR, files.at(-2)) : null;
    return { latest, prev };
  } catch {
    return { latest: null, prev: null };
  }
}

async function runHarness() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['benchmarks/harness.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, BENCH_SCENARIOS: SCENARIOS, BENCH_ROWS: ROWS, BENCH_CONCURRENCY: CONC, BENCH_BATCH: BATCH }
    });
    child.on('exit', (code) => { if (code === 0) resolveRun(); else rejectRun(new Error(`harness exited ${code}`)); });
    child.on('error', rejectRun);
  });
}

function get(obj, path, dflt) {
  try {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) cur = cur?.[p];
    return cur ?? dflt;
  } catch { return dflt; }
}

function percentChange(newV, oldV) {
  if (!oldV || !isFinite(oldV)) return 0;
  return (newV - oldV) / oldV;
}

async function main() {
  const before = await readLatestPair();
  await runHarness();
  const after = await readLatestPair();
  if (!after.latest) {
    console.log('No results found after run. Nothing to compare.');
    return;
  }
  const latestJson = JSON.parse(await fs.readFile(after.latest, 'utf8'));
  const baselinePath = before.latest && before.latest !== after.latest ? before.latest : after.prev;
  if (!baselinePath) {
    console.log('No baseline found. Treating current results as baseline.');
    return;
  }
  const baselineJson = JSON.parse(await fs.readFile(baselinePath, 'utf8'));

  const checks = [];
  // insert_batch throughput should not drop >10%
  checks.push({
    name: 'insert_batch throughput',
    newV: get(latestJson, 'scenarios.insert_batch.throughput', null),
    oldV: get(baselineJson, 'scenarios.insert_batch.throughput', null),
    cmp: (n, o) => percentChange(n, o) >= -0.10,
    msg: (n, o) => `insert_batch throughput drop ${(percentChange(n, o) * 100).toFixed(1)}%`
  });
  // notify_stress throughput should not drop >10%
  checks.push({
    name: 'notify_stress throughput',
    newV: get(latestJson, 'scenarios.notify_stress.throughput', null),
    oldV: get(baselineJson, 'scenarios.notify_stress.throughput', null),
    cmp: (n, o) => percentChange(n, o) >= -0.10,
    msg: (n, o) => `notify_stress throughput drop ${(percentChange(n, o) * 100).toFixed(1)}%`
  });
  // notify_latency p95 should not increase >20%
  checks.push({
    name: 'notify_latency p95',
    newV: get(latestJson, 'scenarios.notify_latency.latencies.p95', null),
    oldV: get(baselineJson, 'scenarios.notify_latency.latencies.p95', null),
    cmp: (n, o) => percentChange(o, n) >= -0.20, // inverted: lower is better
    msg: (n, o) => `notify_latency p95 increase ${(percentChange(n, o) * 100).toFixed(1)}%`
  });

  const failures = [];
  for (const c of checks) {
    if (c.newV == null || c.oldV == null) continue; // skip if missing
    const pass = c.cmp(Number(c.newV), Number(c.oldV));
    console.log(`${c.name}: new=${c.newV} old=${c.oldV} ${pass ? 'OK' : 'FAIL'}`);
    if (!pass) failures.push(c.msg(Number(c.newV), Number(c.oldV)));
  }

  if (failures.length > 0) {
    console.error('Perf guardrail failures:');
    for (const f of failures) console.error('- ' + f);
    process.exitCode = 1;
  } else {
    console.log('Perf guardrails OK.');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

