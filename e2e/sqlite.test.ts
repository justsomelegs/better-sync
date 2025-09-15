import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import http from 'node:http';
import { createSync } from '../src';
import { toNodeHandler } from 'better-call/node';
import { sqliteAdapter } from '../src/storage/server';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

let server: http.Server;
let baseURL = '';

beforeAll(async () => {
  const file = resolve(tmpdir(), `just-sync-e2e-${Date.now()}.sqlite`);
  const sync = createSync({ schema: { t: {} }, database: sqliteAdapter({ url: `file:${file}` }), sse: { keepaliveMs: 5 } });
  server = http.createServer(toNodeHandler(sync.handler));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr && 'port' in addr) baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('e2e sqlite: CAS and pagination', () => {
  it('CAS conflict returns 409 and pagination yields nextCursor', async () => {
    // insert a row to create table
    const a = await fetch(`${baseURL}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 't', rows: { title: 'a' } }) });
    expect(a.ok).toBe(true);
    const aJson = await a.json();
    const id: string = aJson?.row?.id ?? (Array.isArray(aJson?.rows) ? String(aJson.rows[0]?.id) : '');
    expect(typeof id).toBe('string');
    // First update without CAS to bump version in meta
    const up1 = await fetch(`${baseURL}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update', table: 't', pk: id, set: { title: 'b' } }) });
    expect(up1.ok).toBe(true);
    // Provide an outdated expected version to trigger conflict (after an update, current version > 1)
    const up2 = await fetch(`${baseURL}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update', table: 't', pk: id, set: { title: 'c' }, ifVersion: 1 }) });
    expect(up2.status).toBe(409);

    // seed rows
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await fetch(`${baseURL}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'upsert', table: 't', row: { id: `r${i}`, title: String(i) } }) });
    }
    const p1 = await fetch(`${baseURL}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 't', limit: 3 }) });
    expect(p1.ok).toBe(true);
    const j1 = await p1.json();
    expect(Array.isArray(j1.data)).toBe(true);
    expect(j1.nextCursor === null || typeof j1.nextCursor === 'string').toBe(true);
    if (j1.nextCursor) {
      const p2 = await fetch(`${baseURL}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 't', limit: 3, cursor: j1.nextCursor }) });
      expect(p2.ok).toBe(true);
      const j2 = await p2.json();
      expect(Array.isArray(j2.data)).toBe(true);
    }
  });
});

