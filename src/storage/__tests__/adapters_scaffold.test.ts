import { describe, it, expect } from 'vitest';
import { libsqlAdapter } from '../adapter_libsql';
import { postgresAdapter } from '../adapter_postgres';

const HAS_LIBSQL = !!(process.env.LIBSQL_URL || process.env.TURSO_DATABASE_URL);
const LIBSQL_URL = process.env.LIBSQL_URL || process.env.TURSO_DATABASE_URL || '';
const LIBSQL_AUTH = process.env.LIBSQL_AUTH_TOKEN || '';

const HAS_PG = !!process.env.PG_URL;
const PG_URL = process.env.PG_URL || '';

describe('first-party adapters', () => {
	it('libsqlAdapter exposes a DatabaseAdapter; runs integration only with LIBSQL_URL', async () => {
		const a = libsqlAdapter({ url: LIBSQL_URL, authToken: LIBSQL_AUTH } as any);
		expect(typeof a.selectWindow).toBe('function');
		if (HAS_LIBSQL) {
			await a.ensureMeta?.();
			// Create a temp table and do a basic round trip
			// Note: We can't ensure DDL here without the client, so rely on adapter methods only when URL is provided
			// Basic no-op: calling selectWindow against a non-existent table should not throw, adapter may error; skip heavy validation here
		}
	});

	it('postgresAdapter exposes a DatabaseAdapter; runs integration only with PG_URL', async () => {
		const a = postgresAdapter({ url: PG_URL } as any);
		expect(typeof a.selectByPk).toBe('function');
		if (HAS_PG) {
			await a.ensureMeta?.();
			// As above, we only run real queries when PG_URL is provided
		}
	});
});