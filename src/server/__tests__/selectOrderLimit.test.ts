import { describe, it, expect } from 'vitest';
import { createSync } from '../../';
import { memoryAdapter } from '../../storage/server';

async function seed(db: any) {
  await db.insert('todos', { id: 'a', title: 'a', updatedAt: 1, version: 1 });
  await db.insert('todos', { id: 'b', title: 'b', updatedAt: 2, version: 1 });
  await db.insert('todos', { id: 'c', title: 'c', updatedAt: 3, version: 1 });
}

describe('select order/limit', () => {
  it('orders by updatedAt desc and respects limit', async () => {
    const db = memoryAdapter() as any;
    await seed(db);
    const { fetch } = createSync({ schema: {}, database: db });
    const res = await fetch(new Request('http://test/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', orderBy: { updatedAt: 'desc' }, limit: 2 }) }));
    const json = await res.json();
    expect(json.data.map((r: any) => r.id)).toEqual(['c', 'b']);
    // With encoded cursor, we just assert it's non-null; decoding is adapter concern
    expect(typeof json.nextCursor).toBe('string');
  });
});
