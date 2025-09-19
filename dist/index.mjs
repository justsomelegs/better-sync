import { coreMigrations, applyMigrations } from './migrations.mjs';

async function createSyncEngine(options) {
  const { db, migrations = [] } = options;
  const allMigrations = [...coreMigrations(), ...migrations];
  await applyMigrations(db, allMigrations);
  return {
    async getAppliedMigrations() {
      const rows = await db.all(
        `SELECT id FROM _sync_migrations ORDER BY applied_at ASC, id ASC`
      );
      return rows.map((r) => r.id);
    },
    async getSchemaVersion() {
      const row = await db.get(
        `SELECT COUNT(1) as n FROM _sync_migrations`
      );
      return row?.n ?? 0;
    },
    async dispose() {
    }
  };
}

export { createSyncEngine };
