import { describe, it, expect } from 'vitest';
import { SQLJsExecutor } from '../src/adapters/sqljs';
import { createSyncEngine } from '../src';

describe('Step 1: entrypoint', () => {
  it('creates engine and exposes migration helpers', async () => {
    const db = await SQLJsExecutor.create();
    const engine = await createSyncEngine({ db });
    const applied = await engine.getAppliedMigrations();
    expect(applied.length).toBeGreaterThan(0);
    const version = await engine.getSchemaVersion();
    expect(version).toBe(applied.length);
    await engine.dispose();
  });
});

