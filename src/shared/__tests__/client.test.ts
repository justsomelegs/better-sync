import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import http from 'node:http';
import { createSync } from '../../';
import { createClient } from '../createClient';
import { toNodeHandler } from 'better-call/node';

function makeDb() {
  const rows: any[] = [];
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert(_t: string, row: any) { rows.push(row); return { ...row }; },
    async updateByPk(_t: string, _pk: any, set: any) { Object.assign(rows[0], set); return { ...rows[0] }; },
    async deleteByPk() { return { ok: true }; },
    async selectByPk() { return null; },
    async selectWindow(_t: string) { return { data: rows.slice(), nextCursor: null }; }
  } as const;
}

let server: http.Server;
let baseURL = '';

beforeAll(async () => {
  const sync = createSync({ schema: {}, database: makeDb() as any });
  server = http.createServer(toNodeHandler(sync.handler));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr && 'port' in addr) {
    baseURL = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error('failed to acquire port');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('client', () => {
  it('selects and watches mutations', async () => {
    const client = createClient({ baseURL });
    const sel0 = await client.select({ table: 'todos' });
    expect(sel0.data).toEqual([]);

    let changed = false;
    const stop = client.watch('todos', (evt) => {
      if (evt.pks && evt.pks.length) changed = true;
    });

    await client.insert('todos', { title: 'a' });

    // poll until watch flag set
    const start = Date.now();
    while (!changed) {
      if (Date.now() - start > 2000) throw new Error('timeout waiting watch');
      await new Promise((r) => setTimeout(r, 20));
    }
    stop();

    const sel1 = await client.select({ table: 'todos' });
    expect(sel1.data.length).toBe(1);
  });
});
