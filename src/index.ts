import type { CreateSyncEngineOptions, SyncEngine } from './types';
import { applyMigrations, coreMigrations } from './migrations';

/**
 * Create the Sync Engine instance.
 *
 * Step 1 focuses on bootstrapping core tables and applying migrations. Future
 * steps will add change capture, conflict resolution, and query APIs.
 *
 * @param options - Engine creation options including the application-provided database executor.
 * @returns A SyncEngine instance with basic schema/migration helpers.
 */
export async function createSyncEngine(options: CreateSyncEngineOptions): Promise<SyncEngine> {
  const { adapter, migrations = [] } = options;
  const db = adapter.session();
  const allMigrations = [...coreMigrations(), ...migrations];
  await applyMigrations(db, allMigrations);

  return {
    async getAppliedMigrations() {
      const rows = await db.all<{ id: string }>(
        `SELECT id FROM _sync_migrations ORDER BY applied_at ASC, id ASC`,
      );
      return rows.map((r) => r.id);
    },
    async getSchemaVersion() {
      const row = await db.get<{ n: number }>(
        `SELECT COUNT(1) as n FROM _sync_migrations`,
      );
      return row?.n ?? 0;
    },
    async dispose() {
      // BYO DB: nothing to dispose
    },
  };
}

export * from './types';

