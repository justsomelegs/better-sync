import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import http from 'node:http';
import { toNodeHandler } from 'better-call/node';
import initSqlJs from 'sql.js';

const HAS_DRIZZLE = !!process.env.DRIZZLE_E2E;

// Skipped by default; set DRIZZLE_E2E=1 to enable
describe.skipIf(!HAS_DRIZZLE)('E2E: Drizzle + SQLite (sql.js) via drizzleAdapter', () => {
	it('CRUD + versions over HTTP with createSync', async () => {
		const SQL = await initSqlJs({ locateFile: (f: string) => `node_modules/sql.js/dist/${f}` });
		const sdb = new SQL.Database();
		function execAll(sql: string, args?: any[]): any[] {
			const stmt = sdb.prepare(sql);
			stmt.bind(args || []);
			const rows: any[] = [];
			while (stmt.step()) rows.push(stmt.getAsObject());
			stmt.free();
			return rows;
		}
		const { drizzle } = await import('drizzle-orm/sqlite-proxy');
		const db = drizzle(async (sql, params, method) => {
			if (method === 'all' || method === 'get') return execAll(sql, params as any[]);
			execAll(sql, params as any[]);
			return { rowsAffected: 0 } as any;
		});
		// expose minimal raw executor for adapter meta ops
		(db as any).execute = ({ sql, params }: any) => execAll(sql, params);

		const { sqliteTable, text, integer } = await import('drizzle-orm/sqlite-core');
		const todos = sqliteTable('todos', {
			id: text('id').primaryKey(),
			title: text('title'),
			updatedAt: integer('updatedAt')
		});
		// create tables
		execAll(`CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT, updatedAt INTEGER)`);

		const { createSync } = await import('..');
		const { drizzleAdapter } = await import('../storage/adapter_drizzle');
		const sync = createSync({
			schema: {
				todos: { schema: z.object({ id: z.string().optional(), title: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }), table: todos }
			},
			database: drizzleAdapter({ db }) as any,
			autoMigrate: true
		});
		const server = http.createServer(toNodeHandler(sync.handler));
		await new Promise<void>((r) => server.listen(0, r));
		const addr = server.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
		const base = `http://127.0.0.1:${addr.port}`;

		// insert
		let res = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { id: 'd1', title: 'a' } }) });
		expect(res.ok).toBe(true);
		// select
		let sel = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 100 }) });
		let json: any = await sel.json();
		expect(json.data.find((r: any) => r.id === 'd1')).toBeTruthy();
		// update -> version++
		let upd = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update', table: 'todos', pk: 'd1', set: { title: 'b' } }) });
		let uj: any = await upd.json();
		expect(uj.row.title).toBe('b');
		expect(typeof uj.row.version).toBe('number');
		// delete
		let del = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', table: 'todos', pk: 'd1' }) });
		expect(del.ok).toBe(true);

		await new Promise<void>((r) => server.close(() => r()));
	});
});

