import { createAdapter } from './adapter';
import type { DatabaseAdapter } from '../shared/types';
import { canonicalPk, decodeCursor, encodeCursor, mapSqlErrorToCode } from './utils';

export function libsqlAdapter(config: { url: string; authToken?: string }): DatabaseAdapter {
	async function getClient() {
		try {
			const mod: any = await import('@libsql/client');
			return mod.createClient({ url: config.url, authToken: (config as any).authToken });
		} catch (e) {
			const err: any = new Error('libsql client not installed. Please add @libsql/client to dependencies.');
			(err as any).code = 'INTERNAL';
			throw err;
		}
	}
	async function run(sql: string, params?: any[]) {
		const c = await getClient();
		return c.execute({ sql, args: params || [] });
	}
	return createAdapter({
		async ensureMeta() {
			await run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
		},
		async insert(table, row) {
			const cols = Object.keys(row);
			const placeholders = cols.map((_, i) => `?`).join(',');
			const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
			try {
				await run(sql, cols.map((k) => (row as any)[k]));
			} catch (e: any) {
				const err: any = new Error(e?.message || 'insert failed'); err.code = mapSqlErrorToCode(String(e?.message || '')); err.details = { table }; throw err;
			}
			if ((row as any).id != null && typeof (row as any).version === 'number') {
				const id = String((row as any).id);
				await run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (?,?,?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=excluded.version`, [table, id, (row as any).version]);
			}
			return { ...row } as any;
		},
		async updateByPk(table, pk, set, opts) {
			const key = canonicalPk(pk);
			const cols = Object.keys(set).filter((c) => c !== 'version');
			if (cols.length > 0) {
				const assigns = cols.map((c) => `${c} = ?`).join(',');
				const sql = `UPDATE ${table} SET ${assigns} WHERE id = ?`;
				try { await run(sql, [...cols.map((c) => (set as any)[c]), key]); } catch (e: any) { const err: any = new Error(e?.message || 'update failed'); err.code = mapSqlErrorToCode(String(e?.message || '')); err.details = { table, pk: key }; throw err; }
			}
			if ((set as any).version != null) {
				await run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (?,?,?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=excluded.version`, [table, key, (set as any).version]);
			}
			const res = await run(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [key]);
			if (!res.rows || res.rows.length === 0) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
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
			const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? { updatedAt: 'desc' };
			const keys = Object.keys(orderBy);
			let where = '';
			const params: any[] = [];
			const { lastId } = decodeCursor(req.cursor);
			if (lastId) { where = 'WHERE id > ?'; params.push(lastId); }
			let sql = `SELECT * FROM ${table} ${where}`;
			if (keys.length > 0) {
				const ord = keys.map((k) => `${k} ${(orderBy[k] ?? 'asc').toUpperCase()}`).join(', ');
				sql += ` ORDER BY ${ord}, id ASC`;
			} else {
				sql += ` ORDER BY id ASC`;
			}
			const limit = typeof req.limit === 'number' ? req.limit : 100;
			sql += ` LIMIT ?`; params.push(limit);
			const res = await run(sql, params);
			const rows = (res.rows || []).map(rowFromLibsql);
			let nextCursor: string | null = null;
			if (rows.length === limit) { const last = rows[rows.length - 1]; nextCursor = encodeCursor(String((last as any).id)); }
			return { data: rows, nextCursor };
		}
	});
}

function rowFromLibsql(row: any): Record<string, unknown> {
	// libsql returns rows with direct property access
	return { ...row } as any;
}

// mapSqlErrorToCode is provided by utils