import { describe, it, expect } from 'vitest';
import { postgresAdapter } from '../adapter_postgres';

const HAS_PG = !!process.env.PG_URL;
const PG_URL = process.env.PG_URL || '';

describe.skipIf(!HAS_PG)('postgres adapter integration', () => {
	it('creates table and roundtrips a row', async () => {
		const mod: any = await import('pg');
		const { Client } = mod as any;
		const c = new Client({ connectionString: PG_URL });
		await c.connect();
		await c.query(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT, updatedAt BIGINT)`);
		await c.query(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
		await c.end();
		const a = postgresAdapter({ url: PG_URL });
		await a.ensureMeta?.();
		await a.insert('items', { id: 'p1', name: 'pg', updatedAt: Date.now(), version: 1 });
		const row = await a.selectByPk('items', 'p1');
		expect(row).toEqual(expect.objectContaining({ id: 'p1' }));
	});
});

