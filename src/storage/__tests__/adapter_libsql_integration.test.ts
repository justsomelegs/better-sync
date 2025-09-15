import { describe, it, expect } from 'vitest';
import { libsqlAdapter } from '../adapter_libsql';

const HAS_LIBSQL = !!(process.env.LIBSQL_URL || process.env.TURSO_DATABASE_URL);
const LIBSQL_URL = process.env.LIBSQL_URL || process.env.TURSO_DATABASE_URL || '';
const LIBSQL_AUTH = process.env.LIBSQL_AUTH_TOKEN || '';

describe.skipIf(!HAS_LIBSQL)('libsql adapter integration', () => {
	it('creates table and roundtrips a row', async () => {
		// Prepare table using real client
		const mod: any = await import('@libsql/client');
		const client = mod.createClient({ url: LIBSQL_URL, authToken: LIBSQL_AUTH });
		await client.execute(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT, updatedAt INTEGER)`);
		await client.execute(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
		const a = libsqlAdapter({ url: LIBSQL_URL, authToken: LIBSQL_AUTH });
		await a.ensureMeta?.();
		await a.insert('items', { id: 'l1', name: 'lib', updatedAt: Date.now(), version: 1 });
		const row = await a.selectByPk('items', 'l1');
		expect(row).toEqual(expect.objectContaining({ id: 'l1' }));
	});
});

