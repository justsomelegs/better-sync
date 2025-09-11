export interface SqliteOptions { file: string; ensureSchema?: boolean; autoMigrate?: boolean }
export interface PostgresOptions { connectionString?: string; pool?: unknown }

/**
 * Create a SQLite storage provider configured by the given options.
 *
 * Returns an immutable provider object with the SQLite dialect, the passed
 * options, and two async helpers: `ensureSchema()` (idempotently create any
 * required internal tables—intended for dev/test usage) and
 * `applyBatch(tenantId, changes)` (apply a batch of change records within a
 * transactional context).
 *
 * @param options - Configuration for the SQLite provider. Key fields:
 *   - `file`: path to the SQLite database file.
 *   - `ensureSchema?`: if true, provider may create missing internal tables.
 *   - `autoMigrate?`: if true, provider may perform automatic migrations.
 * @returns An object typed as const: `{ dialect: "sqlite", options, ensureSchema, applyBatch }`.
 */
export function sqlite(options: SqliteOptions) {
  return {
    dialect: "sqlite" as const,
    options,
    async ensureSchema() { /* create internal tables if missing (dev/test only) */ },
    async applyBatch(_tenantId: string, _changes: any[]) { /* placeholder for SQL TX */ },
  } as const;
}
/**
 * Creates a Postgres storage provider configured with the given options.
 *
 * The returned provider has a literal `dialect` of `"postgres"`, echoes back the
 * provided `options`, and exposes two async helpers:
 * - `ensureSchema()` — create internal tables if they are missing (intended for dev/test)
 * - `applyBatch(tenantId, changes)` — apply a batch of changes for the given tenant (transactional placeholder)
 *
 * @param options - Postgres connection and pool configuration (e.g., `connectionString`, `pool`)
 * @returns A provider object `{ dialect: "postgres", options, ensureSchema, applyBatch }`
 */
export function postgres(options: PostgresOptions) {
  return {
    dialect: "postgres" as const,
    options,
    async ensureSchema() { /* create internal tables if missing (dev/test only) */ },
    async applyBatch(_tenantId: string, _changes: any[]) { /* placeholder for SQL TX */ },
  } as const;
}
