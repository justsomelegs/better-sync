import { ApplyResult, Change, ConflictResolution, DatabaseAdapter, DatabaseVendor, LogicalClock, RecordId } from "../types";
/**
 * Minimal SQLite/libSQL adapter.
 *
 * @remarks
 * Works with any client exposing `exec(sql, params?)` and `all(sql, params?)` and `get(sql, params?)` methods
 * similar to `better-sqlite3`, `sqlite3`, or `@libsql/client`.
 */
export declare class SQLiteAdapter implements DatabaseAdapter {
    readonly vendor: DatabaseVendor;
    private readonly client;
    private readonly tablePrefix;
    constructor(client: SQLiteAdapter["client"], options?: {
        tablePrefix?: string;
    });
    private t;
    init(): Promise<void>;
    private readClock;
    tick(): Promise<LogicalClock>;
    now(): Promise<LogicalClock>;
    private resolve;
    applyChange<T>(change: Change<T>, resolution: ConflictResolution): Promise<ApplyResult<T>>;
    getChangesSince(sinceClk: LogicalClock, limit?: number): Promise<Change[]>;
    ingestChanges(changes: Change[], resolution: ConflictResolution): Promise<void>;
    getRecord<T>(collection: string, recordId: RecordId): Promise<T | undefined>;
    listRecords<T>(collection: string, limit?: number, offset?: number): Promise<T[]>;
    listEntries<T = any>(collection: string, limit?: number, offset?: number): Promise<{
        id: string;
        data: T;
    }[]>;
    getMeta(key: string): Promise<string | undefined>;
    setMeta(key: string, value: string): Promise<void>;
}
//# sourceMappingURL=sqlite.d.ts.map