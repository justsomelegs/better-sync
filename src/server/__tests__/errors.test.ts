import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createSync } from '../../';

describe('error mapping', () => {
  it('maps conflict to 409/CONFLICT', async () => {
    const db = {
      async begin() { }, async commit() { }, async rollback() { },
      async insert() { const e: any = new Error('unique violation'); e.code = 'CONFLICT'; e.details = { constraint: 'unique' }; throw e; },
      async updateByPk() { return {}; }, async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; }
    } as any;
    const { fetch } = createSync({ schema: {}, database: db });
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify({ op: 'insert', table: 't', rows: { a: 1 } }), headers: { 'Content-Type': 'application/json' } }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('CONFLICT');
  });

  it('maps not found to 404/NOT_FOUND', async () => {
    const db = {
      async begin() { }, async commit() { }, async rollback() { },
      async insert() { return {}; },
      async updateByPk() { const e: any = new Error('missing'); e.code = 'NOT_FOUND'; throw e; },
      async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; }
    } as any;
    const { fetch } = createSync({ schema: {}, database: db });
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify({ op: 'update', table: 't', pk: 'x', set: {} }), headers: { 'Content-Type': 'application/json' } }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe('NOT_FOUND');
  });

  it('maps validation errors to 400/BAD_REQUEST', async () => {
    const { fetch } = createSync({
      schema: { todos: { schema: z.object({ id: z.string(), title: z.string().min(2), updatedAt: z.number().optional() }) } }, database: {
        async begin() { }, async commit() { }, async rollback() { }, async insert() { return {}; }, async updateByPk() { return {}; }, async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; }
      } as any
    });
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { title: 'x' } }) }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.code).toBe('BAD_REQUEST');
  });

  it('maps bad request to 400/BAD_REQUEST', async () => {
    const db = {
      async begin() { }, async commit() { }, async rollback() { },
      async insert() { const e: any = new Error('validation'); e.code = 'BAD_REQUEST'; e.details = { field: 'x' }; throw e; },
      async updateByPk() { return {}; }, async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; }
    } as any;
    const { fetch } = createSync({ schema: {}, database: db });
    const res = await fetch(new Request('http://test/mutate', { method: 'POST', body: JSON.stringify({ op: 'insert', table: 't', rows: {} }), headers: { 'Content-Type': 'application/json' } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('BAD_REQUEST');
  });
});
