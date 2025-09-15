import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createSync } from '../../';
import { toNodeHandler } from 'better-call/node';

function makeDb() {
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert(_table: string, row: Record<string, any>) { return { ...row }; },
    async updateByPk(_t: string, _pk: any, set: Record<string, any>) { return { ...set }; },
    async deleteByPk() { return { ok: true }; },
    async selectByPk() { return null; },
    async selectWindow() { return { data: [], nextCursor: null }; }
  } as const;
}

let server: http.Server;
let baseURL: string;

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

async function readUntilEvent(res: Response, timeoutMs = 3000) {
  const reader = res.body!.getReader();
  const td = new TextDecoder();
  const start = Date.now();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    const { value, done } = await reader.read();
    if (done) throw new Error('done');
    if (value) {
      buffer += td.decode(value);
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const f of frames) {
        if (f.includes('event: mutation')) return f;
      }
    }
  }
}

describe('E2E over HTTP', () => {
  it('serves SSE and emits on mutation', async () => {
    const ac = new AbortController();
    const sseRes = await fetch(`${baseURL}/events`, { signal: ac.signal });
    expect(sseRes.ok).toBe(true);
    expect(sseRes.headers.get('Content-Type')).toContain('text/event-stream');

    const mutateRes = await fetch(`${baseURL}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'insert', table: 'todos', rows: { title: 'y' } })
    });
    expect(mutateRes.ok).toBe(true);

    const frame = await readUntilEvent(sseRes);
    expect(frame).toContain('event: mutation');
    ac.abort();
  });

  it('select endpoint responds', async () => {
    const res = await fetch(`${baseURL}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'todos' })
    });
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json).toEqual({ data: [], nextCursor: null });
  });

	it('calls mutator over HTTP end-to-end', async () => {
		const sync = createSync({ schema: {}, database: makeDb() as any, mutators: {
			add: { args: undefined, handler: async (_ctx: any, a: { x: number; y: number }) => (a.x + a.y) }
		}});
		const server2 = http.createServer(toNodeHandler(sync.handler));
		await new Promise<void>((resolve) => server2.listen(0, resolve));
		const addr = server2.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port');
		const url = `http://127.0.0.1:${addr.port}`;
		const res = await fetch(`${url}/mutators/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: { x: 2, y: 3 } }) });
		expect(res.ok).toBe(true);
		const json = await res.json();
		expect(json.result).toBe(5);
		await new Promise<void>((resolve) => server2.close(() => resolve()));
	});

	it('sqlite persistence with SSE resume and cursor pagination', async () => {
		const dbFile = join(tmpdir(), `just_sync_test_${Date.now()}.sqlite`);
		const dbUrl = `file:${dbFile}`;
		const { sqliteAdapter } = await import('../../storage/server');
		const schema = { todos: { schema: { parse: (v: any) => v } as any } };
		// First server lifecycle: insert some rows
		let sync1 = createSync({ schema, database: sqliteAdapter({ url: dbUrl }) as any });
		let server1 = http.createServer(toNodeHandler(sync1.handler));
		await new Promise<void>((resolve) => server1.listen(0, resolve));
		let addr = server1.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port1');
		let base = `http://127.0.0.1:${addr.port}`;
		for (let i = 0; i < 5; i++) {
			const res = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { id: `t${i}`, title: `t${i}` } }) });
			expect(res.ok).toBe(true);
		}
		await new Promise<void>((resolve) => server1.close(() => resolve()));
		// Second server lifecycle: ensure rows persisted and SSE resume works
		let sync2 = createSync({ schema, database: sqliteAdapter({ url: dbUrl }) as any });
		let server2 = http.createServer(toNodeHandler(sync2.handler));
		await new Promise<void>((resolve) => server2.listen(0, resolve));
		addr = server2.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port2');
		base = `http://127.0.0.1:${addr.port}`;
		// verify pagination
		let res1 = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 3 }) });
		let j1 = await res1.json();
		expect(j1.data.length).toBe(3);
		expect(typeof j1.nextCursor === 'string' || j1.nextCursor === null).toBe(true);
		if (j1.nextCursor) {
			const res2 = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 3, cursor: j1.nextCursor }) });
			const j2 = await res2.json();
			expect(j2.data.length).toBeGreaterThan(0);
		}
		// SSE resume
		const ac2 = new AbortController();
		const sub = await fetch(`${base}/events`, { signal: ac2.signal });
		let firstEventId: string | null = null;
		// trigger a mutation
		await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { title: 'later' } }) });
		const frame = await readUntilEvent(sub, 5000);
		const idLine = frame.split('\n').find((l) => l.startsWith('id: ')) || '';
		firstEventId = idLine.slice(4).trim();
		ac2.abort();
		// reconnect (use Last-Event-ID if available) and expect stream to stay open
		const resumed = firstEventId
			? await fetch(`${base}/events`, { headers: { 'Last-Event-ID': firstEventId } })
			: await fetch(`${base}/events`);
		expect(resumed.ok).toBe(true);
		await new Promise<void>((resolve) => server2.close(() => resolve()));
	});
});
