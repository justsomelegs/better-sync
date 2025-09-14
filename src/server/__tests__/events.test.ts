import { describe, it, expect } from 'vitest';
import { createSync } from '../../';

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

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (chunk: string) => boolean, timeoutMs = 2000) {
  const td = new TextDecoder();
  const start = Date.now();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for SSE frame');
    const { value, done } = await reader.read();
    if (done) throw new Error('stream closed');
    buffer += td.decode(value);
    // split on double newline frames
    const frames = buffer.split('\n\n');
    // keep last partial in buffer
    buffer = frames.pop() || '';
    for (const f of frames) {
      if (predicate(f)) return f;
    }
  }
}

describe('SSE events', () => {
  it('emits a mutation event on insert', async () => {
    const db = makeDb();
    const { fetch } = createSync({ schema: {}, database: db as any });

    // Start SSE subscription
    const resEvents = await fetch(new Request('http://test/events'));
    expect(resEvents.headers.get('Content-Type')).toContain('text/event-stream');
    const reader = resEvents.body!.getReader();

    // Fire a mutation
    const body = { op: 'insert', table: 'todos', rows: { title: 'a' } } as any;
    const resMut = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    expect(resMut.status).toBe(200);

    // Wait for a mutation event frame
    const frame = await readUntil(reader, (f) => f.includes('event: mutation'));
    expect(frame).toContain('event: mutation');
    expect(frame).toContain('data:');
    expect(frame).toContain('eventId');
    expect(frame).toContain('txId');
    expect(frame).toContain('tables');
    expect(frame).toContain('rowVersions');
  });
});
