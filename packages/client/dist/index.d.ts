type PrimaryKey = string | number | Record<string, string | number>;
type OrderBy = Record<string, 'asc' | 'desc'>;
type SelectWindow = {
    select?: string[];
    orderBy?: OrderBy;
    limit?: number;
    cursor?: string | null;
};
type ClientOptions<TApp = any> = {
    baseURL: string;
    realtime?: 'sse' | 'poll' | 'off';
    pollIntervalMs?: number;
    datastore?: ClientDatastore;
};
export interface ClientDatastore {
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
export declare function memory(): ClientDatastore;
export declare function createClient<TApp = any>(options: ClientOptions<TApp>): any;
export type { ClientOptions, SelectWindow, OrderBy, PrimaryKey };
