/**
 * Represents a unique identifier for a record in a collection/table.
 */
export type RecordId = string;
/**
 * Represents a monotonic logical clock used for ordering changes and conflict resolution.
 *
 * @remarks
 * We use a hybrid logical clock (HLC) simplified into a numeric increasing counter per node scope.
 */
export type LogicalClock = number;
/**
 * A unique identifier of the engine node/instance.
 */
export type NodeId = string;
/**
 * Supported database vendor identifiers.
 */
export type DatabaseVendor = "inmemory" | "sqlite" | "postgres";
/**
 * Represents a persisted change operation captured by the engine.
 */
export interface Change<TData = unknown> {
    /** Unique change id (uuid). */
    id: string;
    /** Collection/table name. */
    collection: string;
    /** Record id that the change applies to. */
    recordId: RecordId;
    /** Operation kind. */
    op: "put" | "delete";
    /** Data payload for put operations. */
    data?: TData;
    /** Logical clock when change was produced. */
    clk: LogicalClock;
    /** Originating node id. */
    nodeId: NodeId;
    /** Timestamp for auditing. */
    ts: number;
}
/**
 * Conflict resolution strategy.
 */
export type ConflictResolution = "lastWriteWins" | "merge";
/**
 * Result of applying a change to a record.
 */
export interface ApplyResult<TData = unknown> {
    /** Whether the record exists after applying the change. */
    exists: boolean;
    /** The final data if exists. */
    data?: TData;
    /** Whether the change was a no-op due to idempotency or older clock. */
    noop?: boolean;
}
/**
 * Versioned schema descriptor for a collection.
 */
export interface CollectionSchema<TData> {
    /** Name of the collection/table. */
    name: string;
    /** Current schema version integer. */
    version: number;
    /** Function to validate/normalize incoming data. Should throw on error. */
    parse: (input: unknown) => TData;
    /** Optional upgrader from previous version payloads. */
    upgrade?: (fromVersion: number, value: unknown) => TData;
}
/**
 * Database-agnostic operations that adapters must implement.
 */
export interface DatabaseAdapter {
    /** Vendor name. */
    vendor: DatabaseVendor;
    /** Initialize internal tables for engine state if not present. */
    init(): Promise<void>;
    /** Get and bump the node logical clock atomically. */
    tick(): Promise<LogicalClock>;
    /** Read current logical clock without bumping. */
    now(): Promise<LogicalClock>;
    /**
     * Persist a change and apply to materialized view (collection table).
     * Must be idempotent. Returns the final state after apply.
     */
    applyChange<T>(change: Change<T>, resolution: ConflictResolution): Promise<ApplyResult<T>>;
    /** Fetch changes greater than the provided clock. */
    getChangesSince(sinceClk: LogicalClock, limit?: number): Promise<Change[]>;
    /** Persist a batch of changes (from remote) using applyChange semantics. */
    ingestChanges(changes: Change[], resolution: ConflictResolution): Promise<void>;
    /** Return a record by id for a collection. */
    getRecord<T>(collection: string, recordId: RecordId): Promise<T | undefined>;
    /** List records in a collection. */
    listRecords<T>(collection: string, limit?: number, offset?: number): Promise<T[]>;
    /** List record entries with ids for a collection. */
    listEntries<T = any>(collection: string, limit?: number, offset?: number): Promise<{
        id: RecordId;
        data: T;
    }[]>;
    /** Get engine metadata by key. */
    getMeta(key: string): Promise<string | undefined>;
    /** Set engine metadata key-value. */
    setMeta(key: string, value: string): Promise<void>;
}
/**
 * Sync engine options.
 */
export interface SyncEngineOptions<Schemas extends Record<string, CollectionSchema<any>>> {
    /** Adapter connected to user-provided database. */
    db: DatabaseAdapter;
    /** Unique id of this node instance. Defaults to deterministic from adapter/vendor. */
    nodeId?: NodeId;
    /** Conflict resolution strategy (default lastWriteWins). */
    resolution?: ConflictResolution;
    /** Registered collection schemas keyed by collection name. */
    schemas: Schemas;
}
/**
 * Pull request parameters.
 */
export interface PullParams {
    /** Return changes since this logical clock (exclusive). */
    since: LogicalClock;
    /** Optional max number of changes. */
    limit?: number;
}
/**
 * Push payload parameters.
 */
export interface PushParams {
    /** Changes to push to the target. */
    changes: Change[];
}
/**
 * Public SyncEngine API.
 */
export interface SyncEngine<Schemas extends Record<string, CollectionSchema<any>>> {
    /** Unique node id. */
    readonly nodeId: NodeId;
    /** Logical clock now. */
    now(): Promise<LogicalClock>;
    /** Initialize underlying adapter (creates tables). */
    init(): Promise<void>;
    /** Run schema migrations for registered collections. */
    migrate(): Promise<void>;
    /** Put a record into a collection with conflict control. */
    put<K extends keyof Schemas & string>(collection: K, id: RecordId, value: ReturnType<Schemas[K]["parse"]>): Promise<ApplyResult<ReturnType<Schemas[K]["parse"]>>>;
    /** Delete a record from a collection. */
    delete(collection: keyof Schemas & string, id: RecordId): Promise<ApplyResult<unknown>>;
    /** Get a single record. */
    get<K extends keyof Schemas & string>(collection: K, id: RecordId): Promise<ReturnType<Schemas[K]["parse"]> | undefined>;
    /** List all records in a collection. */
    list<K extends keyof Schemas & string>(collection: K, limit?: number, offset?: number): Promise<ReturnType<Schemas[K]["parse"]>[]>;
    /** Pull changes since clock. */
    pull(params: PullParams): Promise<Change[]>;
    /** Push changes to this engine. */
    push(params: PushParams): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map