import { Migration, DatabaseExecutor } from './types.mjs';

/**
 * Create the core migrations required by the sync engine. These include the
 * migrations ledger and the durable change/version tracking tables.
 */
declare function coreMigrations(): Migration[];
/**
 * Apply migrations in order, guarding with the migrations ledger.
 */
declare function applyMigrations(db: DatabaseExecutor, migrations: readonly Migration[]): Promise<string[]>;

export { applyMigrations, coreMigrations };
