import { describe, it, expect } from 'vitest';
import { createSync } from '../../';
import { z } from 'zod';

function makeDb() {
  const ops: any[] = [];
  return {
    ops,
    async begin() { ops.push(['begin']); },
    async commit() { ops.push(['commit']); },
    async rollback() { ops.push(['rollback']); },
    async insert(table: string, row: Record<string, any>) { ops.push(['insert', table, row]); return row; },
    async updateByPk(table: string, pk: any, set: Record<string, any>) { ops.push(['updateByPk', table, pk, set]); return { id: pk, ...set }; },
    async deleteByPk(table: string, pk: any) { ops.push(['deleteByPk', table, pk]); return { ok: true }; },
    async selectByPk() { return null; },
    async selectWindow() { return { data: [], nextCursor: null }; }
  } as const;
}

describe('mutate stamping & idempotency', () => {
  it('stamps insert with id/updatedAt/version', async () => {
    const db = makeDb();
    const { fetch } = createSync({ schema: {}, database: db as any });
    const body = { op: 'insert', table: 'todos', rows: { title: 'x' }, clientOpId: 'abc' } as any;
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    const json = await res.json();
    expect(json.row.id).toBeTruthy();
    expect(typeof json.row.updatedAt).toBe('number');
    expect(typeof json.row.version).toBe('number');
  });

  it('idempotent by clientOpId', async () => {
    const db = makeDb();
    const { fetch } = createSync({ schema: {}, database: db as any });
    const body = { op: 'insert', table: 'todos', rows: { title: 'x' }, clientOpId: 'same' } as any;
    const res1 = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    const res2 = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    const j1 = await res1.json();
    const j2 = await res2.json();
    expect(j2.duplicated).toBe(true);
    expect(j1.row.id).toBe(j2.row.id);
  });

	it('honors per-table updatedAt override', async () => {
		const db = {
			async begin() {}, async commit() {}, async rollback() {},
			async insert(_t: string, row: any) { return { ...row }; },
			async updateByPk(_t: string, _pk: any, set: any) { return { id: _pk, ...set }; },
			async deleteByPk() { return { ok: true } }, async selectByPk() { return null }, async selectWindow() { return { data: [], nextCursor: null } }
		} as const;
		const schema = { posts: { updatedAt: 'updated_at', schema: z.object({ id: z.string().optional(), title: z.string(), updated_at: z.number().optional() }) } };
		const { fetch } = createSync({ schema, database: db as any });
		const res = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'posts', rows: { title: 'x' } }) }));
		expect(res.ok).toBe(true);
		const j = await res.json();
		expect(j.row.updated_at).toBeTypeOf('number');
	});
});
