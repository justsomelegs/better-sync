import { describe, it, expect } from 'vitest';
import { createSync } from '../../';

describe('compare-and-set', () => {
  it('maps version mismatch to CONFLICT', async () => {
    const db = {
      async begin() {}, async commit() {}, async rollback() {},
      async insert() { return {}; },
      async updateByPk(_t: string, _pk: any, _set: any, opts?: { ifVersion?: number }) {
        if (opts?.ifVersion && opts.ifVersion !== 1) {
          const e: any = new Error('Version mismatch'); e.code = 'CONFLICT'; e.details = { expectedVersion: opts.ifVersion, actualVersion: 1 }; throw e;
        }
        return { id: 'x', version: 2 };
      },
      async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; }
    } as any;

    const { fetch } = createSync({ schema: {}, database: db });
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify({ op: 'update', table: 't', pk: 'x', set: {}, ifVersion: 2 }), headers: { 'Content-Type': 'application/json' } }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('CONFLICT');
    expect(json.details?.expectedVersion).toBe(2);
  });
});
