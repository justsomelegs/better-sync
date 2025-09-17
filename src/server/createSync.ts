import { createEndpoint, createRouter } from 'better-call';
import { z } from 'zod';
import type { DatabaseAdapter, PrimaryKey, IdempotencyStore } from '../shared/types';
import { createMemoryIdempotencyStore } from '../shared/idempotency';
import type { ServerMutatorsSpec } from '../shared/types';
import { monotonicFactory } from 'ulid';
import { createSseStream } from './sse';
import { normalizeSchemaObject } from './utils';
import { responseFromError, SyncError } from '../shared/errors';
import { withRequestId } from './errors_middleware';
import { buildPostMutate } from './routes/mutate';
import { buildPostSelect } from './routes/select';
import { buildPostMutator } from './routes/mutators';

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

export function createSync<TMutators extends ServerMutatorsSpec = {}>(config: { schema: unknown; database: DatabaseAdapter; mutators?: TMutators; idempotencyStore?: IdempotencyStore; sse?: { keepaliveMs?: number; bufferMs?: number; bufferCap?: number }; autoMigrate?: boolean; context?: (req: Request) => unknown | Promise<unknown> }) {
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
    const enableGzip = req?.headers.get('accept-encoding')?.includes('gzip') ?? false;
    return sse.handler({ bufferMs: config.sse?.bufferMs ?? 60000, cap: config.sse?.bufferCap ?? 10000, lastEventId: since ?? undefined, signal: req?.signal, gzip: enableGzip });
	});

	const postMutate = buildPostMutate({ db, mutateSchema, getTableSchema, getUpdatedAtField, ulid, idem, emit, getContext: config.context });
	const postSelect = buildPostSelect(db, selectSchema);
	const postMutator = buildPostMutator(db, config.mutators, ulid, idem, config.context);

	const router = createRouter({ getEvents, postMutate, postSelect, postMutator });

	const handler = router.handler;

	const fetch = withRequestId(async (req: Request): Promise<Response> => handler(req));

	return { handler: (req: Request) => fetch(req), fetch, mutators: (config.mutators ?? ({} as TMutators)) } as const;
}
