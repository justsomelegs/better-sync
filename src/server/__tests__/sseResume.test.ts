import { describe, it, expect } from 'vitest';
import { createSync } from '../../';

function makeDb() {
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert(_t: string, row: any) { return { id: 't1', ...row, updatedAt: Date.now(), version: 1 }; },
    async updateByPk() { return {}; }, async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; }
  } as const;
}

async function readUntilMutation(res: Response, timeoutMs = 3000) {
  const reader = res.body!.getReader();
  const td = new TextDecoder();
  const start = Date.now();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    const { value } = await reader.read();
    if (value) {
      buffer += td.decode(value);
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const f of parts) {
        if (f.includes('event: mutation')) return f;
      }
    }
  }
}

describe('SSE resume', () => {
  it('replays events after Last-Event-ID', async () => {
    const { fetch } = createSync({ schema: {}, database: makeDb() as any });
    // Subscribe and produce first mutation to capture its id
    const res1 = await fetch(new Request('http://test/events'));
    await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify({ op: 'insert', table: 't', rows: { a: 1 } }), headers: { 'Content-Type': 'application/json' } }));
    const first = await readUntilMutation(res1);
    const idLine = first.split('\n').find((l) => l.startsWith('id: ')) || '';
    const id = idLine.slice(4);

    // produce another event after
    await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify({ op: 'insert', table: 't', rows: { a: 2 } }), headers: { 'Content-Type': 'application/json' } }));

    // resubscribe with Last-Event-ID and expect at least one mutation frame (the second)
    const res2 = await fetch(new Request('http://test/events', { headers: { 'Last-Event-ID': id } } as any));
    const f2 = await readUntilMutation(res2);
    expect(f2).toContain('event: mutation');
  });
});
