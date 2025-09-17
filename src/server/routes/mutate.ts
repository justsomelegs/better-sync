import { createEndpoint } from 'better-call';
import { z } from 'zod';
import type { DatabaseAdapter, IdempotencyStore, PrimaryKey } from '../../shared/types';
import { SyncError, responseFromError } from '../../shared/errors';

export function buildPostMutate(deps: {
	db: DatabaseAdapter;
	mutateSchema: z.ZodTypeAny;
	getTableSchema: (name: string) => z.ZodObject<any> | undefined;
	getUpdatedAtField: (name: string) => string;
	ulid: () => string;
	idem: IdempotencyStore;
	emit: (type: 'mutation', data: Record<string, unknown>) => void;
  getContext?: (req: Request) => unknown | Promise<unknown>;
}) {
	const { db, mutateSchema, getTableSchema, getUpdatedAtField, ulid, idem, emit } = deps;
	return createEndpoint('/mutate', {
		method: 'POST',
		body: mutateSchema
	}, async (ctx) => {
		const body = ctx.body as any;
		const req = (ctx as unknown as { request?: Request }).request;
		const headerKey = req?.headers.get('Idempotency-Key') || undefined;
		const opId = headerKey ?? body.clientOpId ?? ulid();
		const now = Date.now();
		if (body.op === 'insert' || body.op === 'upsert') {
			const rows = Array.isArray(body.rows) ? body.rows : (body.row ? [body.row] : (body.rows ? [body.rows] : []));
			if (rows.length > 100) { throw new SyncError('BAD_REQUEST', 'Max batch size exceeded', { max: 100 }); }
		}
		if (await Promise.resolve(idem.has(opId))) {
			const prev = await Promise.resolve(idem.get(opId));
			return { ...(prev as object), duplicated: true } as any;
		}
		await db.begin();
		try {
			let result: unknown;
			const txId = ulid();
			if (body.op === 'batch') {
				const results: any[] = [];
				for (const sub of (body.ops as any[])) {
					(ctx as any).body = sub;
					// recursively handle via the same endpoint logic by mutating body
					// Note: for perf, we inline the common cases instead
					if (sub.op === 'insert') {
						const rows = Array.isArray(sub.rows) ? sub.rows : [sub.rows];
						const out: Record<string, unknown>[] = [];
						for (const r of rows) {
							const tableSchema = getTableSchema(sub.table);
							if (tableSchema) {
								const parsed = (tableSchema.partial() as unknown as z.ZodTypeAny).safeParse(r);
								if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
							}
							const providedId = (r as any).id;
							const stampedId = chooseStampedId(ulid, providedId);
							const stamped = { ...r, id: stampedId, [getUpdatedAtField(sub.table)]: now, version: 1 } as Record<string, unknown>;
							out.push(await db.insert(sub.table, stamped));
						}
						results.push({ rows: out });
					} else if (sub.op === 'update') {
						const tableSchema = getTableSchema(sub.table);
						if (tableSchema) {
							const parsed = (tableSchema.partial() as unknown as z.ZodTypeAny).safeParse(sub.set);
							if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
						}
						const existing = await db.selectByPk(sub.table, sub.pk as PrimaryKey);
						const nextVersion = (existing as any)?.version ? Number((existing as any).version) + 1 : 1;
						const row = await db.updateByPk(sub.table, sub.pk as PrimaryKey, { ...sub.set, [getUpdatedAtField(sub.table)]: now, version: nextVersion }, { ifVersion: sub.ifVersion });
						results.push({ row });
					} else if (sub.op === 'delete') {
						results.push(await db.deleteByPk(sub.table, sub.pk as PrimaryKey));
					}
				}
				result = { results };
			}
			if (body.op === 'insert') {
				if (Array.isArray(body.rows)) {
					const out: Record<string, unknown>[] = [];
					const tableSchema = getTableSchema(body.table);
					const validator = tableSchema ? (tableSchema.partial() as unknown as z.ZodTypeAny) : null;
					for (const r of body.rows) {
						if (validator) {
							const parsed = validator.safeParse(r);
							if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
						}
						const providedId = (r as any).id;
						const stampedId = chooseStampedId(ulid, providedId);
						const stamped = { ...r, id: stampedId, [getUpdatedAtField(body.table)]: now, version: 1 } as Record<string, unknown>;
						out.push(await db.insert(body.table, stamped));
					}
					result = { rows: out };
				} else {
					const tableSchema = getTableSchema(body.table);
					if (tableSchema) {
						const parsed = (tableSchema.partial() as unknown as z.ZodTypeAny).safeParse(body.rows);
						if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
					}
					const providedId = (body.rows as any).id;
					const stampedId = chooseStampedId(ulid, providedId);
					const stamped = { ...body.rows, id: stampedId, [getUpdatedAtField(body.table)]: now, version: 1 } as Record<string, unknown>;
					const row = await db.insert(body.table, stamped);
					result = { row };
				}
			}
			if (body.op === 'update') {
				const tableSchema = getTableSchema(body.table);
				if (tableSchema) {
					const parsed = (tableSchema.partial() as unknown as z.ZodTypeAny).safeParse(body.set);
					if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
				}
				const existing = await db.selectByPk(body.table, body.pk as PrimaryKey);
				const nextVersion = (existing as any)?.version ? Number((existing as any).version) + 1 : 1;
				const row = await db.updateByPk(body.table, body.pk as PrimaryKey, { ...body.set, [getUpdatedAtField(body.table)]: now, version: nextVersion }, { ifVersion: body.ifVersion });
				result = { row };
			}
			if (body.op === 'upsert') {
				const single = (body as any).row as Record<string, unknown> | undefined;
				const items = single ? [single] : (Array.isArray((body as any).rows) ? (body as any).rows as Record<string, unknown>[] : [((body as any).rows as Record<string, unknown>)]);
				const out: Record<string, unknown>[] = [];
				const tableSchema = getTableSchema(body.table);
				const validator = tableSchema ? (tableSchema.partial() as unknown as z.ZodTypeAny) : null;
				for (const incoming of items) {
					if (validator) {
						const parsed = validator.safeParse(incoming);
						if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
					}
					const providedId = (incoming as any).id;
					const id = chooseStampedId(ulid, providedId);
					const existing = await db.selectByPk(body.table, id);
					if (!existing) {
						const stamped = { ...incoming, id, [getUpdatedAtField(body.table)]: now, version: 1 } as Record<string, unknown>;
						out.push(await db.insert(body.table, stamped));
					} else {
						const mergeKeys = body.merge;
						if (mergeKeys && mergeKeys.length === 0) { throw new SyncError('CONFLICT', 'insert-only upsert found existing'); }
						const keys = mergeKeys ?? Object.keys(incoming).filter((k) => k !== 'id' && k !== 'updatedAt');
						const set: Record<string, unknown> = {};
						for (const k of keys) set[k] = incoming[k];
						const nextVer = (existing as any)?.version ? Number((existing as any).version) + 1 : 1;
						out.push(await db.updateByPk(body.table, id, { ...set, [getUpdatedAtField(body.table)]: now, version: nextVer }));
					}
				}
				result = single ? { row: out[0] } : (Array.isArray((body as any).rows) ? { rows: out } : { row: out[0] });
			}
			if (body.op === 'delete') {
				const res = await db.deleteByPk(body.table, body.pk as PrimaryKey);
				result = res;
			}
            await db.commit();
            if (body.op === 'insert' || body.op === 'upsert') {
                const rows = Array.isArray((result as any).rows) ? (result as any).rows : [(result as any).row];
                const pks = rows.map((r: any) => r.id);
                const rowVersions: Record<string, number> = {};
                const diffs: Record<string, { set?: Record<string, unknown>; unset?: string[] }> = {};
                for (const r of rows) {
                    if (r.id && typeof r.version === 'number') rowVersions[r.id] = r.version as number;
                    if (r.id) diffs[String(r.id)] = { set: r as any };
                }
                emit('mutation', { txId, tables: [{ name: body.table, pks: pks, rowVersions, diffs }] });
            } else if (body.op === 'update') {
                const rid = (result as any).row?.id ?? canonicalPkValue(body.pk as PrimaryKey);
                const rv: Record<string, number> = {};
                const ver = (result as any).row?.version;
                if (rid && typeof ver === 'number') rv[String(rid)] = ver as number;
                const setFields: Record<string, unknown> = {};
                if (body?.set && typeof body.set === 'object') {
                    for (const k of Object.keys(body.set)) setFields[k] = (body.set as any)[k];
                }
                if ((result as any).row?.updatedAt != null) setFields['updatedAt'] = (result as any).row.updatedAt;
                if (typeof ver === 'number') setFields['version'] = ver;
                const diffs: Record<string, { set?: Record<string, unknown>; unset?: string[] }> = {};
                if (rid) diffs[String(rid)] = { set: setFields };
                emit('mutation', { txId, tables: [{ name: body.table, pks: [rid], rowVersions: rv, diffs }] });
            } else if (body.op === 'delete') {
                emit('mutation', { txId, tables: [{ name: body.table, pks: [typeof body.pk === 'object' ? canonicalPkValue(body.pk as PrimaryKey) : body.pk] }] });
            }
			await Promise.resolve(idem.set(opId, result));
			return result as any;
		} catch (e) {
			await db.rollback();
			return responseFromError(e);
		}
	});
}

function canonicalPkValue(pk: PrimaryKey): string {
	if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
	const parts = Object.keys(pk).sort().map((k) => `${k}=${String((pk as any)[k])}`);
	return parts.join('|');
}

function isValidUlid(id: unknown): id is string {
	return typeof id === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}
function looksLikeCompositeCanonical(id: unknown): id is string {
	return typeof id === 'string' && /[=|]/.test(id);
}
function chooseStampedId(ulidGen: () => string, provided: unknown): string {
	return (isValidUlid(provided) || looksLikeCompositeCanonical(provided)) ? String(provided) : ulidGen();
}

