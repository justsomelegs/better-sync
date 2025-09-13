import type { DatabaseAdapter } from "../server";
export declare function sqliteAdapter(opts: {
    url: string;
}): DatabaseAdapter;
