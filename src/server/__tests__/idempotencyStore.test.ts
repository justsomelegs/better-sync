import { describe, it, expect } from 'vitest';
import { createSync, createMemoryIdempotencyStore } from '../../';

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

class CountingStore implements ReturnType<typeof createMemoryIdempotencyStore> {
  private inner = createMemoryIdempotencyStore<any>();
  public hits = 0;
  has(key: string) { this.hits++; return this.inner.has(key); }
  get(key: string) { return this.inner.get(key); }
  set(key: string, value: any) { return this.inner.set(key, value); }
}

describe('IdempotencyStore', () => {
  it('uses provided store and returns duplicated result', async () => {
    const store = new CountingStore();
    const { fetch } = createSync({ schema: {}, database: makeDb() as any, idempotencyStore: store });
    const op = { op: 'insert', table: 't', rows: { a: 1 }, clientOpId: 'op1' } as any;
    const r1 = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) }));
    expect(r1.ok).toBe(true);
    const j1 = await r1.json();
    const r2 = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) }));
    const j2 = await r2.json();
    expect(j2).toMatchObject({ duplicated: true });
    expect(store.hits).toBeGreaterThan(0);
    expect(j2).toEqual(expect.objectContaining(j1));
  });
});
