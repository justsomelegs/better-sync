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
  const [ins] = await engine.mutate([
    { namespace: 'todos', recordId: '1', op: 'insert', clientVersion: 0, payload: { title: 'hello' } },
  ]);
  const [upd] = await engine.mutate([
    { namespace: 'todos', recordId: '1', op: 'update', clientVersion: ins.serverVersion, payload: { title: 'world' } },
  ]);
  console.log('Versions:', { insert: ins.serverVersion, update: upd.serverVersion });
  const pulled = await engine.pull({ since: 0, limit: 10 });
  console.log('Pulled changes:', pulled);
  await engine.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

