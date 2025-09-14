import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import http from 'node:http';
import { createSync } from '../../';
import { createClient } from '../createClient';
import { toNodeHandler } from 'better-call/node';
import { memory } from '../../storage/client';

function makeDb() {
  let conflict = false;
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert(_t: string, row: any) { return { ...row, version: (row.version ?? 0) + 1 }; },
    async updateByPk(_t: string, _pk: any, _set: any) {
      if (!conflict) return { id: _pk, version: 2, updatedAt: Date.now() };
      const err: any = new Error('conflict'); err.code = 'CONFLICT'; throw err;
    },
    async deleteByPk() { return { ok: true }; },
    async selectByPk() { return null; },
    async selectWindow() { return { data: [], nextCursor: null }; },
    _setConflict(v: boolean) { conflict = v; }
  } as any;
}

let server: http.Server;
let baseURL = '';
let db: any;

beforeAll(async () => {
  db = makeDb();
  const sync = createSync({ schema: {}, database: db });
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

describe('client datastore', () => {
  it('uses local datastore for reads and rolls back on conflict', async () => {
    const ds = memory();
    const client = createClient({ baseURL, datastore: ds });

    await client.insert('todos', { id: 'x', title: 'x' });
    const local = await client.local.readByPk('todos', 'x');
    expect(local?.id).toBe('x');

    db._setConflict(true);
    await expect(client.update('todos', 'x', { title: 'y' })).rejects.toBeInstanceOf(Error);
    const after = await client.local.readByPk('todos', 'x');
    expect(after?.title).toBe('x');
  });
});
