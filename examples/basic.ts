import { createSyncEngine } from '../src/index';
import initSqlJs from 'sql.js';
import { sqliteAdapter } from '../src/adapters/sqljs';

async function main() {
  const SQL = await initSqlJs({});
  const db = new SQL.Database();
  const database = sqliteAdapter({ db });
  const engine = await createSyncEngine({ database });
  console.log('Applied migrations:', await engine.getAppliedMigrations());
  console.log('Schema version:', await engine.getSchemaVersion());
  await engine.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

