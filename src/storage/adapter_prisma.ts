import { createAdapter } from './adapter';
import type { DatabaseAdapter, PrimaryKey } from '../shared/types';
import { canonicalPk, decodeWindowCursor, encodeWindowCursor } from './utils';
import { SyncError } from '../shared/errors';

/**
 * Wrap a Prisma client via $executeRawUnsafe/$queryRawUnsafe.
 * Caller must ensure the Prisma client is connected and provide table names consistent with schema.
 */
export function prismaAdapter(prisma: any): DatabaseAdapter {
	async function run(sql: string, args?: any[]) { return prisma.$executeRawUnsafe(sql, ...(args ?? [])); }
	async function query(sql: string, args?: any[]) { const rows = await prisma.$queryRawUnsafe(sql, ...(args ?? [])); return { rows }; }
	return createAdapter({
		async ensureMeta() {
			await run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
		},
		async begin() { await prisma.$executeRawUnsafe('BEGIN'); },
		async commit() { await prisma.$executeRawUnsafe('COMMIT'); },
		async rollback() { await prisma.$executeRawUnsafe('ROLLBACK'); },
		async insert(table, row) {
			const cols = Object.keys(row);
			const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
			const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
			await run(sql, cols.map((k) => (row as any)[k]));
			if ((row as any).id != null && typeof (row as any).version === 'number') {
				await run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES ($1,$2,$3) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=EXCLUDED.version`, [table, String((row as any).id), (row as any).version]);
			}
			return { ...row } as any;
		},
		async updateByPk(table, pk: PrimaryKey, set, opts) {
			const key = canonicalPk(pk);
			if (opts?.ifVersion != null) {
				const v = await query(`SELECT version FROM _sync_versions WHERE table_name = $1 AND pk_canonical = $2 LIMIT 1`, [table, key]);
				const metaVer = v.rows?.length ? Number((v.rows[0] as any).version) : null;
				if (metaVer != null && metaVer !== opts.ifVersion) { throw new SyncError('CONFLICT', 'Version mismatch', { expectedVersion: opts.ifVersion, actualVersion: metaVer }); }
			}
			const cols = Object.keys(set).filter((c) => c !== 'version');
			if (cols.length > 0) {
				const assigns = cols.map((c, i) => `${c} = $${i + 1}`).join(',');
				await run(`UPDATE ${table} SET ${assigns} WHERE id = $${cols.length + 1}`, [...cols.map((c) => (set as any)[c]), key]);
			}
			if ((set as any).version != null) {
				await run(`INSERT INTO _sync_versions(table_name, pk_canonical, version) VALUES ($1,$2,$3) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=EXCLUDED.version`, [table, key, (set as any).version]);
			}
			const sel = await query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [key]);
			if (!sel.rows?.length) throw new SyncError('NOT_FOUND', 'not found');
			const full: any = { ...sel.rows[0] };
			const vr = await query(`SELECT version FROM _sync_versions WHERE table_name = $1 AND pk_canonical = $2 LIMIT 1`, [table, key]);
			if (vr.rows?.length) full.version = Number((vr.rows[0] as any).version);
			return full;
		},
		async deleteByPk(table, pk) {
			const key = canonicalPk(pk);
			await run(`DELETE FROM ${table} WHERE id = $1`, [key]);
			await run(`DELETE FROM _sync_versions WHERE table_name = $1 AND pk_canonical = $2`, [table, key]);
			return { ok: true } as const;
		},
		async selectByPk(table, pk, select) {
			const key = canonicalPk(pk);
			const res = await query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [key]);
			if (!res.rows?.length) return null;
			const full: any = { ...res.rows[0] };
			const vres = await query(`SELECT version FROM _sync_versions WHERE table_name = $1 AND pk_canonical = $2 LIMIT 1`, [table, key]);
			if (vres.rows?.length) full.version = Number((vres.rows[0] as any).version);
			if (!select || select.length === 0) return full;
			const out: any = {}; for (const f of select) out[f] = full[f]; return out;
		},
		async selectWindow(table, req: any) {
			const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? { updatedAt: 'desc' };
			const keys = Object.keys(orderBy);
			const cur = decodeWindowCursor(req.cursor);
			let where = '';
			const params: any[] = [];
			if (cur.lastId) { where = 'WHERE id > $1'; params.push(cur.lastId); }
			let sql = `SELECT * FROM ${table} ${where}`;
			if (keys.length > 0) {
				const ord = keys.map((k) => `${k} ${(orderBy[k] ?? 'asc').toUpperCase()}`).join(', ');
				sql += ` ORDER BY ${ord}, id ASC`;
			} else {
				sql += ` ORDER BY id ASC`;
			}
			const limit = typeof req.limit === 'number' ? req.limit : 100;
			sql += ` LIMIT $${params.length + 1}`; params.push(limit);
			const res = await query(sql, params);
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

