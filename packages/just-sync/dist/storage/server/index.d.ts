import { DatabaseAdapter } from '../../index.js';

declare function sqliteAdapter(opts: {
    url: string;
}): DatabaseAdapter;

export { sqliteAdapter };
