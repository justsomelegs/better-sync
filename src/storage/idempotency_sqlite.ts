import type { IdempotencyStore } from '../shared/types';
import initSqlJs from 'sql.js';
import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export async function createSqliteIdempotencyStore(url: string, opts?: { ttlMs?: number }): Promise<IdempotencyStore> {
	const ttlMs = opts?.ttlMs ?? 10 * 60 * 1000;
	const filePath = url?.startsWith('file:') ? resolvePath(url.slice('file:'.length)) : null;
	const SQL = await initSqlJs({ locateFile: (f: string) => `node_modules/sql.js/dist/${f}` });
	let db = filePath ? await (async () => { try { const buf = await fs.readFile(filePath); return new SQL.Database(new Uint8Array(buf)); } catch { return new SQL.Database(); } })() : new SQL.Database();
	db.run(`CREATE TABLE IF NOT EXISTS _sync_idempotency (key TEXT PRIMARY KEY, value TEXT NOT NULL, expiresAt INTEGER NOT NULL)`);
	async function persist() { if (filePath) { const data = db.export(); await fs.mkdir(resolvePath(filePath, '..'), { recursive: true }).catch(() => { }); await fs.writeFile(filePath, Buffer.from(data)); } }
	return {
		async has(key: string) {
			const stmt = db.prepare('SELECT expiresAt FROM _sync_idempotency WHERE key = ? LIMIT 1');
			stmt.bind([key]); const ok = stmt.step(); let valid = false; if (ok) { const e = (stmt.getAsObject() as any).expiresAt as number; valid = e > Date.now(); } stmt.free(); return valid;
		},
		async get(key: string) {
			const stmt = db.prepare('SELECT value, expiresAt FROM _sync_idempotency WHERE key = ? LIMIT 1');
			stmt.bind([key]); const ok = stmt.step(); if (!ok) { stmt.free(); return undefined; }
			const row: any = stmt.getAsObject(); stmt.free(); if (row.expiresAt <= Date.now()) return undefined; try { return JSON.parse(String(row.value)); } catch { return undefined; }
		},
		async set(key: string, value: unknown) {
			const expiresAt = Date.now() + ttlMs;
			const json = JSON.stringify(value ?? null);
			db.run('INSERT OR REPLACE INTO _sync_idempotency(key,value,expiresAt) VALUES (?,?,?)', [key, json, expiresAt]);
			await persist();
		}
	};
}