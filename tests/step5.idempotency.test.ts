import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { sqliteAdapter } from '../src/adapters/sqljs';
import { createSyncEngine } from '../src';

describe('Step 5: idempotency', () => {
  it('replaying the same idempotency key returns the same result and no duplicate changes', async () => {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    const engine = await createSyncEngine({ database: sqliteAdapter({ db }) });
    const key = 'k1';

    const [r1] = await engine.mutate([
      { namespace: 'todos', recordId: '1', op: 'insert', clientVersion: 0, payload: { title: 'a' }, idempotencyKey: key },
    ]);

    const [r2] = await engine.mutate([
      { namespace: 'todos', recordId: '1', op: 'insert', clientVersion: 0, payload: { title: 'a' }, idempotencyKey: key },
    ]);

    expect(r2).toEqual(r1);

    const count = (sqliteAdapter({ db }).session()).get<{ n: number }>(
      `SELECT COUNT(1) as n FROM _sync_changes WHERE namespace = 'todos' AND record_id = '1'`,
    )!.n;
    expect(count).toBe(1);
  });
});

