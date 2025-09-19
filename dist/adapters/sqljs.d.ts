import { DatabaseExecutor, Dialect, DatabaseAdapter } from '../types.js';

/**
 * A minimal adapter around sql.js Database implementing DatabaseExecutor.
 * Useful for tests and examples. This behaves like a synchronous SQLite engine.
 */
declare class SQLJsExecutor implements DatabaseExecutor {
    readonly dialect: Dialect;
    private readonly db;
    private constructor();
    /** Create a new in-memory sql.js executor instance. */
    static create(): Promise<SQLJsExecutor>;
    run(sql: string, params?: readonly unknown[]): void;
    all<TRecord extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): TRecord[];
    get<TRecord extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): TRecord | undefined;
    transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T> | T): Promise<T> | T;
}
/**
 * Database adapter for sql.js. Provides executors for the engine to use.
 */
declare class SQLJsAdapter implements DatabaseAdapter {
    readonly dialect: Dialect;
    private readonly executor;
    private constructor();
    static create(): Promise<SQLJsAdapter>;
    session(): DatabaseExecutor;
}

export { SQLJsAdapter, SQLJsExecutor };
