import { describe, it, expect } from 'vitest';
import { createSync } from '../../';
import { createClient } from '../createClient';

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

describe('client mutator', () => {
  it('calls named mutator and returns result', async () => {
    const sync = createSync({ schema: {}, database: makeDb() as any, mutators: {
      add: { args: undefined, handler: async (_ctx: any, a: { x: number; y: number }) => (a.x + a.y) }
    } });
    const client = createClient({ baseURL: 'http://test', fetch: (input: any, init?: any) => sync.fetch(typeof input === 'string' ? new Request(input, init) : input), mutators: sync.mutators });
    const sum = await client.mutator('add', { x: 2, y: 3 });
    expect(sum).toBe(5);
    const sum2 = await client.mutators.add({ x: 4, y: 6 });
    expect(sum2).toBe(10);
  });
});
