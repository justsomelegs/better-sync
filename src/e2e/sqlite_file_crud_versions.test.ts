import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { createSync } from '../';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';

describe('E2E sqlite file-backed: persistence, CRUD, versions', () => {
	it('persists to disk and retains versions across restarts', async () => {
		const dbFile = join(tmpdir(), `just_sync_file_${Date.now()}.sqlite`);
		const dbUrl = `file:${dbFile}`;
		const { sqliteAdapter } = await import('../storage/server');
		const schema = { todos: { schema: z.object({ id: z.string().optional(), title: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } };

		// First lifecycle: insert rows
		let sync1 = createSync({ schema, database: sqliteAdapter({ url: dbUrl }) as any });
		let server1 = http.createServer(toNodeHandler(sync1.handler));
		await new Promise<void>((resolve) => server1.listen(0, resolve));
		let addr = server1.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port1');
		let base = `http://127.0.0.1:${addr.port}`;
		for (let i = 0; i < 3; i++) {
			const res = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { id: `t${i}`, title: `t${i}` } }) });
			expect(res.ok).toBe(true);
		}
		// Ensure file exists and non-empty
		await new Promise((r) => setTimeout(r, 50));
		const stat1 = await fs.stat(dbFile);
		expect(stat1.size).toBeGreaterThan(0);
		await new Promise<void>((resolve) => server1.close(() => resolve()));

		// Second lifecycle: read and update
		let sync2 = createSync({ schema, database: sqliteAdapter({ url: dbUrl }) as any });
		let server2 = http.createServer(toNodeHandler(sync2.handler));
		await new Promise<void>((resolve) => server2.listen(0, resolve));
		addr = server2.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port2');
		base = `http://127.0.0.1:${addr.port}`;
		let selRes = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 1000 }) });
		let selJson: any = await selRes.json();
		expect(Array.isArray(selJson.data)).toBe(true);
		expect(selJson.data.length).toBeGreaterThanOrEqual(3);
		const t0 = selJson.data.find((r: any) => r.title === 't0');
		expect(!!t0).toBe(true);
		const id0: string = String(t0.id);
		const v0: number | undefined = t0?.version;
		// update t0
		const upRes = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update', table: 'todos', pk: id0, set: { title: 't0-updated' } }) });
		expect(upRes.ok).toBe(true);
		const upJson: any = await upRes.json();
		expect(upJson.row.title).toBe('t0-updated');
		expect(typeof upJson.row.version).toBe('number');
		expect(upJson.row.version).toBeGreaterThan(v0 ?? 0);
		await new Promise<void>((resolve) => server2.close(() => resolve()));

		// Third lifecycle: check version persisted and CAS
		let sync3 = createSync({ schema, database: sqliteAdapter({ url: dbUrl }) as any });
		let server3 = http.createServer(toNodeHandler(sync3.handler));
		await new Promise<void>((resolve) => server3.listen(0, resolve));
		addr = server3.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port3');
		base = `http://127.0.0.1:${addr.port}`;
		selRes = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 1000 }) });
		selJson = await selRes.json();
		const t0b = selJson.data.find((r: any) => r.title === 't0-updated');
		expect(!!t0b).toBe(true);
		const v1: number | undefined = t0b?.version;
		expect((v1 ?? 0)).toBeGreaterThan(v0 ?? 0);
		// CAS mismatch should 409
		const casRes = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update', table: 'todos', pk: String(t0b.id), set: { title: 'fail' }, ifVersion: (v1 ?? 1) + 1 }) });
		expect(casRes.status).toBe(409);
		// delete and verify absence after restart
		const delRes = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', table: 'todos', pk: String(t0b.id) }) });
		expect(delRes.ok).toBe(true);
		await new Promise<void>((resolve) => server3.close(() => resolve()));

		let sync4 = createSync({ schema, database: sqliteAdapter({ url: dbUrl }) as any });
		let server4 = http.createServer(toNodeHandler(sync4.handler));
		await new Promise<void>((resolve) => server4.listen(0, resolve));
		addr = server4.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port4');
		base = `http://127.0.0.1:${addr.port}`;
		const selRes4 = await fetch(`${base}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 'todos', limit: 1000 }) });
		const selJson4: any = await selRes4.json();
		expect(selJson4.data.find((r: any) => r.title === 't0-updated')).toBeUndefined();
		await new Promise<void>((resolve) => server4.close(() => resolve()));
	});
});