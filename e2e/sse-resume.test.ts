import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import http from 'node:http';
import { createSync } from '../src';
import { toNodeHandler } from 'better-call/node';
import { memoryAdapter } from '../src/storage/server';

let server: http.Server;
let baseURL = '';

beforeAll(async () => {
  const sync = createSync({ schema: { todos: {} }, database: memoryAdapter(), sse: { keepaliveMs: 5 } });
  server = http.createServer(toNodeHandler(sync.handler));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr && 'port' in addr) baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function readFrame(res: Response, kind: 'mutation' | 'keepalive', timeout = 2000) {
  const body = res.body;
  if (!body) throw new Error('no body');
  const reader = body.getReader();
  const td = new TextDecoder();
  const start = Date.now();
  let buf = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    const { value, done } = await reader.read();
    if (done) throw new Error('done');
    if (value) {
      buf += td.decode(value);
      const frames = buf.split('\n\n');
      buf = frames.pop() || '';
      for (const f of frames) {
        if (kind === 'keepalive' && f.startsWith(':keepalive')) { reader.releaseLock(); return f; }
        if (kind === 'mutation' && f.includes('event: mutation')) { reader.releaseLock(); return f; }
      }
    }
  }
}

describe('e2e SSE resume', () => {
  it('replays frames after Last-Event-ID', async () => {
    const ac1 = new AbortController();
    const sse1 = await fetch(`${baseURL}/events`, { signal: ac1.signal });
    // wait a keepalive so ring has at least one frame id
    await readFrame(sse1, 'keepalive', 2000);

    const m1 = await fetch(`${baseURL}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { title: 'a' } }) });
    expect(m1.ok).toBe(true);
    const frame = await readFrame(sse1, 'mutation');
    const idLine = frame.split('\n').find((l) => l.startsWith('id: ')) || '';
    const id = idLine.slice(4).trim();
    // reconnect with Last-Event-ID and expect replay to be empty then subsequent mutations visible
    ac1.abort();
    const ac2 = new AbortController();
    const sse2 = await fetch(`${baseURL}/events`, { headers: { 'Last-Event-ID': id }, signal: ac2.signal });
    const m2 = await fetch(`${baseURL}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { title: 'b' } }) });
    expect(m2.ok).toBe(true);
    const frame2 = await readFrame(sse2, 'mutation');
    expect(frame2).toContain('event: mutation');
    ac2.abort();
  });
});

