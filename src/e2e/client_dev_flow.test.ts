import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { createSync } from '../';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createClient } from '../shared/createClient';

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

describe('Developer E2E: client + sqlite + mutators + watch', () => {
	it('performs inserts, mutator calls, select, and receives watch updates', async () => {
		const { sqliteAdapter } = await import('../storage/server');
		const schema = { todos: { schema: z.object({ id: z.string().optional(), title: z.string(), updatedAt: z.number().optional() }) } };
		const sync = createSync({ schema, database: sqliteAdapter({ url: 'file:' }) as any, mutators: {
			addTodo: { args: z.object({ title: z.string().min(1) }), handler: async ({ db }: any, { title }: { title: string }) => db.insert('todos', { title }) }
		}});
		const server = http.createServer(toNodeHandler(sync.handler));
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const addr = server.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port');
		const baseURL = `http://127.0.0.1:${addr.port}`;
		const client = createClient({ baseURL, mutators: sync.mutators });

		const sel0 = await client.todos.select({});
		expect(sel0.data.length).toBe(0);
		let updated = false;
		const stop = client.todos.watch((evt) => { if ((evt as any).data && (evt as any).data.length >= 1) updated = true; });
		await client.todos.insert({ title: 'first' });
		await client.mutators.addTodo({ title: 'second' } as any);
		const t0 = Date.now();
		while (!updated) {
			if (Date.now() - t0 > 3000) throw new Error('timeout waiting watch');
			await delay(50);
		}
		stop();
		const sel1 = await client.todos.select({});
		expect(sel1.data.length).toBeGreaterThanOrEqual(2);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
});