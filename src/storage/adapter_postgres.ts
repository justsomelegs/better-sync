import { createAdapter } from './adapter';
import type { DatabaseAdapter, PrimaryKey } from '../shared/types';
import { monotonicFactory } from 'ulid';

function canonicalPk(pk: PrimaryKey): string {
	if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
	const parts = Object.keys(pk).sort().map((k) => `${k}=${String((pk as any)[k])}`);
	return parts.join('|');
}

export function postgresAdapter(_config: { url: string }): DatabaseAdapter {
	// Temporary in-memory implementation; to be replaced with real pg client
	const tables = new Map<string, Map<string, any>>();
	const ulid = monotonicFactory();
	return createAdapter({
		async ensureMeta() { /* no-op */ },
		async insert(table, row) {
			const t = tables.get(table) ?? (tables.set(table, new Map()), tables.get(table)!);
			const id = (row as any).id ?? ulid();
			const key = String(id);
			if (t.has(key)) { const e: any = new Error('duplicate'); e.code = 'CONFLICT'; e.details = { constraint: 'unique', column: 'id' }; throw e; }
			const now = Date.now();
			const out = { ...row, id, updatedAt: (row as any).updatedAt ?? now, version: (row as any).version ?? 1 };
			t.set(key, out);
			return out;
		},
		async updateByPk(table, pk, set, opts) {
			const t = tables.get(table) ?? new Map();
			const key = canonicalPk(pk);
			const cur = t.get(key);
			if (!cur) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
			if (opts?.ifVersion && cur.version !== opts.ifVersion) { const e: any = new Error('Version mismatch'); e.code = 'CONFLICT'; e.details = { expectedVersion: opts.ifVersion, actualVersion: cur.version }; throw e; }
			const now = Date.now();
			const out = { ...cur, ...set, updatedAt: now, version: (set as any).version ?? ((cur.version ?? 0) + 1) };
			t.set(key, out);
			return out;
		},
		async deleteByPk(table, pk) {
			const t = tables.get(table) ?? new Map();
			const key = canonicalPk(pk);
			if (!t.has(key)) { const e: any = new Error('not found'); e.code = 'NOT_FOUND'; throw e; }
			t.delete(key);
			return { ok: true } as const;
		},
		async selectByPk(table, pk, select) {
			const t = tables.get(table) ?? new Map();
			const key = canonicalPk(pk);
			const row = t.get(key) ?? null;
			if (!row) return null;
			if (!select || select.length === 0) return row;
			const out: any = {}; for (const f of select) out[f] = row[f]; return out;
		},
		async selectWindow(table, req: any) {
			const t = tables.get(table) ?? new Map<string, any>();
			let rows = Array.from(t.values());
			const orderBy: Record<string, 'asc' | 'desc'> = req.orderBy ?? { updatedAt: 'desc' };
			const keys = Object.keys(orderBy);
			rows.sort((a, b) => {
				for (const k of keys) {
					const dir = orderBy[k]; const va = a[k]; const vb = b[k]; if (va === vb) continue; const cmp = va > vb ? 1 : -1; return dir === 'asc' ? cmp : -cmp;
				}
				return String(a.id).localeCompare(String(b.id));
			});
			const limit = typeof req.limit === 'number' ? req.limit : 100;
			let start = 0;
			if (req.cursor) {
				try { const json = JSON.parse(Buffer.from(String(req.cursor), 'base64').toString('utf8')) as { last?: { id: string } }; const lastId = json?.last?.id; if (lastId) { const idx = rows.findIndex(r => String(r.id) === String(lastId)); if (idx >= 0) start = idx + 1; } } catch { }
			}
			const page = rows.slice(start, start + limit);
			let nextCursor: string | null = null;
			if ((start + limit) < rows.length && page.length > 0) {
				const last = page[page.length - 1];
				nextCursor = Buffer.from(JSON.stringify({ last: { id: String(last.id) } }), 'utf8').toString('base64');
			}
			return { data: page, nextCursor };
		}
	});
}