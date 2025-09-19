import initSqlJs, { type Database as SQLJSDatabase } from 'sql.js';
import type { DatabaseAdapter, DatabaseExecutor, Dialect } from '../types';

/**
 * A minimal adapter around sql.js Database implementing DatabaseExecutor.
 * Useful for tests and examples. This behaves like a synchronous SQLite engine.
 */
export class SQLJsExecutor implements DatabaseExecutor {
  public readonly dialect: Dialect = 'sqlite';
  private readonly db: SQLJSDatabase;

  private constructor(db: SQLJSDatabase) {
    this.db = db;
  }

  /** Create a new in-memory sql.js executor instance. */
  static async create(): Promise<SQLJsExecutor> {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    return new SQLJsExecutor(db);
  }

  run(sql: string, params: readonly unknown[] = []): void {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as any);
      while (stmt.step()) {
        // consume
      }
    } finally {
      stmt.free();
    }
  }

  all<TRecord extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): TRecord[] {
    const stmt = this.db.prepare(sql);
    const rows: TRecord[] = [];
    try {
      stmt.bind(params as any);
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>;
        rows.push(row as TRecord);
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  get<TRecord extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): TRecord | undefined {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as any);
      if (stmt.step()) {
        return stmt.getAsObject() as TRecord;
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T> | T): Promise<T> | T {
    this.run('BEGIN');
    try {
      const result = fn(this);
      if (result && typeof (result as any).then === 'function') {
        return (result as Promise<T>)
          .then((value) => {
            this.run('COMMIT');
            return value;
          })
          .catch((err) => {
            this.run('ROLLBACK');
            throw err;
          });
      }
      this.run('COMMIT');
      return result as T;
    } catch (err) {
      this.run('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Database adapter for sql.js. Provides executors for the engine to use.
 */
export class SQLJsAdapter implements DatabaseAdapter {
  public readonly dialect: Dialect = 'sqlite';
  private readonly executor: SQLJsExecutor;

  private constructor(executor: SQLJsExecutor) {
    this.executor = executor;
  }

  static async create(): Promise<SQLJsAdapter> {
    const exec = await SQLJsExecutor.create();
    return new SQLJsAdapter(exec);
  }

  session(): DatabaseExecutor {
    return this.executor;
  }
}

