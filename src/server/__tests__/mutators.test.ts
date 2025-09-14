import { describe, it, expect } from 'vitest';
import { createSync } from '../../';
import { z } from 'zod';

function makeDb() {
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert(_t: string, row: any) { return { id: 't1', ...row, updatedAt: Date.now(), version: 1 }; },
    async updateByPk() { return {}; }, async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; }
  } as const;
}

describe('mutators', () => {
  it('invokes mutator with zod validated args', async () => {
    const sync = createSync({ schema: {}, database: makeDb() as any, mutators: {
      addTodo: { args: z.object({ title: z.string().min(1) }), handler: async ({ db }: any, { title }: { title: string }) => (db as any).insert('todos', { title, done: false }) }
    }});
    const res = await sync.fetch(new Request('http://test/mutators/addTodo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: { title: 'x' } }) }));
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.result.title).toBe('x');
  });

  it('returns 404 for missing mutator', async () => {
    const sync = createSync({ schema: {}, database: makeDb() as any, mutators: {} });
    const res = await sync.fetch(new Request('http://test/mutators/nope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: {} }) }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe('NOT_FOUND');
  });

  it('returns 400 when args validation fails', async () => {
    const sync = createSync({ schema: {}, database: makeDb() as any, mutators: {
      addTodo: { args: z.object({ title: z.string().min(3) }), handler: async ({ db }: any, { title }: { title: string }) => (db as any).insert('todos', { title, done: false }) }
    }});
    const res = await sync.fetch(new Request('http://test/mutators/addTodo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: { title: 'x' } }) }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('BAD_REQUEST');
  });
});
