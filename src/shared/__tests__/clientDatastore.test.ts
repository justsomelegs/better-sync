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

	it('select with where filters client-side across pages', async () => {
		const rows: any[] = [];
		const db = {
			async begin() {}, async commit() {}, async rollback() {},
			async insert(_t: string, row: any) { rows.push(row); return { ...row }; },
			async updateByPk() { return {}; }, async deleteByPk() { return { ok: true } }, async selectByPk() { return null; },
			async selectWindow(_t: string, req: any) {
				const ordered = rows.slice().sort((a,b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
				const limit = req.limit ?? 2; let start = 0;
				if (req.cursor) {
					const id = JSON.parse(Buffer.from(String(req.cursor), 'base64').toString('utf8')).last?.id;
					if (id) { const idx = ordered.findIndex(r => String(r.id) === String(id)); if (idx >= 0) start = idx + 1; }
				}
				const page = ordered.slice(start, start + limit);
				const nextCursor = (start + limit) < ordered.length ? Buffer.from(JSON.stringify({ last: { id: String(page[page.length-1]?.id ?? '') } }), 'utf8').toString('base64') : null;
				return { data: page, nextCursor };
			}
		} as any;
		const sync = createSync({ schema: {}, database: db });
		for (let i = 0; i < 5; i++) {
			await sync.fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { id: `t${i}`, title: i % 2 === 0 ? 'keep' : 'skip' } }) }));
		}
		const client = createClient({ baseURL: 'http://test', fetch: (input: any, init?: any) => sync.fetch(typeof input === 'string' ? new Request(input, init) : input) });
		const res = await client.todos.select({ where: (r: any) => r.title === 'keep', limit: 3 });
		expect(res.data.length).toBe(3);
	});
});
