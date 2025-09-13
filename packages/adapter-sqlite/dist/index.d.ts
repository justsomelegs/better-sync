import type { DatabaseAdapter } from '@sync/core';
type SqliteAdapterOptions = {
    url: string;
};
export declare function sqliteAdapter(options: SqliteAdapterOptions): DatabaseAdapter;
export type { SqliteAdapterOptions };
