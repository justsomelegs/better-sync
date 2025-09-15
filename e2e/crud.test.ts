import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import http from 'node:http';
import { createSync, createClient } from '../src';
import { toNodeHandler } from 'better-call/node';
import { memoryAdapter } from '../src/storage/server';

let server: http.Server;
let baseURL = '';

beforeAll(async () => {
  const sync = createSync({ schema: { todos: {} }, database: memoryAdapter() });
  server = http.createServer(toNodeHandler(sync.handler));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr && 'port' in addr) baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('e2e CRUD and watch (memory adapter)', () => {
  it('insert, select, update, delete and watch signals', async () => {
    const client = createClient({ baseURL });

    const changes: Array<{ table: string; pks?: any[] }> = [];
    const un = client.todos.watch((e) => changes.push({ table: e.table, pks: e.pks }));

    const ins = await client.todos.insert({ title: 'a' });
    expect(ins).toBeTruthy();

    const s1 = await client.todos.select({});
    expect(Array.isArray(s1.data)).toBe(true);
    expect(s1.data.length).toBe(1);
    const id = s1.data[0].id;

    const up = await client.todos.update(id, { title: 'b' });
    expect(up).toBeTruthy();

    const del = await client.todos.delete(id);
    expect(del.ok).toBe(true);

    // give watch a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(changes.length).toBeGreaterThan(0);
    un();
  });
});

