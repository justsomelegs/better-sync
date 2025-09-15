import { createAdapter } from './adapter';
import type { DatabaseAdapter, PrimaryKey } from '../shared/types';

/**
 * Drizzle adapter. Requires caller to pass their drizzle db and the `sql` helper.
 * Works with any driver as long as `execute(sql)` returns driver result and `query(sql)` returns rows.
 */
export function drizzleAdapter(config: { db: { execute: (q: any) => Promise<any> | any; query: (q: any) => Promise<any[]> | any[] }; sql: any }): DatabaseAdapter {
	const { db, sql } = config;

	function canonicalPk(pk: PrimaryKey): string {
		if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
		const parts = Object.keys(pk)
			.sort()
			.map((k) => `${k}=${String((pk as any)[k])}`);
		return parts.join('|');
	}

	async function run(q: any) {
		return await Promise.resolve(db.execute(q));
	}

	async function select(q: any) {
		const rows = await Promise.resolve(db.query(q));
		return Array.isArray(rows) ? rows : (rows as any).rows ?? [];
	}

	return createAdapter({
		async begin() {},
		async commit() {},
		async rollback() {},
		async ensureMeta() {
			await run(sql`create table if not exists ${sql.raw('_sync_versions')} (table_name text not null, pk_canonical text not null, version integer not null, primary key (table_name, pk_canonical))`);
		},
		async insert(table, row) {
			const cols = Object.keys(row);
			const colList = sql.join(cols.map((c) => sql`${sql.raw(c)}`), sql`, `);
			const values = sql.join(cols.map((c) => sql`${(row as any)[c]}`), sql`, `);
			await run(sql`insert into ${sql.raw(table)} (${colList}) values (${values})`);
			if ((row as any).id != null && typeof (row as any).version === 'number') {
				await run(sql`insert into ${sql.raw('_sync_versions')} (table_name, pk_canonical, version) values (${table}, ${String((row as any).id)}, ${(row as any).version}) on conflict (table_name, pk_canonical) do update set version = excluded.version`);
			}
			return { ...row } as any;
		},
		async updateByPk(table, pk, set) {
			const key = canonicalPk(pk);
			const cols = Object.keys(set).filter((c) => c !== 'version');
			if (cols.length > 0) {
				const assigns = sql.join(cols.map((c) => sql`${sql.raw(c)} = ${(set as any)[c]}`), sql`, `);
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
			const key = canonicalPk(pk);
			await run(sql`delete from ${sql.raw(table)} where id = ${key}`);
			await run(sql`delete from ${sql.raw('_sync_versions')} where table_name = ${table} and pk_canonical = ${key}`);
			return { ok: true } as const;
		},
		async selectByPk(table, pk, selectCols) {
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
				const ord = sql.join(keys.map((k) => sql`${sql.raw(k)} ${sql.raw((orderBy[k] ?? 'asc').toUpperCase())}`), sql`, `);
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

