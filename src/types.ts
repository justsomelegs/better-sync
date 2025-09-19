/**
 * Public and internal types for the new MVP sync engine.
 * All exported types are documented for great DX.
 */

/**
 * Supported SQL dialects.
 */
export type Dialect = 'sqlite' | 'postgres';

/**
 * Minimal database executor the library operates against.
 * Implementations must handle parameter binding according to the underlying driver.
 */
export interface DatabaseExecutor {
  /** SQL dialect: influences certain DDL differences and behaviors. */
  readonly dialect: Dialect;

  /**
   * Execute a statement that does not return rows (DDL/DML). Must support positional params.
   */
  run(sql: string, params?: readonly unknown[]): Promise<void> | void;

  /**
   * Fetch all rows as an array of objects.
   */
  all<TRecord extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<TRecord[]> | TRecord[];

  /**
   * Fetch the first row or undefined.
   */
  get<TRecord extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<TRecord | undefined> | (TRecord | undefined);

  /**
   * Execute a function within a transaction boundary. The provided executor participates
   * in the transaction context. Nested transactions are not required to be supported.
   */
  transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T> | T): Promise<T> | T;
}

/**
 * A database adapter that provides executors and captures dialect specifics.
 * This separates application concerns from the sync engine core.
 */
export interface DatabaseAdapter {
  /** SQL dialect used by the underlying database. */
  readonly dialect: Dialect;
  /**
   * Acquire an executor/session to run queries. Implementations may reuse a
   * single connection or create a new one; the engine treats it as opaque.
   */
  session(): DatabaseExecutor;
}

/**
 * A schema migration.
 */
export interface Migration {
  /** Unique identifier, usually sequential like '001_core'. */
  readonly id: string;
  /** Apply the migration. Must be idempotent when guarded by the migrations ledger. */
  up(db: DatabaseExecutor): Promise<void> | void;
}

/**
 * Options for creating the sync engine.
 */
export interface CreateSyncEngineOptions {
  /** Database adapter provided by the application. */
  readonly database: DatabaseAdapter;
  /** Additional app-specific migrations to run after the core set. */
  readonly migrations?: readonly Migration[];
}

/**
 * The Sync Engine public surface for Step 1 (bootstrap & migrations).
 */
export interface SyncEngine {
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

  /**
   * Apply one or more mutations transactionally with durable versioning.
   */
  mutate(mutations: readonly MutationInput[]): Promise<MutationResult[]>;

  /**
   * Pull change rows since a given version, optionally filtered by namespace and limited.
   */
  pull(options: PullOptions): Promise<PullResult>;
}

/** Allowed mutation operations. */
export type MutationOp = 'insert' | 'update' | 'delete';

/**
 * Input for a mutation to be applied transactionally.
 */
export interface MutationInput<TPayload = Record<string, unknown>> {
  /** Logical namespace/entity name. */
  namespace: string;
  /** Primary key identifier for the record. */
  recordId: string;
  /** Operation to perform from the client's perspective. */
  op: MutationOp;
  /** Client-known version for optimistic concurrency control. */
  clientVersion: number;
  /** Optional payload to record in the change log. */
  payload?: TPayload;
}

/** Result for a single mutation. */
export interface MutationResult {
  /** Whether the mutation was applied. */
  applied: boolean;
  /** The server-assigned version after processing. */
  serverVersion: number;
  /** Conflict information if not applied. */
  conflict?: { reason: string; serverVersion: number };
}

/** Options to fetch changes since a version. */
export interface PullOptions {
  /** Exclusive starting version (i.e., fetch changes with version > since). */
  since: number;
  /** Optional namespace filter. */
  namespace?: string;
  /** Optional limit on number of rows returned. */
  limit?: number;
}

/** A change row returned by pull. */
export interface ChangeRow<TPayload = unknown> {
  id: number;
  namespace: string;
  record_id: string;
  version: number;
  op: 'insert' | 'update' | 'delete';
  payload: TPayload | null;
  ts: string;
}

/** Result of a pull request. */
export interface PullResult<TPayload = unknown> {
  changes: ChangeRow<TPayload>[];
  lastVersion: number;
}

