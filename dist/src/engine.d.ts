import { ApplyResult, Change, LogicalClock, NodeId, PushParams, PullParams, RecordId, SyncEngine, SyncEngineOptions, CollectionSchema } from "./types";
/**
 * Core implementation of the SyncEngine.
 *
 * @typeParam Schemas - Map of collection names to their `CollectionSchema` definitions.
 *
 * @remarks
 * This class is exported for advanced use-cases. Most applications should prefer `createSyncEngine`.
 */
export declare class SyncEngineImpl<Schemas extends Record<string, CollectionSchema<any>>> implements SyncEngine<Schemas> {
    readonly nodeId: NodeId;
    private readonly resolution;
    private readonly db;
    private readonly schemas;
    constructor(options: SyncEngineOptions<Schemas>);
    init(): Promise<void>;
    migrate(): Promise<void>;
    now(): Promise<LogicalClock>;
    put<K extends keyof Schemas & string>(collection: K, id: RecordId, value: ReturnType<Schemas[K]["parse"]>): Promise<ApplyResult<ReturnType<Schemas[K]["parse"]>>>;
    delete(collection: keyof Schemas & string, id: RecordId): Promise<ApplyResult<unknown>>;
    get<K extends keyof Schemas & string>(collection: K, id: RecordId): Promise<ReturnType<Schemas[K]["parse"]> | undefined>;
    list<K extends keyof Schemas & string>(collection: K, limit?: number, offset?: number): Promise<ReturnType<Schemas[K]["parse"]>[]>;
    pull(params: PullParams): Promise<Change[]>;
    push(params: PushParams): Promise<void>;
}
//# sourceMappingURL=engine.d.ts.map