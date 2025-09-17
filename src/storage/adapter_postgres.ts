import { createAdapter } from './adapter';
import type { DatabaseAdapter, PrimaryKey } from '../shared/types';
import { canonicalPk, decodeWindowCursor, encodeWindowCursor, defaultOrderBy, mapSqlErrorToCode } from './utils';
import { SyncError } from '../shared/errors';

// canonicalPk provided by utils

export function postgresAdapter(config: { url: string }): DatabaseAdapter {
	let txClient: any | null = null;
	async function getClient() {
		if (txClient) return txClient;
		try {
			const mod: any = await import('pg');
			const { Client } = mod as any;
			const c = new Client({ connectionString: config.url });
			await c.connect();
			return c;
		} catch (e) {
			const err: any = new SyncError('INTERNAL', 'pg client not installed or cannot connect.'); throw err;
		}
	}
	async function run(sql: string, params?: any[]) {
		const c = await getClient();
		const inTx = !!txClient;
		try { const res = await c.query(sql, params || []); if (!inTx) await c.end(); return res; } catch (e) { if (!inTx) await c.end(); throw e; }
	}
	return createAdapter({
		async begin() {
			if (txClient) return;
			const mod: any = await import('pg');
			const { Client } = mod as any;
			txClient = new Client({ connectionString: config.url });
			await txClient.connect();
			await txClient.query('BEGIN');
		},
		async commit() {
			if (!txClient) return;
			await txClient.query('COMMIT');
			await txClient.end();
			txClient = null;
		},
		async rollback() {
			if (!txClient) return;
			try { await txClient.query('ROLLBACK'); } catch {}
			await txClient.end();
			txClient = null;
		},
		async ensureMeta() {
			await run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
		},
		async insert(table, row) {
			const cols = Object.keys(row);
			const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
			const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
			try { await run(sql, cols.map((k) => (row as any)[k])); } catch (e: any) { throw new SyncError(mapSqlErrorToCode(String(e?.message || '')), e?.message || 'insert failed', { table }); }
			if ((row as any).id != null && typeof (row as any).version === 'number') {
				const id = String((row as any).id);
				await run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES ($1,$2,$3) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=EXCLUDED.version`, [table, id, (row as any).version]);
			}
			return { ...row } as any;
		},
		async updateByPk(table, pk, set, opts) {
			const key = canonicalPk(pk);
			if (opts?.ifVersion != null) {
				const vres = await run(`SELECT version FROM _sync_versions WHERE table_name = $1 AND pk_canonical = $2 LIMIT 1`, [table, key]);
				const metaVer = vres.rows?.length ? Number((vres.rows[0] as any).version) : null;
				if (metaVer != null && metaVer !== opts.ifVersion) { throw new SyncError('CONFLICT', 'Version mismatch', { expectedVersion: opts.ifVersion, actualVersion: metaVer }); }
			}
			const cols = Object.keys(set).filter((c) => c !== 'version');
			if (cols.length > 0) {
				const assigns = cols.map((c, i) => `${c} = $${i + 1}`).join(',');
				const sql = `UPDATE ${table} SET ${assigns} WHERE id = $${cols.length + 1}`;
				try { await run(sql, [...cols.map((c) => (set as any)[c]), key]); } catch (e: any) { throw new SyncError(mapSqlErrorToCode(String(e?.message || '')), e?.message || 'update failed', { table, pk: key }); }
			}
			if ((set as any).version != null) {
				await run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES ($1,$2,$3) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=EXCLUDED.version`, [table, key, (set as any).version]);
			}
			const res = await run(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [key]);
			if (!res.rows || res.rows.length === 0) { throw new SyncError('NOT_FOUND', 'not found'); }
			const row: any = { ...res.rows[0] };
			const vres = await run(`SELECT version FROM _sync_versions WHERE table_name = $1 AND pk_canonical = $2 LIMIT 1`, [table, key]);
			if (vres.rows?.length) row.version = Number(vres.rows[0]?.version);
			return row;
		},
		async deleteByPk(table, pk) {
			const key = canonicalPk(pk);
			await run(`DELETE FROM ${table} WHERE id = $1`, [key]);
			await run(`DELETE FROM _sync_versions WHERE table_name = $1 AND pk_canonical = $2`, [table, key]);
			return { ok: true } as const;
		},
		async selectByPk(table, pk, select) {
			const key = canonicalPk(pk);
			const res = await run(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [key]);
			if (!res.rows || res.rows.length === 0) return null;
			const full: any = { ...res.rows[0] };
			const vres = await run(`SELECT version FROM _sync_versions WHERE table_name = $1 AND pk_canonical = $2 LIMIT 1`, [table, key]);
			if (vres.rows?.length) full.version = Number(vres.rows[0]?.version);
			if (!select || select.length === 0) return full;
			const out: any = {}; for (const f of select) out[f] = full[f]; return out;
		},
		async selectWindow(table, req: any) {
			const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? defaultOrderBy();
			const keys = Object.keys(orderBy);
			let where = '';
			const params: any[] = [];
			const cur = decodeWindowCursor(req.cursor);
			if (cur.lastId) {
				if (keys.length === 1 && keys[0] === 'updatedAt' && (orderBy as any).updatedAt === 'desc') {
					let lastUpdated: number | null = (cur.lastKeys as any)?.updatedAt as any;
					if (lastUpdated == null) {
						const q = await run(`SELECT updatedAt FROM ${table} WHERE id = $1 LIMIT 1`, [cur.lastId]);
						lastUpdated = (q.rows && q.rows[0] && (q.rows[0] as any).updatedat) ?? (q.rows[0] as any)?.updatedAt ?? 0;
					}
					where = 'WHERE (t.updatedAt < $1) OR (t.updatedAt = $1 AND t.id > $2)';
					params.push(lastUpdated, cur.lastId);
				} else {
					where = 'WHERE t.id > $1';
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
			sql += ` LIMIT $${params.length + 1}`; params.push(limit);
			const res = await run(sql, params);
			const rows = (res.rows || []).map((r) => ({ ...r }));
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

// unified error mapping handled by utils