import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { sqlExecutorAdapter } from '../adapter_sql_executor';

describe('sqlExecutorAdapter with sql.js', () => {
	it('performs basic CRUD and window query', async () => {
		const SQL = await initSqlJs({ locateFile: (f: string) => `node_modules/sql.js/dist/${f}` });
		const db = new SQL.Database();
		const exec = (sql: string, args?: any[]) => { const stmt = db.prepare(sql); stmt.bind(args || []); const rows: any[] = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; };
		// create table
		exec(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT, updatedAt INTEGER)`);
		exec(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
		const adapter = sqlExecutorAdapter({
			execute: (sql, args) => { exec(sql as string, args as any[]); },
			query: (sql, args) => ({ rows: exec(sql as string, args as any[]) }),
			paramStyle: 'qmark'
		});
		await adapter.ensureMeta?.();
		await adapter.insert('items', { id: 'a', name: 'one', updatedAt: 1, version: 1 });
		await adapter.updateByPk('items', 'a', { name: 'uno', updatedAt: 2, version: 2 });
		const got = await adapter.selectByPk('items', 'a');
		expect(got).toEqual(expect.objectContaining({ id: 'a', name: 'uno', updatedAt: 2, version: 2 }));
		const win = await adapter.selectWindow('items', { limit: 10, orderBy: { updatedAt: 'asc' } } as any);
		expect(Array.isArray(win.data)).toBe(true);
	});
});

