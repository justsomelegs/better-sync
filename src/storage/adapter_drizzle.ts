import { createAdapter } from './adapter';
import type { DatabaseAdapter, PrimaryKey } from '../shared/types';

/**
 * Drizzle adapter using native query builder (no raw SQL strings required from the user).
 * Pass only the Drizzle `db`. Table resolution is injected by createSync via a private resolver hook.
 */
export function drizzleAdapter(config: { db: any; idField?: string | Record<string, string> }): DatabaseAdapter {
	const { db } = config;
	let resolveFn: (tableName: string) => any = () => undefined;
    let cachedOps: any | null = null;
    async function ops() {
        if (cachedOps) return cachedOps;
        try {
            const mod: any = await import('drizzle-orm');
            const { eq, gt, asc, desc } = mod;
            cachedOps = { eq, gt, asc, desc };
            return cachedOps;
        } catch (e) {
            const err: any = new Error('drizzle-orm is not installed. Please add drizzle-orm to use drizzleAdapter.');
            (err as any).code = 'INTERNAL';
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

	async function execRaw(sql: string, args?: unknown[]) {
		try { return await Promise.resolve(db.execute?.({ sql, params: args ?? [] }) ?? db.run?.(sql, ...(args ?? [])) ?? db.execute?.(sql) ?? db.run?.(sql)); } catch {}
	}

	const adapter = createAdapter({
		async begin() {},
		async commit() {},
		async rollback() {},
		async ensureMeta() {
			await execRaw('CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))');
		},
		async insert(table, row) {
			const t = resolveFn(table);
			if (!t) { const e: any = new Error(`Unknown table: ${table}`); e.code = 'BAD_REQUEST'; throw e; }
			const idCol = typeof config.idField === 'string' ? config.idField : (config.idField?.[table] ?? 'id');
			await db.insert(t).values(row as any);
			if ((row as any)[idCol] != null && typeof (row as any).version === 'number') {
				await execRaw('INSERT INTO _sync_versions (table_name, pk_canonical, version) VALUES (?,?,?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=excluded.version', [table, String((row as any)[idCol]), (row as any).version]);
			}
			return { ...row } as any;
		},
		async updateByPk(table, pk, set) {
			const key = canonicalPk(pk);
			const cols = Object.keys(set).filter((c) => c !== 'version');
			const t = resolveFn(table);
			if (!t) { const e: any = new Error(`Unknown table: ${table}`); e.code = 'BAD_REQUEST'; throw e; }
			const { eq } = await ops();
			if (cols.length > 0) {
				const values: Record<string, unknown> = {};
				for (const c of cols) values[c] = (set as any)[c];
				await db.update(t).set(values).where(eq((t as any)[(typeof config.idField === 'string' ? config.idField : (config.idField?.[table] ?? 'id'))], key));
			}
			if ((set as any).version != null) {
				await execRaw('INSERT INTO _sync_versions (table_name, pk_canonical, version) VALUES (?,?,?) ON CONFLICT(table_name, pk_canonical) DO UPDATE SET version=excluded.version', [table, key, (set as any).version]);
			}
			const rows = await db.select().from(t).where(eq((t as any)[(typeof config.idField === 'string' ? config.idField : (config.idField?.[table] ?? 'id'))], key)).limit(1);
			if (!rows.length) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
			const full: any = { ...rows[0] };
			try {
				const v = await execRaw('SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1', [table, key]);
				const vrows = Array.isArray(v) ? v : (v && typeof v === 'object' && Array.isArray((v as any).rows) ? (v as any).rows : []);
				if (vrows.length) full.version = Number((vrows[0] as any).version);
			} catch {}
			return full;
		},
		async deleteByPk(table, pk) {
			const t = resolveFn(table);
			if (!t) { const e: any = new Error(`Unknown table: ${table}`); e.code = 'BAD_REQUEST'; throw e; }
			const key = canonicalPk(pk);
			const { eq } = await ops();
			await db.delete(t).where(eq((t as any)[(typeof config.idField === 'string' ? config.idField : (config.idField?.[table] ?? 'id'))], key));
			await execRaw('DELETE FROM _sync_versions WHERE table_name = ? AND pk_canonical = ?', [table, key]);
			return { ok: true } as const;
		},
		async selectByPk(table, pk, selectCols) {
			const t = resolveFn(table);
			if (!t) { const e: any = new Error(`Unknown table: ${table}`); e.code = 'BAD_REQUEST'; throw e; }
			const key = canonicalPk(pk);
			const { eq } = await ops();
			const rows = await db.select().from(t).where(eq((t as any)[(typeof config.idField === 'string' ? config.idField : (config.idField?.[table] ?? 'id'))], key)).limit(1);
			if (!rows.length) return null;
			const full: any = { ...rows[0] };
			try {
				const v = await execRaw('SELECT version FROM _sync_versions WHERE table_name = ? AND pk_canonical = ? LIMIT 1', [table, key]);
				const vrows = Array.isArray(v) ? v : (v && typeof v === 'object' && Array.isArray((v as any).rows) ? (v as any).rows : []);
				if (vrows.length) full.version = Number((vrows[0] as any).version);
			} catch {}
			if (!selectCols || selectCols.length === 0) return full;
			const out: any = {}; for (const f of selectCols) out[f] = full[f]; return out;
		},
		async selectWindow(table, req: any) {
			const t = resolveFn(table);
			if (!t) { const e: any = new Error(`Unknown table: ${table}`); e.code = 'BAD_REQUEST'; throw e; }
			const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? { updatedAt: 'desc' };
			const keys = Object.keys(orderBy);
			const { gt, asc, desc } = await ops();
			const idCol = typeof config.idField === 'string' ? config.idField : (config.idField?.[table] ?? 'id');
			const whereExprs: any[] = [];
			if (req.cursor) {
				try {
					const json = JSON.parse(Buffer.from(String(req.cursor), 'base64').toString('utf8')) as { last?: { id: string } };
					if (json?.last?.id) whereExprs.push(gt((t as any)[idCol], json.last.id));
				} catch {}
			}
			const limit = typeof req.limit === 'number' ? req.limit : 100;
			const orderExprs = keys.length > 0
				? keys.map((k) => (orderBy[k] === 'desc' ? desc((t as any)[k]) : asc((t as any)[k]))).concat(asc((t as any)[idCol]))
				: [asc((t as any)[idCol])];
			const rows = await db
				.select()
				.from(t)
				.where(whereExprs.length ? whereExprs[0] : undefined)
				.orderBy(...orderExprs)
				.limit(limit);
			let nextCursor: string | null = null;
			if (rows.length === limit) {
				const last = rows[rows.length - 1] as any;
				nextCursor = Buffer.from(JSON.stringify({ last: { id: String(last.id) } }), 'utf8').toString('base64');
			}
			return { data: rows.map((r) => ({ ...r })), nextCursor };
		}
	});
	// attach private resolver setter for createSync to bind schema tables
	(Object.assign(adapter as any, { __setResolve: (fn: (name: string) => any) => { resolveFn = fn; } }));
	return adapter;
}

