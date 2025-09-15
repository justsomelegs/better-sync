import { createAdapter } from './adapter';
import type { DatabaseAdapter, PrimaryKey } from '../shared/types';

type ParamStyle = 'qmark' | 'positional';

export type SqlExecutorConfig = {
	execute(sql: string, args?: unknown[]): Promise<unknown> | unknown;
	query(sql: string, args?: unknown[]): Promise<{ rows: any[] }> | { rows: any[] };
	paramStyle: ParamStyle;
};

function canonicalPk(pk: PrimaryKey): string {
	if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
	const parts = Object.keys(pk)
		.sort()
		.map((k) => `${k}=${String((pk as any)[k])}`);
	return parts.join('|');
}

function makePlaceholderFactory(style: ParamStyle) {
	if (style === 'qmark') {
		return (index: number) => '?';
	}
	return (index: number) => `$${index + 1}`;
}

export function sqlExecutorAdapter(executor: SqlExecutorConfig): DatabaseAdapter {
	const placeholder = makePlaceholderFactory(executor.paramStyle);

	async function run(sql: string, params?: any[]) {
		return await Promise.resolve(executor.execute(sql, params ?? []));
	}

	async function query(sql: string, params?: any[]) {
		return await Promise.resolve(executor.query(sql, params ?? []));
	}

	return createAdapter({
		async ensureMeta() {
			const sql = `CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`;
			await run(sql);
		},
		async begin() {},
		async commit() {},
		async rollback() {},
		async insert(table, row) {
			const cols = Object.keys(row).filter((c) => c !== 'version');
			const values = cols.map((_, i) => placeholder(i)).join(',');
			const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${values})`;
			try {
				await run(sql, cols.map((k) => (row as any)[k]));
			} catch (e: any) {
				const err: any = new Error(e?.message || 'insert failed');
				err.code = mapSqlError(e);
				err.details = { table };
				throw err;
			}
			if ((row as any).id != null && typeof (row as any).version === 'number') {
				const id = String((row as any).id);
				const sqlv = `INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (${placeholder(0)}, ${placeholder(1)}, ${placeholder(2)}) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=excluded.version`;
				await run(sqlv, [table, id, (row as any).version]);
			}
			return { ...row } as any;
		},
		async updateByPk(table, pk, set, _opts) {
			const key = canonicalPk(pk);
			const cols = Object.keys(set).filter((c) => c !== 'version');
			if (cols.length > 0) {
				const assigns = cols.map((c, i) => `${c} = ${placeholder(i)}`).join(',');
				const sql = `UPDATE ${table} SET ${assigns} WHERE id = ${placeholder(cols.length)}`;
				try {
					await run(sql, [...cols.map((c) => (set as any)[c]), key]);
				} catch (e: any) {
					const err: any = new Error(e?.message || 'update failed');
					err.code = mapSqlError(e);
					err.details = { table, pk: key };
					throw err;
				}
			}
			if ((set as any).version != null) {
				const sqlv = `INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES (${placeholder(0)}, ${placeholder(1)}, ${placeholder(2)}) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=excluded.version`;
				await run(sqlv, [table, key, (set as any).version]);
			}
			const sel = await query(`SELECT * FROM ${table} WHERE id = ${placeholder(0)} LIMIT 1`, [key]);
			if (!sel.rows || sel.rows.length === 0) {
				const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e;
			}
			const full = { ...sel.rows[0] } as any;
			const vres = await query(`SELECT version FROM _sync_versions WHERE table_name = ${placeholder(0)} AND pk_canonical = ${placeholder(1)} LIMIT 1`, [table, key]);
			if (vres.rows?.length) full.version = Number((vres.rows[0] as any).version);
			return full;
		},
		async deleteByPk(table, pk) {
			const key = canonicalPk(pk);
			await run(`DELETE FROM ${table} WHERE id = ${placeholder(0)}` , [key]);
			await run(`DELETE FROM _sync_versions WHERE table_name = ${placeholder(0)} AND pk_canonical = ${placeholder(1)}`, [table, key]);
			return { ok: true } as const;
		},
		async selectByPk(table, pk, select) {
			const key = canonicalPk(pk);
			const res = await query(`SELECT * FROM ${table} WHERE id = ${placeholder(0)} LIMIT 1`, [key]);
			if (!res.rows || res.rows.length === 0) return null;
			const full: any = { ...res.rows[0] };
			const vres = await query(`SELECT version FROM _sync_versions WHERE table_name = ${placeholder(0)} AND pk_canonical = ${placeholder(1)} LIMIT 1`, [table, key]);
			if (vres.rows?.length) full.version = Number((vres.rows[0] as any).version);
			if (!select || select.length === 0) return full;
			const out: any = {}; for (const f of select) out[f] = full[f]; return out;
		},
		async selectWindow(table, req: any) {
			const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? { updatedAt: 'desc' };
			const keys = Object.keys(orderBy);
			let where = '';
			const params: any[] = [];
			if (req.cursor) {
				try {
					const json = JSON.parse(Buffer.from(String(req.cursor), 'base64').toString('utf8')) as { last?: { id: string } };
					if (json?.last?.id) { where = `WHERE id > ${placeholder(0)}`; params.push(json.last.id); }
				} catch {}
			}
			let sql = `SELECT * FROM ${table} ${where}`;
			if (keys.length > 0) {
				const ord = keys.map((k) => `${k} ${(orderBy[k] ?? 'asc').toUpperCase()}`).join(', ');
				sql += ` ORDER BY ${ord}, id ASC`;
			} else {
				sql += ` ORDER BY id ASC`;
			}
			const limit = typeof req.limit === 'number' ? req.limit : 100;
			sql += ` LIMIT ${placeholder(params.length)}`; params.push(limit);
			const res = await query(sql, params);
			const rows = (res.rows || []).map((r) => ({ ...r }));
			let nextCursor: string | null = null;
			if (rows.length === limit) {
				const last = rows[rows.length - 1] as any;
				nextCursor = Buffer.from(JSON.stringify({ last: { id: String(last.id) } }), 'utf8').toString('base64');
			}
			return { data: rows, nextCursor };
		}
	});
}

function mapSqlError(e: any): string {
	const msg = String(e?.message || '');
	if (/unique/i.test(msg)) return 'CONFLICT';
	return 'INTERNAL';
}

