import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { sqliteAdapter } from '../src/adapters/sqljs';
import { createSyncEngine } from '../src';

describe('Step 4: conflict policy (server-wins)', () => {
  it('keeps server doc on conflict', async () => {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    const engine = await createSyncEngine({ database: sqliteAdapter({ db }) });
    const [a] = await engine.mutate([{ namespace: 'todos', recordId: '1', op: 'insert', clientVersion: 0, payload: { title: 'server' } }]);
    const [b] = await engine.mutate([{ namespace: 'todos', recordId: '1', op: 'update', clientVersion: 0, payload: { title: 'client-stale' } }]);
    expect(b.applied).toBe(false);
    const rows = (sqliteAdapter({ db }).session()).all<{ doc: string }>(`SELECT doc FROM "todos" WHERE id = '1'`);
    expect(JSON.parse(rows[0].doc)).toEqual({ title: 'server' });
  });
});

