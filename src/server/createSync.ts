import type { DatabaseAdapter, PrimaryKey, IdempotencyStore } from '../shared/types';
import { createEndpoint, createRouter } from 'better-call';
import { z } from 'zod';
import { createMemoryIdempotencyStore } from '../shared/idempotency';
import { monotonicFactory } from 'ulid';

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
		row: z.record(z.string(), z.unknown()),
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

import type { ServerMutatorsSpec } from '../shared/types';
import type { ZodObject, ZodTypeAny } from 'zod';

// ULID validation (Crockford base32, 26 chars)
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

export function createSync<TMutators extends ServerMutatorsSpec = {}>(config: { schema: unknown; database: DatabaseAdapter; mutators?: TMutators; idempotencyStore?: IdempotencyStore; sse?: { keepaliveMs?: number; bufferMs?: number; bufferCap?: number } }) {
	const db = config.database;
	const idem: IdempotencyStore = config.idempotencyStore ?? createMemoryIdempotencyStore();
	let versionCounter = 0;
	const ulid = monotonicFactory();

	// Schema normalization: map table name -> { schema?: ZodObject<any>, primaryKey?: string[], updatedAt?: string }
	const tableDefs = new Map<string, { schema?: ZodObject<any>; primaryKey?: string[]; updatedAt?: string }>();
	(function normalizeSchema() {
		const s: any = config.schema as any;
		if (!s || typeof s !== 'object') return;
		for (const [key, val] of Object.entries(s)) {
			let schema: ZodObject<any> | undefined;
			let primaryKey: string[] | undefined;
			let updatedAt: string | undefined;
			if (val && typeof val === 'object' && 'schema' in (val as any)) {
				const obj = val as any;
				if (obj.schema && typeof (obj.schema as any).parse === 'function') schema = obj.schema as ZodObject<any>;
				if (Array.isArray(obj.primaryKey)) primaryKey = obj.primaryKey as string[];
				if (typeof obj.updatedAt === 'string') updatedAt = String(obj.updatedAt);
			} else if (val && typeof (val as any).parse === 'function') {
				schema = val as unknown as ZodObject<any>;
			}
			tableDefs.set(key, { schema, primaryKey, updatedAt });
		}
	})();

	function getTableSchema(name: string): ZodObject<any> | undefined {
		return tableDefs.get(name)?.schema;
	}

	function canonicalPkValue(pk: PrimaryKey): string {
		if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
		const parts = Object.keys(pk).sort().map((k) => `${k}=${String((pk as any)[k])}`);
		return parts.join('|');
	}
	const subscribers = new Set<(frame: string) => void>();
	const ring: { id: string; frame: string; ts: number }[] = [];
	function pruneRing(now: number) {
		const windowMs = config.sse?.bufferMs ?? 60000;
		const cap = config.sse?.bufferCap ?? 10000;
		while (ring.length > 0) {
			const first = ring[0];
			if (!first) break;
			if (now - first.ts > windowMs) ring.shift(); else break;
		}
		while (ring.length > cap) ring.shift();
	}
	function emit(type: 'mutation', data: Record<string, unknown>) {
		const id = ulid();
		const payload = { eventId: id, txId: data['txId'], tables: data['tables'] };
		const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
		ring.push({ id, frame, ts: Date.now() });
		pruneRing(Date.now());
		for (const send of subscribers) {
			try { send(frame); } catch { }
		}
	}

	// Endpoints per MVP
	const getEvents = createEndpoint('/events', { method: 'GET' }, async (ctx) => {
		const encoder = new TextEncoder();
		let timer: NodeJS.Timeout | null = null;
		let send: ((frame: string) => void) | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// initial keepalive
				controller.enqueue(encoder.encode(':keepalive\n\n'));
				// resume from Last-Event-ID if provided
				const req = (ctx as unknown as { request?: Request }).request;
				const since = req?.headers.get('Last-Event-ID') ?? (req ? new URL(req.url).searchParams.get('since') : null);
				if (since) {
					const idx = (ring as any).findIndex((e: any) => e.id === since);
					if (idx >= 0) {
						for (const e of (ring as any).slice(idx + 1)) controller.enqueue(encoder.encode(e.frame));
					}
				}
				send = (frame: string) => controller.enqueue(encoder.encode(frame));
				subscribers.add(send);
				const keepaliveMs = config.sse?.keepaliveMs ?? 15000;
				timer = setInterval(() => {
					controller.enqueue(encoder.encode(':keepalive\n\n'));
				}, keepaliveMs);
				const signal = req?.signal;
				if (signal) {
					signal.addEventListener('abort', () => {
						if (timer) clearInterval(timer);
						if (send) subscribers.delete(send);
						try { controller.close(); } catch { }
					});
				}
			},
			cancel() {
				if (timer) clearInterval(timer);
				if (send) subscribers.delete(send);
			}
		});
		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache'
			}
		});
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
							if (!parsed.success) { const e: any = new Error('Validation failed'); e.code = 'BAD_REQUEST'; e.details = parsed.error.issues; throw e; }
						}
						const providedId = (r as any).id;
						const stampedId = chooseStampedId(ulid, providedId);
						const stamped = { ...r, id: stampedId, updatedAt: Date.now(), version: ++versionCounter };
						out.push(await db.insert(body.table, stamped));
					}
					result = { rows: out };
				} else {
					const tableSchema = getTableSchema(body.table);
					if (tableSchema) {
						const parsed = (tableSchema.partial() as unknown as ZodTypeAny).safeParse(body.rows);
						if (!parsed.success) { const e: any = new Error('Validation failed'); e.code = 'BAD_REQUEST'; e.details = parsed.error.issues; throw e; }
					}
					const providedId = (body.rows as any).id;
					const stampedId = chooseStampedId(ulid, providedId);
					const stamped = { ...body.rows, id: stampedId, updatedAt: Date.now(), version: ++versionCounter };
					const row = await db.insert(body.table, stamped);
					result = { row };
				}
			}
			if (body.op === 'update') {
				const tableSchema = getTableSchema(body.table);
				if (tableSchema) {
					const parsed = (tableSchema.partial() as unknown as ZodTypeAny).safeParse(body.set);
					if (!parsed.success) { const e: any = new Error('Validation failed'); e.code = 'BAD_REQUEST'; e.details = parsed.error.issues; throw e; }
				}
				const row = await db.updateByPk(body.table, body.pk, { ...body.set, updatedAt: Date.now(), version: ++versionCounter }, { ifVersion: body.ifVersion });
				result = { row };
			}
			if (body.op === 'upsert') {
				const incoming = body.row as Record<string, unknown>;
				const tableSchema = getTableSchema(body.table);
				if (tableSchema) {
					const parsed = (tableSchema.partial() as unknown as ZodTypeAny).safeParse(incoming);
					if (!parsed.success) { const e: any = new Error('Validation failed'); e.code = 'BAD_REQUEST'; e.details = parsed.error.issues; throw e; }
				}
				const providedId = (incoming as any).id;
				const id = chooseStampedId(ulid, providedId);
				const existing = await db.selectByPk(body.table, id);
				if (!existing) {
					const stamped = { ...incoming, id, updatedAt: Date.now(), version: ++versionCounter };
					const row = await db.insert(body.table, stamped);
					result = { row };
				} else {
					const mergeKeys = body.merge;
					if (mergeKeys && mergeKeys.length === 0) {
						const e: any = new Error('insert-only upsert found existing'); e.code = 'CONFLICT'; throw e;
					}
					const keys = mergeKeys ?? Object.keys(incoming).filter((k) => k !== 'id' && k !== 'updatedAt');
					const set: Record<string, unknown> = {};
					for (const k of keys) set[k] = incoming[k];
					const row = await db.updateByPk(body.table, id, { ...set, updatedAt: Date.now(), version: ++versionCounter });
					result = { row };
				}
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
			const headers = { 'Content-Type': 'application/json' };
			if (e?.code === 'CONFLICT') {
				return new Response(JSON.stringify({ code: 'CONFLICT', message: e.message ?? 'Conflict', details: e.details ?? {} }), { status: 409, headers });
			}
			if (e?.code === 'NOT_FOUND') {
				return new Response(JSON.stringify({ code: 'NOT_FOUND', message: e.message ?? 'Not found', details: e.details ?? {} }), { status: 404, headers });
			}
			if (e?.code === 'BAD_REQUEST') {
				return new Response(JSON.stringify({ code: 'BAD_REQUEST', message: e.message ?? 'Bad request', details: e.details ?? {} }), { status: 400, headers });
			}
			return new Response(JSON.stringify({ code: 'INTERNAL', message: 'Mutation failed' }), { status: 500, headers });
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
			return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Mutator not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
		}
		const def = (config.mutators as any)[name];
		if (def?.args && typeof def.args.parse !== 'function') {
			return new Response(JSON.stringify({ code: 'BAD_REQUEST', message: 'Invalid args schema' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
		}
		let parsed = ctx.body?.args;
		if (def?.args) {
			try { parsed = def.args.parse(ctx.body?.args); } catch (e: any) {
				return new Response(JSON.stringify({ code: 'BAD_REQUEST', message: 'Validation failed', details: e?.issues ?? {} }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
		}
		const opId = ctx.body?.clientOpId ?? ulid();
		if (await Promise.resolve(idem.has(opId))) {
			const prev = await Promise.resolve(idem.get(opId));
			return { ...(prev as object), duplicated: true } as any;
		}
		await db.begin();
		try {
			const result = await def.handler({ db, ctx: {} }, parsed);
			await db.commit();
			await Promise.resolve(idem.set(opId, result));
			return { result } as any;
		} catch (e) {
			await db.rollback();
			return new Response(JSON.stringify({ code: 'INTERNAL', message: 'Mutator failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}
	});

	const router = createRouter({ getEvents, postMutate, postSelect, postMutator });

	const handler = router.handler;

	const fetch = async (req: Request): Promise<Response> => handler(req);

	return { handler, fetch, mutators: (config.mutators ?? ({} as TMutators)) } as const;
}
