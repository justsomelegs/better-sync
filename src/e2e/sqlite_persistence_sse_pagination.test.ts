import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createSync } from '../';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';

describe('E2E sqlite persistence + pagination', () => {
	it('persists rows and paginates after server restart', async () => {
		const dbFile = join(tmpdir(), `just_sync_test_${Date.now()}.sqlite`);
		const dbUrl = `file:${dbFile}`;
		const { sqliteAdapter } = await import('../storage/server');
		const schema = { todos: { schema: z.object({ id: z.string().optional(), title: z.string(), updatedAt: z.number().optional() }) } };
		let sync1 = createSync({ schema, database: sqliteAdapter({ url: dbUrl }) as any });
		let server1 = http.createServer(toNodeHandler(sync1.handler));
		await new Promise<void>((resolve) => server1.listen(0, resolve));
		let addr = server1.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port1');
		let base = `http://127.0.0.1:${addr.port}`;
		for (let i = 0; i < 5; i++) {
			const res = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { id: `t${i}`, title: `t${i}` } }) });
			if (!res.ok) { const t = await res.text(); throw new Error(`seed mutate failed: ${res.status} ${t}`); }
		}
		await new Promise<void>((resolve) => server1.close(() => resolve()));
		let sync2 = createSync({ schema, database: sqliteAdapter({ url: dbUrl }) as any });
		let server2 = http.createServer(toNodeHandler(sync2.handler));
		await new Promise<void>((resolve) => server2.listen(0, resolve));
		addr = server2.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port2');
		base = `http://127.0.0.1:${addr.port}`;
		let res1 = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 3 }) });
		let j1 = await res1.json();
		expect(j1.data.length).toBe(3);
		expect(typeof j1.nextCursor === 'string' || j1.nextCursor === null).toBe(true);
		if (j1.nextCursor) {
			const res2 = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 3, cursor: j1.nextCursor }) });
			const j2 = await res2.json();
			expect(j2.data.length).toBeGreaterThan(0);
		}
		await new Promise<void>((resolve) => server2.close(() => resolve()));
	});
});