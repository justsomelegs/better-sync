import { createAdapter } from './adapter';
import type { DatabaseAdapter } from '../shared/types';
import { canonicalPk, decodeWindowCursor, encodeWindowCursor, defaultOrderBy, mapSqlErrorToCode } from './utils';
import { SyncError } from '../shared/errors';

export function libsqlAdapter(config: { url: string; authToken?: string }): DatabaseAdapter {
	let txClient: any | null = null;
	const ensuredTables = new Set<string>();
	let metaEnsured = false;
	async function getClient() {
		try {
			const mod: any = await import('@libsql/client');
			return mod.createClient({ url: config.url, authToken: (config as any).authToken });
		} catch (e) {
			const err: any = new SyncError('INTERNAL', 'libsql client not installed. Please add @libsql/client to dependencies.');
			throw err;
		}
	}
	async function run(sql: string, params?: any[]) {
		const c = txClient || await getClient();
		return c.execute({ sql, args: params || [] });
	}
	async function ensureMeta() {
		if (metaEnsured) return;
		await run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
		metaEnsured = true;
	}
	async function ensureTable(table: string, row: Record<string, unknown>) {
		if (ensuredTables.has(table)) return;
		const cols = Object.keys(row).filter((c) => c !== 'version');
		if (cols.length === 0) return;
		const defs = cols.map((c) => c === 'id' ? `${c} TEXT PRIMARY KEY` : `${c} TEXT`).join(',');
		await run(`CREATE TABLE IF NOT EXISTS ${table} (${defs})`);
		ensuredTables.add(table);
	}
	async function ensureMinimalTable(table: string) {
		await run(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, updatedAt INTEGER)`);
	}
	return createAdapter({
		async begin() {
			if (txClient) return;
			const mod: any = await import('@libsql/client');
			txClient = mod.createClient({ url: config.url, authToken: (config as any).authToken });
			await txClient.execute('BEGIN');
		},
		async commit() {
			if (!txClient) return;
			await txClient.execute('COMMIT');
			txClient = null;
		},
		async rollback() {
			if (!txClient) return;
			try { await txClient.execute('ROLLBACK'); } catch {}
			txClient = null;
		},
		async ensureMeta() { await ensureMeta(); },
		async insert(table, row) {
			await ensureMeta();
			await ensureTable(table, row);
			const cols = Object.keys(row).filter((c) => c !== 'version');
			const placeholders = cols.map((_, i) => `?`).join(',');
			const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
			try {
				await run(sql, cols.map((k) => (row as any)[k]));
			} catch (e: any) {
				throw new SyncError(mapSqlErrorToCode(String(e?.message || '')), e?.message || 'insert failed', { table });
			}
			if ((row as any).id != null && typeof (row as any).version === 'number') {
				const id = String((row as any).id);
				await run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (?,?,?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=excluded.version`, [table, id, (row as any).version]);
			}
			return { ...row } as any;
		},
		async updateByPk(table, pk, set, opts) {
			await ensureMeta();
			const key = canonicalPk(pk);
			if (opts?.ifVersion != null) {
				const vres = await run(`SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`, [table, key]);
				const row0 = vres.rows?.[0];
				const metaVer = row0 ? Number(rowFromLibsql(row0)?.version) : null;
				if (metaVer != null && metaVer !== opts.ifVersion) { throw new SyncError('CONFLICT', 'Version mismatch', { expectedVersion: opts.ifVersion, actualVersion: metaVer }); }
			}
			const cols = Object.keys(set).filter((c) => c !== 'version');
			if (cols.length > 0) {
				const assigns = cols.map((c) => `${c} = ?`).join(',');
				const sql = `UPDATE ${table} SET ${assigns} WHERE id = ?`;
				try { await run(sql, [...cols.map((c) => (set as any)[c]), key]); } catch (e: any) { throw new SyncError(mapSqlErrorToCode(String(e?.message || '')), e?.message || 'update failed', { table, pk: key }); }
			}
			if ((set as any).version != null) {
				await run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (?,?,?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=excluded.version`, [table, key, (set as any).version]);
			}
			const res = await run(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [key]);
			if (!res.rows || res.rows.length === 0) { throw new SyncError('NOT_FOUND', 'not found'); }
			const row: any = rowFromLibsql(res.rows[0]);
			const vres = await run(`SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`, [table, key]);
			if (vres.rows?.length) row.version = Number(rowFromLibsql(vres.rows[0])?.version);
			return row;
		},
		async deleteByPk(table, pk) {
			const key = canonicalPk(pk);
			const res = await run(`DELETE FROM ${table} WHERE id = ?`, [key]);
			return { ok: true } as const;
		},
		async selectByPk(table, pk, select) {
			await ensureMeta();
			await ensureMinimalTable(table);
			const key = canonicalPk(pk);
			const res = await run(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [key]);
			if (!res.rows || res.rows.length === 0) return null;
			const full: any = rowFromLibsql(res.rows[0]);
			const vres = await run(`SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1`, [table, key]);
			if (vres.rows?.length) full.version = Number(rowFromLibsql(vres.rows[0])?.version);
			if (!select || select.length === 0) return full;
			const out: any = {}; for (const f of select) out[f] = full[f]; return out;
		},
		async selectWindow(table, req: any) {
			await ensureMeta();
			await ensureMinimalTable(table);
			const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? defaultOrderBy();
			const keys = Object.keys(orderBy);
			let where = '';
			const params: any[] = [];
			const cur = decodeWindowCursor(req.cursor);
			if (cur.lastId) {
				if (keys.length === 1 && keys[0] === 'updatedAt' && (orderBy as any).updatedAt === 'desc') {
					let lastUpdated: number | null = (cur.lastKeys as any)?.updatedAt as any;
					if (lastUpdated == null) {
						const q = await run(`SELECT updatedAt FROM ${table} WHERE id = ? LIMIT 1`, [cur.lastId]);
						lastUpdated = (q.rows && q.rows[0] && (rowFromLibsql(q.rows[0]) as any).updatedAt) ?? 0;
					}
					where = 'WHERE (t.updatedAt < ?) OR (t.updatedAt = ? AND t.id > ?)';
					params.push(lastUpdated, lastUpdated, cur.lastId);
				} else {
					where = 'WHERE t.id > ?';
					params.push(cur.lastId);
				}
			}
			let sql = `SELECT t.* FROM ${table} t ${where}`;
			if (keys.length > 0) {
				const ord = keys.map((k) => `t.${k} ${(orderBy[k] ?? 'asc').toUpperCase()}`).join(', ');
				sql += ` ORDER BY ${ord}, t.id ASC`;
			} else {
				sql += ` ORDER BY t.id ASC`;
			}
			const limit = typeof req.limit === 'number' ? req.limit : 100;
			sql += ` LIMIT ?`; params.push(limit);
			const res = await run(sql, params);
			const rows = (res.rows || []).map(rowFromLibsql);
			let nextCursor: string | null = null;
			if (rows.length === limit) {
				const last = rows[rows.length - 1] as any;
				const lastKeys: Record<string, string | number> = {};
				for (const k of keys) lastKeys[k] = last[k];
				nextCursor = encodeWindowCursor({ table, orderBy, last: { keys: lastKeys, id: String(last.id) } });
			}
			return { data: rows, nextCursor };
		}
	});
}

function rowFromLibsql(row: any): Record<string, unknown> {
	// libsql returns rows with direct property access
	return { ...row } as any;
}

// mapSqlErrorToCode is provided by utils