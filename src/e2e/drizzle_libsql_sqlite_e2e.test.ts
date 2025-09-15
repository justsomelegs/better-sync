import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import http from 'node:http';
import { toNodeHandler } from 'better-call/node';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HAS_LIBSQL = !!process.env.DRIZZLE_E2E;

describe.skipIf(!HAS_LIBSQL)('E2E: Drizzle + libsql file-backed via drizzleAdapter', () => {
	it('CRUD + versions with createSync', async () => {
		const dbFile = join(tmpdir(), `drizzle_libsql_${Date.now()}.db`);
		const url = `file:${dbFile}`;
		const { createClient } = await import('@libsql/client');
		const client = createClient({ url });
		const { drizzle } = await import('drizzle-orm/libsql');
		const db = drizzle(client);
		// create table
		await client.execute(`CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT, updatedAt INTEGER)`);

		const { sqliteTable, text, integer } = await import('drizzle-orm/sqlite-core');
		const todos = sqliteTable('todos', {
			id: text('id').primaryKey(),
			title: text('title'),
			updatedAt: integer('updatedAt')
		});

		const { createSync } = await import('..');
		const { drizzleAdapter } = await import('../storage/adapter_drizzle');
		const sync = createSync({
			schema: { todos: { schema: z.object({ id: z.string().optional(), title: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }), table: todos } },
			database: drizzleAdapter({ db }) as any,
			autoMigrate: true
		});
		const server = http.createServer(toNodeHandler(sync.handler));
		await new Promise<void>((r) => server.listen(0, r));
		const addr = server.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
		const base = `http://127.0.0.1:${addr.port}`;

		let res = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { id: 'd1', title: 'a' } }) });
		expect(res.ok).toBe(true);
		let sel = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 100 }) });
		let json: any = await sel.json();
		expect(json.data.find((r: any) => r.id === 'd1')).toBeTruthy();
		let upd = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update', table: 'todos', pk: 'd1', set: { title: 'b' } }) });
		let uj: any = await upd.json();
		expect(uj.row.title).toBe('b');
		expect(typeof uj.row.version).toBe('number');
		let del = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', table: 'todos', pk: 'd1' }) });
		expect(del.ok).toBe(true);

		await new Promise<void>((r) => server.close(() => r()));
	});
});

