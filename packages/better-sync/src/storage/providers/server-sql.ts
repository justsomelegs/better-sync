export interface SqliteOptions { file: string; ensureSchema?: boolean; autoMigrate?: boolean }
export interface PostgresOptions { connectionString?: string; pool?: unknown }

export function sqlite(options: SqliteOptions) {
  return {
    dialect: "sqlite" as const,
    options,
    async ensureSchema() { /* create internal tables if missing (dev/test only) */ },
    async applyBatch(_tenantId: string, _changes: any[]) { /* placeholder for SQL TX */ },
  } as const;
}
export function postgres(options: PostgresOptions) {
  return {
    dialect: "postgres" as const,
    options,
    async ensureSchema() { /* create internal tables if missing (dev/test only) */ },
    async applyBatch(_tenantId: string, _changes: any[]) { /* placeholder for SQL TX */ },
  } as const;
}
