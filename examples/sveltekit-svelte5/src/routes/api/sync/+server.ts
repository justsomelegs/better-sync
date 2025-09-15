import type { RequestHandler } from '@sveltejs/kit';
import { createSync } from 'just-sync';
import { sqliteAdapter } from 'just-sync/storage/server';
import { z } from 'zod';

const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() })
} as const;

const sync = createSync({ schema, database: sqliteAdapter({ url: 'file:./.data/app.db' }) });

const handler = sync.fetch;

export const GET: RequestHandler = async ({ request }) => handler(request);
export const POST: RequestHandler = async ({ request }) => handler(request);

