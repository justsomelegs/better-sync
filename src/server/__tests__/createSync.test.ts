import { describe, it, expect } from 'vitest';
import { createSync } from '../../';
import { memoryAdapter } from '../../storage/server';

function makeDb() {
  const ops: any[] = [];
  return {
    ops,
    async begin() { ops.push(['begin']); },
    async commit() { ops.push(['commit']); },
    async rollback() { ops.push(['rollback']); },
    async insert(table: string, row: Record<string, unknown>) { ops.push(['insert', table, row]); return { id: 't1', ...row }; },
    async updateByPk(table: string, pk: any, set: Record<string, unknown>) { ops.push(['updateByPk', table, pk, set]); return { id: pk, ...set }; },
    async deleteByPk(table: string, pk: any) { ops.push(['deleteByPk', table, pk]); return { ok: true }; },
    async selectByPk() { return null; },
    async selectWindow(table: string, req: any) { ops.push(['selectWindow', table, req]); return { data: [], nextCursor: null }; }
  } as const;
}

describe('createSync', () => {
  it('select returns window', async () => {
    const db = makeDb();
    const { fetch } = createSync({ schema: {}, database: db as any });
    const res = await fetch(new Request('http://test/select', { method: 'POST', body: JSON.stringify({ table: 'todos' }), headers: { 'Content-Type': 'application/json' } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: [], nextCursor: null });
  });

  it('supports composite PKs end-to-end', async () => {
    const db = memoryAdapter() as any;
    const { fetch } = createSync({ schema: {}, database: db });
    // Insert two rows with composite pk simulated via id concatenation in memory adapter
    // Memory canonical pk format: sorted keys e.g. "a=1|workspaceId=w1"
    await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'items', rows: { id: 'a=1|workspaceId=w1', updatedAt: 1 } }) }));
    await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'items', rows: { id: 'a=2|workspaceId=w1', updatedAt: 2 } }) }));
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update', table: 'items', pk: { workspaceId: 'w1', a: '1' }, set: { title: 'x' } }) }));
    const j = await res.json();
    expect(j.row.title).toBe('x');
  });

  it('mutate insert single row', async () => {
    const db = makeDb();
    const { fetch } = createSync({ schema: {}, database: db as any });
    const body = { op: 'insert', table: 'todos', rows: { title: 'x' } };
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.row).toBeDefined();
  });

  it('events responds SSE', async () => {
    const db = makeDb();
    const { fetch } = createSync({ schema: {}, database: db as any });
    const res = await fetch(new Request('http://test/events'));
    expect(res.headers.get('Content-Type')).toMatch('text/event-stream');
  });
});
