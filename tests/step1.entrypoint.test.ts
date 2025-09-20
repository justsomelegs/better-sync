import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { sqliteAdapter } from '../src/adapters/sqljs';
import { createSyncEngine } from '../src';

describe('Step 1: entrypoint', () => {
  it('creates engine and exposes migration helpers', async () => {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    const database = sqliteAdapter({ db });
    const engine = await createSyncEngine({ database });
    const applied = await engine.getAppliedMigrations();
    expect(applied.length).toBeGreaterThan(0);
    const version = await engine.getSchemaVersion();
    expect(version).toBe(applied.length);
    await engine.dispose();
  });
});

