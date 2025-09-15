import { beforeAll, afterAll, describe, it, expect } from 'vitest';
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
});
