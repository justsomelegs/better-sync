import { describe, it, expect } from 'vitest';
import { absurd, memory } from '../client';

describe('datastores', () => {
  it('memory apply/readWindow works', async () => {
    const store = memory();
    await store.apply([
      { table: 'todos', type: 'insert', row: { id: '1', title: 'a', updatedAt: 1 } },
      { table: 'todos', type: 'insert', row: { id: '2', title: 'b', updatedAt: 2 } },
    ]);
    const { data, nextCursor } = await store.readWindow('todos', { limit: 1 });
    expect(data.map(r => r.id)).toEqual(['2']);
    expect(nextCursor).toBe('2');
  });

  it('absurd apply/readByPk and window works', async () => {
    const store = await absurd();
    await store.apply([
      { table: 'todos', type: 'insert', row: { id: 'a', title: 'A', updatedAt: 100 } },
      { table: 'todos', type: 'insert', row: { id: 'b', title: 'B', updatedAt: 200 } },
      { table: 'todos', type: 'update', row: { id: 'a', title: 'A2', updatedAt: 150 } },
    ]);
    const one = await store.readByPk('todos', 'a');
    expect(one?.title).toBe('A2');
    const w1 = await store.readWindow('todos', { limit: 1 });
    expect(w1.data.map(r => r.id)).toEqual(['b']);
    const w2 = await store.readWindow('todos', { limit: 2, cursor: w1.nextCursor });
    expect(w2.data.map(r => r.id)).toEqual(['a']);
  });
});
