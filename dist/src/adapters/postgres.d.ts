import { ApplyResult, Change, ConflictResolution, DatabaseAdapter, DatabaseVendor, LogicalClock, RecordId } from "../types";
/**
 * Postgres adapter using a minimal client (pg-like) with query method.
 */
export declare class PostgresAdapter implements DatabaseAdapter {
    readonly vendor: DatabaseVendor;
    private readonly client;
    private readonly schema;
    private readonly tablePrefix;
    constructor(client: PostgresAdapter["client"], options?: {
        schema?: string;
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
//# sourceMappingURL=postgres.d.ts.map