import { describe, it, expect } from 'vitest';
import { createSync } from '../../';

function makeDb() {
  const rows = new Map<string, any>();
  return {
    async begin() { }, async commit() { }, async rollback() { },
    async insert(_t: string, row: any) { rows.set(String(row.id), row); return { ...row }; },
    async updateByPk(_t: string, pk: any, set: any) { const prev = rows.get(String(pk)) || {}; const next = { ...prev, ...set }; rows.set(String(pk), next); return { ...next }; },
    async deleteByPk() { return { ok: true }; },
    async selectByPk(_t: string, pk: any) { return rows.get(String(pk)) ?? null; },
    async selectWindow() { return { data: [], nextCursor: null }; }
  } as const;
}

describe('upsert', () => {
  it('inserts when missing, merges when present', async () => {
    const { fetch } = createSync({ schema: {}, database: makeDb() as any });
    const ulid = '01J9Y0C8WEN8G2YCP0QWQFQ8R9';
    let res = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'upsert', table: 'todos', row: { id: ulid, title: 'a' } }) }));
    expect(res.ok).toBe(true);
    let j = await res.json();
    expect(j.row.title).toBe('a');

    res = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'upsert', table: 'todos', row: { id: ulid, done: true } }) }));
    j = await res.json();
    expect(j.row.title).toBe('a');
    expect(j.row.done).toBe(true);

    // insert-only (merge: []) should conflict if exists
    res = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'upsert', table: 'todos', row: { id: ulid }, merge: [] }) }));
    expect(res.status).toBe(409);
  });
});

describe('upsert arrays', () => {
  it('returns rows when upserting many', async () => {
    const { fetch } = createSync({ schema: {}, database: makeDb() as any });
    const ids = ['01J9Y0C8WEN8G2YCP0QWQFQ8R9','01J9Y0C8WEN8G2YCP0QWQFQ8RA'];
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'upsert', table: 'todos', rows: [ { id: ids[0], title: 'a' }, { id: ids[1], title: 'b' } ] }) }));
    expect(res.ok).toBe(true);
    const j = await res.json();
    expect(Array.isArray(j.rows)).toBe(true);
    expect(j.rows.length).toBe(2);
  });
});
