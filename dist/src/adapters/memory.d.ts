import { ApplyResult, Change, ConflictResolution, DatabaseAdapter, DatabaseVendor, LogicalClock, RecordId } from "../types";
/**
 * In-memory adapter backed by Maps. Useful for tests and examples.
 */
export declare class InMemoryAdapter implements DatabaseAdapter {
    readonly vendor: DatabaseVendor;
    private clock;
    private readonly changes;
    private readonly collections;
    private readonly meta;
    init(): Promise<void>;
    tick(): Promise<LogicalClock>;
    now(): Promise<LogicalClock>;
    private getCollection;
    private resolve;
    applyChange<T>(change: Change<T>, resolution: ConflictResolution): Promise<ApplyResult<T>>;
    getChangesSince(sinceClk: LogicalClock, limit?: number): Promise<Change[]>;
    ingestChanges(changes: Change[], resolution: ConflictResolution): Promise<void>;
    getRecord<T>(collection: string, recordId: RecordId): Promise<T | undefined>;
    listRecords<T>(collection: string, limit?: number, offset?: number): Promise<T[]>;
    listEntries<T = any>(collection: string, limit?: number, offset?: number): Promise<{
        id: RecordId;
        data: T;
    }[]>;
    getMeta(key: string): Promise<string | undefined>;
    setMeta(key: string, value: string): Promise<void>;
}
//# sourceMappingURL=memory.d.ts.map