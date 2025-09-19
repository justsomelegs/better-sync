import { createSyncEngine } from '../src/index';
import { SQLJsAdapter } from '../src/adapters/sqljs';

async function main() {
  const adapter = await SQLJsAdapter.create();
  const engine = await createSyncEngine({ adapter });
  console.log('Applied migrations:', await engine.getAppliedMigrations());
  console.log('Schema version:', await engine.getSchemaVersion());
  await engine.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

