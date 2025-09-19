import { createSyncEngine } from '../src/index';
import { SQLJsExecutor } from '../src/adapters/sqljs';

async function main() {
  const db = await SQLJsExecutor.create();
  const engine = await createSyncEngine({ db });
  console.log('Applied migrations:', await engine.getAppliedMigrations());
  console.log('Schema version:', await engine.getSchemaVersion());
  await engine.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

