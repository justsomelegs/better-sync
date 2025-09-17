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

export function createSync<TMutators extends ServerMutatorsSpec = {}>(config: { schema: unknown; database: DatabaseAdapter; mutators?: TMutators; idempotencyStore?: IdempotencyStore; sse?: { keepaliveMs?: number; bufferMs?: number; bufferCap?: number; payload?: 'full' | 'minimal'; coalesceMs?: number }; autoMigrate?: boolean; context?: (req: Request) => unknown | Promise<unknown> }) {
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
    const payloadMode = config.sse?.payload ?? 'full';
    let tables = data['tables'] as any[];
    if (payloadMode === 'minimal' && Array.isArray(tables)) {
      tables = tables.map((t: any) => ({ name: t?.name, pks: t?.pks }));
    }
    const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ tables })}\n\n`;
    sse.emit(frame, id, config.sse?.bufferMs ?? 60000, config.sse?.bufferCap ?? 10000);
  }

  // Optional coalescing of mutation events into a single SSE frame within a short window
  let pendingTables: Array<{ name: string; type: string; pks?: any[]; rowVersions?: Record<string, number>; diffs?: Record<string, { set?: Record<string, unknown>; unset?: string[] }> }> | null = null;
  let coalesceTimer: NodeJS.Timeout | null = null;
  function mergeTables(base: NonNullable<typeof pendingTables>, incoming: NonNullable<typeof pendingTables>): NonNullable<typeof pendingTables> {
    const byName = new Map<string, any>();
    for (const t of base) byName.set(t.name, { ...t, pks: Array.isArray(t.pks) ? [...t.pks] : [], rowVersions: { ...(t.rowVersions || {}) }, diffs: { ...(t.diffs || {}) } });
    for (const t of incoming) {
      const cur = byName.get(t.name) || { name: t.name, type: t.type, pks: [], rowVersions: {}, diffs: {} };
      if (Array.isArray(t.pks)) {
        const s = new Set<string | number | object>(cur.pks);
        for (const p of t.pks) s.add(p);
        cur.pks = Array.from(s);
      }
      if (t.rowVersions) {
        for (const [rid, ver] of Object.entries(t.rowVersions)) {
          const prev = (cur.rowVersions as any)[rid];
          (cur.rowVersions as any)[rid] = typeof prev === 'number' ? Math.max(prev, ver as number) : (ver as number);
        }
      }
      if (t.diffs) {
        for (const [rid, diff] of Object.entries(t.diffs)) {
          const existing = (cur.diffs as any)[rid] || {};
          const out: any = { ...existing };
          if (diff.set) out.set = { ...(existing.set || {}), ...(diff.set || {}) };
          if (Array.isArray(diff.unset)) out.unset = Array.from(new Set([...(existing.unset || []), ...diff.unset]));
          (cur.diffs as any)[rid] = out;
        }
      }
      byName.set(t.name, cur);
    }
    return Array.from(byName.values());
  }

  const coalesceMs = Math.max(0, Number(config.sse?.coalesceMs ?? 0));
  const sendMutation = (data: Record<string, unknown>) => {
    if (coalesceMs <= 0) return emit('mutation', data);
    const incoming = (data['tables'] as any[]) || [];
    pendingTables = pendingTables ? mergeTables(pendingTables, incoming) : [...incoming];
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(() => {
        const tables = pendingTables || [];
        pendingTables = null;
        coalesceTimer = null;
        emit('mutation', { tables });
      }, coalesceMs);
    }
  };

  const getEvents = createEndpoint('/events', { method: 'GET' }, async (ctx) => {
		const req = (ctx as unknown as { request?: Request }).request;
		const since = req?.headers.get('Last-Event-ID') ?? (req ? new URL(req.url).searchParams.get('since') : null) ?? undefined;
		return sse.handler({ bufferMs: config.sse?.bufferMs ?? 60000, cap: config.sse?.bufferCap ?? 10000, lastEventId: since ?? undefined, signal: req?.signal });
	});

  const postMutate = buildPostMutate({ db, mutateSchema, getTableSchema, getUpdatedAtField, ulid, idem, emit: (_t, data) => sendMutation(data), getContext: config.context });
	const postSelect = buildPostSelect(db, selectSchema);
	const postMutator = buildPostMutator(db, config.mutators, ulid, idem, config.context);

	const router = createRouter({ getEvents, postMutate, postSelect, postMutator });

	const handler = router.handler;

	const fetch = withRequestId(async (req: Request): Promise<Response> => handler(req));

	return { handler: (req: Request) => fetch(req), fetch, mutators: (config.mutators ?? ({} as TMutators)) } as const;
}
