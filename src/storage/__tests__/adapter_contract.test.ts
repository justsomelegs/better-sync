import { describe, it, expect } from 'vitest';
import { sqliteAdapter, memoryAdapter } from '../server';

async function seed(adapter: any) {
  await adapter.ensureMeta?.();
  await adapter.insert('items', { id: 'a', name: 'one', updatedAt: 1, version: 1 });
}

describe('DatabaseAdapter contract - CAS behavior', () => {
  it('sqliteAdapter: updateByPk respects ifVersion and throws on mismatch', async () => {
    const a = sqliteAdapter({ url: 'file::memory:' }) as any;
    await seed(a);
    // success with correct version
    const ok = await a.updateByPk('items', 'a', { name: 'two', updatedAt: 2, version: 2 }, { ifVersion: 1 });
    expect(ok).toMatchObject({ name: 'two', version: 2 });
    // conflict with wrong version
    await expect(async () => {
      await a.updateByPk('items', 'a', { name: 'three', updatedAt: 3, version: 3 }, { ifVersion: 1 });
    }).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('memoryAdapter: updateByPk respects ifVersion and throws on mismatch', async () => {
    const a = memoryAdapter() as any;
    await seed(a);
    const ok = await a.updateByPk('items', 'a', { name: 'two' }, { ifVersion: 1 });
    expect(ok).toMatchObject({ name: 'two', version: 2 });
    await expect(async () => {
      await a.updateByPk('items', 'a', { name: 'three' }, { ifVersion: 1 });
    }).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

