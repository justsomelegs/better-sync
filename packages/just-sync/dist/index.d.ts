type PrimaryKey = string | number | Record<string, string | number>;
type OrderBy = Record<string, 'asc' | 'desc'>;
type SelectWindow = {
    select?: string[];
    orderBy?: OrderBy;
    limit?: number;
    cursor?: string | null;
};
type MutationOp = {
    op: 'insert';
    table: string;
    rows: Record<string, unknown> | Record<string, unknown>[];
} | {
    op: 'update';
    table: string;
    pk: PrimaryKey;
    set: Record<string, unknown>;
    ifVersion?: number;
} | {
    op: 'updateWhere';
    table: string;
    where: unknown;
    set: Record<string, unknown>;
} | {
    op: 'delete';
    table: string;
    pk: PrimaryKey;
} | {
    op: 'deleteWhere';
    table: string;
    where: unknown;
} | {
    op: 'upsert';
    table: string;
    rows: Record<string, unknown> | Record<string, unknown>[];
    merge?: string[];
};
type MutationRequest = MutationOp & {
    clientOpId?: string;
};
type MutationResponse = {
    row: Record<string, unknown>;
} | {
    rows: Record<string, unknown>[];
} | {
    ok: true;
} | {
    ok: number;
    failed: Array<{
        pk: PrimaryKey;
        error: {
            code: string;
            message: string;
        };
    }>;
    pks: PrimaryKey[];
};
type SelectRequest = {
    table: string;
    where?: unknown;
    select?: string[];
    orderBy?: OrderBy;
    limit?: number;
    cursor?: string | null;
};
type SelectResponse = {
    data: Record<string, unknown>[];
    nextCursor?: string | null;
};
type SseEvent = {
    eventId: string;
    txId: string;
    tables: Array<{
        name: string;
        type: 'mutation';
        pks: PrimaryKey[];
        rowVersions?: Record<string, number>;
        diffs?: Record<string, {
            set?: Record<string, unknown>;
            unset?: string[];
        }>;
    }>;
};
interface DatabaseAdapter {
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
    updateByPk(table: string, pk: PrimaryKey, set: Record<string, unknown>, opts?: {
        ifVersion?: number;
    }): Promise<Record<string, unknown>>;
    deleteByPk(table: string, pk: PrimaryKey): Promise<{
        ok: true;
    }>;
    selectByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
    selectWindow(table: string, req: SelectWindow & {
        where?: unknown;
    }): Promise<{
        data: Record<string, unknown>[];
        nextCursor?: string | null;
    }>;
}
interface ClientDatastore {
    apply(table: string, pk: PrimaryKey, diff: {
        set?: Record<string, unknown>;
        unset?: string[];
    }): Promise<void>;
    reconcile(table: string, pk: PrimaryKey, row: Record<string, unknown> & {
        version: number;
    }): Promise<void>;
    readByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
    readWindow(table: string, req: SelectWindow & {
        where?: unknown;
    }): Promise<{
        data: Record<string, unknown>[];
        nextCursor?: string | null;
    }>;
}
interface IdempotencyStore {
    get(key: string): Promise<{
        status: 'hit';
        response: unknown;
    } | {
        status: 'miss';
    }>;
    set(key: string, response: unknown, ttlMs: number): Promise<void>;
    acquire?(key: string, ttlMs: number): Promise<{
        ok: true;
    } | {
        ok: false;
    }>;
    release?(key: string): Promise<void>;
}
type MutatorDef<Args, Result> = {
    args?: unknown;
    handler(ctx: {
        db: DatabaseAdapter;
        ctx: Record<string, unknown>;
    }, args: Args): Promise<Result>;
};
type Mutators = Record<string, MutatorDef<any, any>>;
type CreateSyncOptions = {
    schema: Record<string, unknown>;
    database: DatabaseAdapter;
    mutators?: Mutators;
    idempotency?: IdempotencyStore;
    sse?: {
        bufferSeconds?: number;
        bufferMaxEvents?: number;
        heartbeatMs?: number;
    };
};
type SyncInstance = {
    handler: (req: Request) => Promise<Response>;
    fetch: (req: Request) => Promise<Response>;
    defineMutators(m: Mutators): Mutators;
    $mutators: Mutators;
};
declare function createSync(opts: CreateSyncOptions): SyncInstance;
type CreateClientOptions<AppTypes extends {
    Schema?: any;
    Mutators?: any;
} | undefined = undefined> = {
    baseURL: string;
    realtime?: 'sse' | 'poll' | 'off';
    pollIntervalMs?: number;
    datastore?: ClientDatastore;
};
declare function createClient<AppTypes extends {
    Schema?: any;
    Mutators?: any;
} | undefined = undefined>(opts: CreateClientOptions<AppTypes>): any;
declare function createMemoryDatastore(): ClientDatastore;

export { type ClientDatastore, type CreateClientOptions, type CreateSyncOptions, type DatabaseAdapter, type IdempotencyStore, type MutationOp, type MutationRequest, type MutationResponse, type MutatorDef, type Mutators, type OrderBy, type PrimaryKey, type SelectRequest, type SelectResponse, type SelectWindow, type SseEvent, type SyncInstance, createClient, createMemoryDatastore, createSync };
