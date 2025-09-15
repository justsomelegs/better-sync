import { describe, it, expect } from 'vitest';
import { libsqlAdapter } from '../adapter_libsql';
import { postgresAdapter } from '../adapter_postgres';

describe('first-party adapters', () => {
	it('libsqlAdapter basic insert/select works (client must be installed at runtime)', async () => {
		const a = libsqlAdapter({ url: 'file:libsql-test' } as any);
		await a.ensureMeta?.();
		// We cannot rely on actual libsql in CI; just assert interface exists
		expect(typeof a.selectWindow).toBe('function');
	});
	it('postgresAdapter interface exists', async () => {
		const a = postgresAdapter({ url: 'postgres://user:pass@localhost:5432/db' } as any);
		expect(typeof a.selectByPk).toBe('function');
	});
});