import { describe, it, expect } from 'vitest';
import { createSync } from '../../';
import { toNextJsHandler } from '../../next-js';

function makeDb() {
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert() { return {}; }, async updateByPk() { return {}; }, async deleteByPk() { return { ok: true }; },
    async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; }
  } as const;
}

describe('toNextJsHandler', () => {
  it('exposes GET/POST handlers', async () => {
    const sync = createSync({ schema: {}, database: makeDb() as any });
    const { GET, POST } = toNextJsHandler(sync.fetch);
    expect(typeof GET).toBe('function');
    expect(typeof POST).toBe('function');
  });
});
