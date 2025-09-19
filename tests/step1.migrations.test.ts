import { describe, it, expect } from 'vitest';
import { SQLJsExecutor } from '../src/adapters/sqljs';
import { applyMigrations, coreMigrations } from '../src/migrations';

describe('Step 1: migrations', () => {
  it('applies core migrations idempotently and in order', async () => {
    const db = await SQLJsExecutor.create();
    const first = await applyMigrations(db, coreMigrations());
    expect(first.length).toBeGreaterThan(0);

    // Running again should not add more rows
    const second = await applyMigrations(db, coreMigrations());
    expect(second).toEqual(first);

    const applied = db.all<{ id: string }>(
      `SELECT id FROM _sync_migrations ORDER BY applied_at ASC, id ASC`,
    );
    expect(applied.map((r) => r.id)).toEqual(first);
  });
});

