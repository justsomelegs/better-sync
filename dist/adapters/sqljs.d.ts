import { DatabaseExecutor, Dialect } from '../types.js';

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

export { SQLJsExecutor };
