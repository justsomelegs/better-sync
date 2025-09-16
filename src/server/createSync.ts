import { createEndpoint, createRouter } from 'better-call';
import { z } from 'zod';
import type { DatabaseAdapter, PrimaryKey, IdempotencyStore } from '../shared/types';
import { createMemoryIdempotencyStore } from '../shared/idempotency';
import type { ServerMutatorsSpec } from '../shared/types';
import { monotonicFactory } from 'ulid';
import { createSseStream } from './sse';
import { normalizeSchemaObject } from './utils';
import { responseFromError, SyncError } from '../shared/errors';

const pkObject = z.record(z.string(), z.union([z.string(), z.number()]));
const pkSchema = z.union([z.string(), z.number(), pkObject]) satisfies z.ZodType<PrimaryKey>;

const mutateSchema = z.discriminatedUnion('op', [
	z.object({
		op: z.literal('insert'),
		table: z.string(),
		rows: z.union([z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown())]),
		clientOpId: z.string().optional()
	}),
	z.object({
		op: z.literal('update'),
		table: z.string(),
		pk: pkSchema,
		set: z.record(z.string(), z.unknown()),
		ifVersion: z.number().optional(),
		clientOpId: z.string().optional()
	}),
	z.object({
		op: z.literal('upsert'),
		table: z.string(),
		rows: z.union([z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown())]).optional(),
		row: z.record(z.string(), z.unknown()).optional(),
		merge: z.array(z.string()).optional(),
		clientOpId: z.string().optional()
	}),
	z.object({
		op: z.literal('delete'),
		table: z.string(),
		pk: pkSchema,
		clientOpId: z.string().optional()
	})
]);

const selectSchema = z.object({
	table: z.string(),
	where: z.unknown().optional(),
	select: z.array(z.string()).optional(),
	orderBy: z.record(z.string(), z.enum(['asc', 'desc'])).optional(),
	limit: z.number().optional(),
	cursor: z.union([z.string(), z.null()]).optional()
});

import type { ZodObject, ZodTypeAny } from 'zod';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
function isValidUlid(id: unknown): id is string {
	return typeof id === 'string' && ULID_RE.test(id);
}
function looksLikeCompositeCanonical(id: unknown): id is string {
	return typeof id === 'string' && /[=|]/.test(id);
}
function chooseStampedId(ulidGen: () => string, provided: unknown): string {
	return (isValidUlid(provided) || looksLikeCompositeCanonical(provided)) ? String(provided) : ulidGen();
}

export function createSync<TMutators extends ServerMutatorsSpec = {}>(config: { schema: unknown; database: DatabaseAdapter; mutators?: TMutators; idempotencyStore?: IdempotencyStore; sse?: { keepaliveMs?: number; bufferMs?: number; bufferCap?: number }; autoMigrate?: boolean }) {
	const db = config.database;
	const idem: IdempotencyStore = config.idempotencyStore ?? createMemoryIdempotencyStore();
	let versionCounter = 0;
	const ulid = monotonicFactory();
	const sse = createSseStream({ keepaliveMs: config.sse?.keepaliveMs });

	// Schema normalization
	const tableDefs = normalizeSchemaObject(config.schema);

	if (config.autoMigrate) {
		(async () => {
			try { if (typeof (db as any).ensureMeta === 'function') await (db as any).ensureMeta(); } catch { }
		})();
	}

	if (typeof (db as any).__setResolve === 'function') {
		try { (db as any).__setResolve((name: string) => tableDefs.get(name)?.table); } catch { }
	}

	function getTableSchema(name: string) {
		return tableDefs.get(name)?.schema as any;
	}

	function getUpdatedAtField(name: string): string {
		return tableDefs.get(name)?.updatedAt || 'updatedAt';
	}

	function canonicalPkValue(pk: PrimaryKey): string {
		if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
		const parts = Object.keys(pk).sort().map((k) => `${k}=${String((pk as any)[k])}`);
		return parts.join('|');
	}

	function emit(type: 'mutation', data: Record<string, unknown>) {
		const id = ulid();
		const payload = { eventId: id, txId: data['txId'], tables: data['tables'] };
		const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
		sse.emit(frame, id, config.sse?.bufferMs ?? 60000, config.sse?.bufferCap ?? 10000);
	}

	const getEvents = createEndpoint('/events', { method: 'GET' }, async (ctx) => {
		const req = (ctx as unknown as { request?: Request }).request;
		const since = req?.headers.get('Last-Event-ID') ?? (req ? new URL(req.url).searchParams.get('since') : null) ?? undefined;
		return sse.handler({ bufferMs: config.sse?.bufferMs ?? 60000, cap: config.sse?.bufferCap ?? 10000, lastEventId: since ?? undefined, signal: req?.signal });
	});

	const postMutate = createEndpoint('/mutate', {
		method: 'POST',
		body: mutateSchema
	}, async (ctx) => {
		const body = ctx.body as z.infer<typeof mutateSchema>;
		const opId = body.clientOpId ?? ulid();
		if (await Promise.resolve(idem.has(opId))) {
			const prev = await Promise.resolve(idem.get(opId));
			return { ...(prev as object), duplicated: true } as any;
		}
		await db.begin();
		try {
			let result: unknown;
			const txId = ulid();
			if (body.op === 'insert') {
				if (Array.isArray(body.rows)) {
					const out: Record<string, unknown>[] = [];
					for (const r of body.rows) {
						const tableSchema = getTableSchema(body.table);
						if (tableSchema) {
							const parsed = (tableSchema.partial() as unknown as ZodTypeAny).safeParse(r);
							if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
						}
						const providedId = (r as any).id;
						const stampedId = chooseStampedId(ulid, providedId);
						const stamped = { ...r, id: stampedId, [getUpdatedAtField(body.table)]: Date.now(), version: 1 } as Record<string, unknown>;
						out.push(await db.insert(body.table, stamped));
					}
					result = { rows: out };
				} else {
					const tableSchema = getTableSchema(body.table);
					if (tableSchema) {
						const parsed = (tableSchema.partial() as unknown as ZodTypeAny).safeParse(body.rows);
						if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
					}
					const providedId = (body.rows as any).id;
					const stampedId = chooseStampedId(ulid, providedId);
					const stamped = { ...body.rows, id: stampedId, [getUpdatedAtField(body.table)]: Date.now(), version: 1 } as Record<string, unknown>;
					const row = await db.insert(body.table, stamped);
					result = { row };
				}
			}
			if (body.op === 'update') {
				const tableSchema = getTableSchema(body.table);
				if (tableSchema) {
					const parsed = (tableSchema.partial() as unknown as ZodTypeAny).safeParse(body.set);
					if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
				}
				const existing = await db.selectByPk(body.table, body.pk);
				const nextVersion = (existing as any)?.version ? Number((existing as any).version) + 1 : 1;
				const row = await db.updateByPk(body.table, body.pk, { ...body.set, [getUpdatedAtField(body.table)]: Date.now(), version: nextVersion }, { ifVersion: body.ifVersion });
				result = { row };
			}
			if (body.op === 'upsert') {
				const single = (body as any).row as Record<string, unknown> | undefined;
				const items = single ? [single] : (Array.isArray((body as any).rows) ? (body as any).rows as Record<string, unknown>[] : [((body as any).rows as Record<string, unknown>)]);
				const out: Record<string, unknown>[] = [];
				for (const incoming of items) {
					const tableSchema = getTableSchema(body.table);
					if (tableSchema) {
						const parsed = (tableSchema.partial() as unknown as ZodTypeAny).safeParse(incoming);
						if (!parsed.success) { throw new SyncError('BAD_REQUEST', 'Validation failed', parsed.error.issues); }
					}
					const providedId = (incoming as any).id;
					const id = chooseStampedId(ulid, providedId);
					const existing = await db.selectByPk(body.table, id);
					if (!existing) {
						const stamped = { ...incoming, id, [getUpdatedAtField(body.table)]: Date.now(), version: 1 } as Record<string, unknown>;
						out.push(await db.insert(body.table, stamped));
					} else {
						const mergeKeys = body.merge;
						if (mergeKeys && mergeKeys.length === 0) { throw new SyncError('CONFLICT', 'insert-only upsert found existing'); }
						const keys = mergeKeys ?? Object.keys(incoming).filter((k) => k !== 'id' && k !== 'updatedAt');
						const set: Record<string, unknown> = {};
						for (const k of keys) set[k] = incoming[k];
						const cur = await db.selectByPk(body.table, id);
						const nextVer = (cur as any)?.version ? Number((cur as any).version) + 1 : 1;
						out.push(await db.updateByPk(body.table, id, { ...set, [getUpdatedAtField(body.table)]: Date.now(), version: nextVer }));
					}
				}
				result = single ? { row: out[0] } : (Array.isArray((body as any).rows) ? { rows: out } : { row: out[0] });
			}
			if (body.op === 'delete') {
				const res = await db.deleteByPk(body.table, body.pk);
				result = res;
			}
			await db.commit();
			if (body.op === 'insert' || body.op === 'upsert') {
				const rows = Array.isArray((result as any).rows) ? (result as any).rows : [(result as any).row];
				const pks = rows.map((r: any) => r.id);
				const rowVersions: Record<string, number> = {};
				for (const r of rows) {
					if (r.id && typeof r.version === 'number') rowVersions[r.id] = r.version as number;
				}
				emit('mutation', { txId, tables: [{ name: body.table, type: 'mutation', pks, rowVersions }] });
			} else if (body.op === 'update') {
				const rid = (result as any).row?.id ?? canonicalPkValue(body.pk);
				const rv: Record<string, number> = {};
				const ver = (result as any).row?.version;
				if (rid && typeof ver === 'number') rv[String(rid)] = ver as number;
				emit('mutation', { txId, tables: [{ name: body.table, type: 'mutation', pks: [rid], rowVersions: rv }] });
			} else if (body.op === 'delete') {
				emit('mutation', { txId, tables: [{ name: body.table, type: 'mutation', pks: [typeof body.pk === 'object' ? canonicalPkValue(body.pk) : body.pk] }] });
			}
			await Promise.resolve(idem.set(opId, result));
			return result as any;
		} catch (e: any) {
			await db.rollback();
			return responseFromError(e, { requestId: (ctx as any)?.headers?.get?.('X-Request-Id') });
		}
	});

	const postSelect = createEndpoint('/select', {
		method: 'POST',
		body: selectSchema
	}, async (ctx) => {
		const { table, where, select, orderBy, limit, cursor } = ctx.body;
		const { data, nextCursor } = await db.selectWindow(table, { select, orderBy: orderBy as unknown as Record<string, 'asc' | 'desc'> | undefined, limit, cursor, where });
		return { data, nextCursor: nextCursor ?? null };
	});

	const postMutator = createEndpoint('/mutators/:name', {
		method: 'POST',
		body: z.object({ args: z.unknown().optional(), clientOpId: z.string().optional() })
	}, async (ctx) => {
		const name = (ctx.params as any)?.name as string;
		if (!config.mutators || typeof (config.mutators as any)[name] !== 'object') {
			return responseFromError(new SyncError('NOT_FOUND', 'Mutator not found'));
		}
		const def = (config.mutators as any)[name];
		if (def?.args && typeof def.args.parse !== 'function') {
			return responseFromError(new SyncError('BAD_REQUEST', 'Invalid args schema'));
		}
		let parsed = ctx.body?.args;
		if (def?.args) {
			try { parsed = def.args.parse(ctx.body?.args); } catch (e: any) {
				return responseFromError(new SyncError('BAD_REQUEST', 'Validation failed', e?.issues ?? {}));
			}
		}
		const opId = ctx.body?.clientOpId ?? ulid();
		if (await Promise.resolve(idem.has(opId))) {
			const prev = await Promise.resolve(idem.get(opId));
			return { ...(typeof prev === 'object' && prev && 'result' in (prev as any) ? (prev as any) : { result: prev }), duplicated: true } as any;
		}
		await db.begin();
		try {
			const result = await def.handler({ db, ctx: {} }, parsed);
			await db.commit();
			await Promise.resolve(idem.set(opId, { result }));
			return { result } as any;
		} catch (e) {
			await db.rollback();
			return responseFromError(e);
		}
	});

	const router = createRouter({ getEvents, postMutate, postSelect, postMutator });

	const handler = router.handler;

	const fetch = async (req: Request): Promise<Response> => handler(req);

	return { handler, fetch, mutators: (config.mutators ?? ({} as TMutators)) } as const;
}
