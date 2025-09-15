import { createAdapter } from './adapter';
import type { DatabaseAdapter, PrimaryKey } from '../shared/types';

/**
 * Drizzle adapter. Pass only the Drizzle `db` instance. We lazy-import `drizzle-orm`'s `sql` helper.
 */
export function drizzleAdapter(db: { execute: (q: any) => Promise<any> | any }): DatabaseAdapter {
	let cachedSql: any | null = null;
	async function getSql() {
		if (cachedSql) return cachedSql;
		try {
			const mod: any = await import('drizzle-orm');
			cachedSql = mod.sql;
			return cachedSql;
		} catch (e) {
			const err: any = new Error('drizzle-orm is not installed. Please add drizzle-orm to use drizzleAdapter.');
			err.code = 'INTERNAL';
			throw err;
		}
	}

	function canonicalPk(pk: PrimaryKey): string {
		if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
		const parts = Object.keys(pk)
			.sort()
			.map((k) => `${k}=${String((pk as any)[k])}`);
		return parts.join('|');
	}

	async function run(q: any) { return await Promise.resolve(db.execute(q)); }
	async function select(q: any) {
		const res = await Promise.resolve(db.execute(q));
		if (Array.isArray(res)) return res as any[];
		if (res && typeof res === 'object') {
			if ('rows' in (res as any) && Array.isArray((res as any).rows)) return (res as any).rows;
			if ('rowsAffected' in (res as any) || 'lastInsertRowid' in (res as any)) return [];
		}
		return [];
	}

	return createAdapter({
		async begin() {},
		async commit() {},
		async rollback() {},
		async ensureMeta() {
			const sql = await getSql();
			await run(sql`create table if not exists ${sql.raw('_sync_versions')} (table_name text not null, pk_canonical text not null, version integer not null, primary key (table_name, pk_canonical))`);
		},
		async insert(table, row) {
			const sql = await getSql();
			const cols = Object.keys(row);
			const colList = sql.join(cols.map((c: string) => sql`${sql.raw(c)}`), sql`, `);
			const values = sql.join(cols.map((c: string) => sql`${(row as any)[c]}`), sql`, `);
			await run(sql`insert into ${sql.raw(table)} (${colList}) values (${values})`);
			if ((row as any).id != null && typeof (row as any).version === 'number') {
				await run(sql`insert into ${sql.raw('_sync_versions')} (table_name, pk_canonical, version) values (${table}, ${String((row as any).id)}, ${(row as any).version}) on conflict (table_name, pk_canonical) do update set version = excluded.version`);
			}
			return { ...row } as any;
		},
		async updateByPk(table, pk, set) {
			const sql = await getSql();
			const key = canonicalPk(pk);
			const cols = Object.keys(set).filter((c) => c !== 'version');
			if (cols.length > 0) {
				const assigns = sql.join(cols.map((c: string) => sql`${sql.raw(c)} = ${(set as any)[c]}`), sql`, `);
				await run(sql`update ${sql.raw(table)} set ${assigns} where id = ${key}`);
			}
			if ((set as any).version != null) {
				await run(sql`insert into ${sql.raw('_sync_versions')} (table_name, pk_canonical, version) values (${table}, ${key}, ${(set as any).version}) on conflict (table_name, pk_canonical) do update set version = excluded.version`);
			}
			const rows = await select(sql`select * from ${sql.raw(table)} where id = ${key} limit 1`);
			if (!rows.length) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
			const full: any = { ...rows[0] };
			const v = await select(sql`select version from ${sql.raw('_sync_versions')} where table_name = ${table} and pk_canonical = ${key} limit 1`);
			if (v.length) full.version = Number((v[0] as any).version);
			return full;
		},
		async deleteByPk(table, pk) {
			const sql = await getSql();
			const key = canonicalPk(pk);
			await run(sql`delete from ${sql.raw(table)} where id = ${key}`);
			await run(sql`delete from ${sql.raw('_sync_versions')} where table_name = ${table} and pk_canonical = ${key}`);
			return { ok: true } as const;
		},
		async selectByPk(table, pk, selectCols) {
			const sql = await getSql();
			const key = canonicalPk(pk);
			const rows = await select(sql`select * from ${sql.raw(table)} where id = ${key} limit 1`);
			if (!rows.length) return null;
			const full: any = { ...rows[0] };
			const v = await select(sql`select version from ${sql.raw('_sync_versions')} where table_name = ${table} and pk_canonical = ${key} limit 1`);
			if (v.length) full.version = Number((v[0] as any).version);
			if (!selectCols || selectCols.length === 0) return full;
			const out: any = {}; for (const f of selectCols) out[f] = full[f]; return out;
		},
		async selectWindow(table, req: any) {
			const sql = await getSql();
			const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? { updatedAt: 'desc' };
			const keys = Object.keys(orderBy);
			let whereSql = sql``;
			if (req.cursor) {
				try {
					const json = JSON.parse(Buffer.from(String(req.cursor), 'base64').toString('utf8')) as { last?: { id: string } };
					if (json?.last?.id) whereSql = sql`where id > ${json.last.id}`;
				} catch {}
			}
			let q = sql`select * from ${sql.raw(table)} ${whereSql}`;
			if (keys.length > 0) {
				const ord = sql.join(keys.map((k: string) => sql`${sql.raw(k)} ${sql.raw((orderBy[k] ?? 'asc').toUpperCase())}`), sql`, `);
				q = sql`${q} order by ${ord}, id asc`;
			} else {
				q = sql`${q} order by id asc`;
			}
			const limit = typeof req.limit === 'number' ? req.limit : 100;
			q = sql`${q} limit ${limit}`;
			const rows = await select(q);
			let nextCursor: string | null = null;
			if (rows.length === limit) {
				const last = rows[rows.length - 1] as any;
				nextCursor = Buffer.from(JSON.stringify({ last: { id: String(last.id) } }), 'utf8').toString('base64');
			}
			return { data: rows.map((r) => ({ ...r })), nextCursor };
		}
	});
}

