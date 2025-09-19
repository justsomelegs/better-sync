/**
 * Public and internal types for the new MVP sync engine.
 * All exported types are documented for great DX.
 */
/**
 * Supported SQL dialects.
 */
type Dialect = 'sqlite' | 'postgres';
/**
 * Minimal database executor the library operates against.
 * Implementations must handle parameter binding according to the underlying driver.
 */
interface DatabaseExecutor {
    /** SQL dialect: influences certain DDL differences and behaviors. */
    readonly dialect: Dialect;
    /**
     * Execute a statement that does not return rows (DDL/DML). Must support positional params.
     */
    run(sql: string, params?: readonly unknown[]): Promise<void> | void;
    /**
     * Fetch all rows as an array of objects.
     */
    all<TRecord extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<TRecord[]> | TRecord[];
    /**
     * Fetch the first row or undefined.
     */
    get<TRecord extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<TRecord | undefined> | (TRecord | undefined);
    /**
     * Execute a function within a transaction boundary. The provided executor participates
     * in the transaction context. Nested transactions are not required to be supported.
     */
    transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T> | T): Promise<T> | T;
}
/**
 * A schema migration.
 */
interface Migration {
    /** Unique identifier, usually sequential like '001_core'. */
    readonly id: string;
    /** Apply the migration. Must be idempotent when guarded by the migrations ledger. */
    up(db: DatabaseExecutor): Promise<void> | void;
}
/**
 * Options for creating the sync engine.
 */
interface CreateSyncEngineOptions {
    /** Database executor provided by the application. */
    readonly db: DatabaseExecutor;
    /** Additional app-specific migrations to run after the core set. */
    readonly migrations?: readonly Migration[];
}
/**
 * The Sync Engine public surface for Step 1 (bootstrap & migrations).
 */
interface SyncEngine {
    /**
     * Return applied migration IDs in order of application.
     */
    getAppliedMigrations(): Promise<string[]>;
    /**
     * Return current schema version, represented by the count of applied migrations.
     */
    getSchemaVersion(): Promise<number>;
    /**
     * Dispose of resources. For BYO DB, this is a no-op.
     */
    dispose(): Promise<void>;
}

export type { CreateSyncEngineOptions, DatabaseExecutor, Dialect, Migration, SyncEngine };
