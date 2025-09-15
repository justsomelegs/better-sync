import { describe, it, expect } from 'vitest';
import { libsqlAdapter } from '../adapter_libsql';
import { postgresAdapter } from '../adapter_postgres';

describe('first-party adapters scaffold', () => {
	it('libsqlAdapter exposes a DatabaseAdapter and throws on methods', async () => {
		const a = libsqlAdapter({ url: 'libsql://example' } as any);
		expect(typeof a.selectWindow).toBe('function');
		await expect(a.insert('t', { a: 1 })).rejects.toBeInstanceOf(Error);
	});
	it('postgresAdapter exposes a DatabaseAdapter and throws on methods', async () => {
		const a = postgresAdapter({ url: 'postgres://localhost' } as any);
		expect(typeof a.selectByPk).toBe('function');
		await expect(a.deleteByPk('t', 'x')).rejects.toBeInstanceOf(Error);
	});
});