import { describe, it, expect } from 'vitest';
import { createSync } from '../../';

function makeDb() {
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert(_t: string, row: any) { return { ...row }; },
    async updateByPk(_t: string, _pk: any, set: any) { return { ...set }; },
    async deleteByPk() { return { ok: true }; },
    async selectByPk() { return null; },
    async selectWindow() { return { data: [], nextCursor: null }; }
  } as const;
}

async function readKeepalive(res: Response, timeoutMs = 1200) {
  const reader = res.body!.getReader();
  const td = new TextDecoder();
  const start = Date.now();
  let buffer = '';
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting keepalive');
    const { value, done } = await reader.read();
    if (done) throw new Error('closed');
    buffer += td.decode(value);
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const f of frames) {
      if (f.trim() === ':keepalive') return true;
    }
  }
}

describe('SSE keepalive', () => {
  it('sends keepalive at configured interval', async () => {
    const { fetch } = createSync({ schema: {}, database: makeDb() as any, sse: { keepaliveMs: 200 } });
    const res = await fetch(new Request('http://test/events'));
    expect(res.ok).toBe(true);
    const ok = await readKeepalive(res, 1000);
    expect(ok).toBe(true);
  });
});
