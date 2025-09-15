import type { Handle } from '@sveltejs/kit';
import { createSync } from 'just-sync';
import { sqliteAdapter } from 'just-sync/storage/server';
import { toSvelteKitHandle } from 'just-sync/sveltekit';
import { z } from 'zod';

const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() })
} as const;

const sync = createSync({ schema, database: sqliteAdapter({ url: 'file:./.data/app.db' }) });

export const handle: Handle = toSvelteKitHandle(sync.fetch, { basePath: '/api/sync' }) as any;

