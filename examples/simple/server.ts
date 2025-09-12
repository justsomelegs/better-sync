import { createSync, z } from '@sync/core';
import { sqliteAdapter } from '@sync/adapter-sqlite';
import { schema } from './schema.js';

const sync = createSync({ schema, database: sqliteAdapter({ url: 'app.db' }), mutators: {
  addTodo: {
    args: z.object({ title: z.string().min(1) }),
    handler: async ({ db }, { title }) => {
      const row = await db.insert('todos', { title, done: false });
      return row as any;
    }
  }
} });

export const handler = sync.fetch;
