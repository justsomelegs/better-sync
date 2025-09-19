import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { sqliteAdapter } from '../src/adapters/sqljs';
import { createSyncEngine } from '../src';

describe('Step 3: pull API', () => {
  it('pulls changes since a version with pagination', async () => {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    const engine = await createSyncEngine({ database: sqliteAdapter({ db }) });

    const [a] = await engine.mutate([{ namespace: 'todos', recordId: '1', op: 'insert', clientVersion: 0, payload: { title: 'a' } }]);
    const [b] = await engine.mutate([{ namespace: 'todos', recordId: '2', op: 'insert', clientVersion: 0, payload: { title: 'b' } }]);
    const [c] = await engine.mutate([{ namespace: 'todos', recordId: '1', op: 'update', clientVersion: a.serverVersion, payload: { title: 'a2' } }]);

    const p1 = await engine.pull({ since: 0, limit: 2 });
    expect(p1.changes).toHaveLength(2);
    expect(p1.changes[0].version).toBe(a.serverVersion);
    expect(p1.lastVersion).toBe(p1.changes[1].version);

    const p2 = await engine.pull({ since: p1.lastVersion, limit: 10 });
    expect(p2.changes).toHaveLength(1);
    expect(p2.changes[0].version).toBe(c.serverVersion);
    expect(p2.lastVersion).toBe(c.serverVersion);
  });

  it('supports namespace filtering', async () => {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    const engine = await createSyncEngine({ database: sqliteAdapter({ db }) });

    await engine.mutate([{ namespace: 'todos', recordId: '1', op: 'insert', clientVersion: 0, payload: { t: 'a' } }]);
    await engine.mutate([{ namespace: 'notes', recordId: '1', op: 'insert', clientVersion: 0, payload: { n: 'x' } }]);
    const res = await engine.pull({ since: 0, namespace: 'todos' });
    expect(res.changes.every((c) => c.namespace === 'todos')).toBe(true);
  });
});

