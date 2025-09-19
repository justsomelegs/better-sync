import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { sqliteAdapter } from '../src/adapters/sqljs';
import { createSyncEngine } from '../src';

describe('Step 2: mutate API', () => {
  it('applies insert and update with monotonic versions', async () => {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    const engine = await createSyncEngine({ database: sqliteAdapter({ db }) });

    const [r1] = await engine.mutate([
      { namespace: 'todos', recordId: '1', op: 'insert', clientVersion: 0, payload: { title: 'a' } },
    ]);
    expect(r1.applied).toBe(true);
    expect(r1.serverVersion).toBeGreaterThan(0);

    const [r2] = await engine.mutate([
      { namespace: 'todos', recordId: '1', op: 'update', clientVersion: r1.serverVersion, payload: { title: 'b' } },
    ]);
    expect(r2.applied).toBe(true);
    expect(r2.serverVersion).toBeGreaterThan(r1.serverVersion);

    const rows = (sqliteAdapter({ db }).session()).all<{ id: string; doc: string }>(`SELECT id, doc FROM "todos"`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('1');
    expect(JSON.parse(rows[0].doc)).toEqual({ title: 'b' });
  });

  it('detects conflict and returns server-wins outcome', async () => {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    const engine = await createSyncEngine({ database: sqliteAdapter({ db }) });

    const [r1] = await engine.mutate([
      { namespace: 'todos', recordId: '1', op: 'insert', clientVersion: 0, payload: { title: 'a' } },
    ]);
    expect(r1.applied).toBe(true);

    // Stale client tries to update using old version 0
    const [r2] = await engine.mutate([
      { namespace: 'todos', recordId: '1', op: 'update', clientVersion: 0, payload: { title: 'stale' } },
    ]);
    expect(r2.applied).toBe(false);
    expect(r2.conflict?.reason).toBe('version_mismatch');
    expect(r2.serverVersion).toBe(r1.serverVersion);
  });
});

