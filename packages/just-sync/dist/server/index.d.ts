export type PrimaryKey = string | number | Record<string, string | number>;
export type OrderBy = Record<string, "asc" | "desc">;
export type SelectWindow = {
    select?: string[];
    orderBy?: OrderBy;
    limit?: number;
    cursor?: string | null;
};
export type MutationOp = {
    op: "insert";
    table: string;
    rows: Record<string, unknown> | Record<string, unknown>[];
} | {
    op: "update";
    table: string;
    pk: PrimaryKey;
    set: Record<string, unknown>;
    ifVersion?: number;
} | {
    op: "delete";
    table: string;
    pk: PrimaryKey;
} | {
    op: "upsert";
    table: string;
    rows: Record<string, unknown> | Record<string, unknown>[];
    merge?: string[];
};
export type MutationRequest = MutationOp & {
    clientOpId?: string;
};
export type MutationResponse = {
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
export type SelectRequest = {
    table: string;
    where?: unknown;
    select?: string[];
    orderBy?: OrderBy;
    limit?: number;
    cursor?: string | null;
};
export type SelectResponse = {
    data: Record<string, unknown>[];
    nextCursor?: string | null;
};
export type SseEvent = {
    eventId: string;
    txId: string;
    tables: Array<{
        name: string;
        type: "mutation";
        pks: PrimaryKey[];
        rowVersions?: Record<string, number>;
        diffs?: Record<string, {
            set?: Record<string, unknown>;
            unset?: string[];
        }>;
    }>;
};
export interface DatabaseAdapter {
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
    eventBufferSec?: number;
};
export declare function createSync(opts: CreateSyncOptions): {
    readonly schema: Record<string, unknown>;
    readonly db: DatabaseAdapter;
    readonly fetch: (req: Request, ctx?: Record<string, unknown>) => Promise<Response>;
    readonly handler: (req: Request) => Promise<Response>;
    readonly nextHandlers: () => {
        GET: (req: Request) => Promise<Response>;
        POST: (req: Request) => Promise<Response>;
    };
    readonly defineMutators: <M extends Mutators>(defs: M) => M;
};
export {};
