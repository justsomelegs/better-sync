export type OrderBy = Record<string, "asc" | "desc">;
export type SelectWindow = {
    select?: string[];
    orderBy?: OrderBy;
    limit?: number;
    cursor?: string | null;
};
export type PrimaryKey = string | number | Record<string, string | number>;
export type ClientOptions = {
    baseURL: string;
    realtime?: "sse" | "poll" | "off";
    pollIntervalMs?: number;
};
export declare function createClient<TApp = unknown>(opts: ClientOptions): { [K in string]: ReturnType<(name: string) => {
    readonly select: (pkOrQuery?: PrimaryKey | (SelectWindow & {
        where?: unknown;
    }), opts?: {
        select?: string[];
    }) => Promise<Record<string, unknown> | {
        data: Record<string, unknown>[];
        nextCursor?: string | null;
    } | null>;
    readonly insert: (row: Record<string, unknown>) => Promise<any>;
    readonly update: (pk: PrimaryKey, set: Record<string, unknown>, opts?: {
        ifVersion?: number;
    }) => Promise<any>;
    readonly delete: (pk: PrimaryKey) => Promise<any>;
    readonly watch: (pkOrQuery: PrimaryKey | (SelectWindow & {
        where?: unknown;
    }), cb: (payload: any) => void, opts?: {
        select?: string[];
    }) => {
        readonly unsubscribe: () => boolean;
        readonly status: "connecting";
    };
}>; } & {
    mutators: Record<string, (args: unknown) => Promise<unknown>>;
} & TApp;
