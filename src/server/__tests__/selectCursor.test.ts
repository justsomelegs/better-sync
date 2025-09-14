import { describe, it, expect } from 'vitest';
import { createSync } from '../../';

describe('select cursor/pagination', () => {
  it('returns nextCursor from adapter', async () => {
    const db = {
      async begin() {}, async commit() {}, async rollback() {},
      async insert() { return {}; }, async updateByPk() { return {}; }, async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; },
      async selectWindow(_t: string, req: any) { return { data: [{ id: 'a' }], nextCursor: req.cursor ? null : 'cursor-1' }; }
    } as any;

    const { fetch } = createSync({ schema: {}, database: db });
    const res1 = await fetch(new Request('http://test/select', { method: 'POST', body: JSON.stringify({ table: 'todos', limit: 1 }), headers: { 'Content-Type': 'application/json' } }));
    const j1 = await res1.json();
    expect(j1.nextCursor).toBe('cursor-1');

    const res2 = await fetch(new Request('http://test/select', { method: 'POST', body: JSON.stringify({ table: 'todos', limit: 1, cursor: j1.nextCursor }), headers: { 'Content-Type': 'application/json' } }));
    const j2 = await res2.json();
    expect(j2.nextCursor).toBeNull();
  });
});
