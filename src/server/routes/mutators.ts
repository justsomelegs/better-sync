import { createEndpoint } from 'better-call';
import { z } from 'zod';
import type { DatabaseAdapter, IdempotencyStore } from '../../shared/types';
import { responseFromError, SyncError } from '../../shared/errors';

export function buildPostMutator(db: DatabaseAdapter, mutators: any | undefined, ulid: () => string, idem: IdempotencyStore, getContext?: (req: Request) => unknown | Promise<unknown>) {
	return createEndpoint('/mutators/:name', {
		method: 'POST',
		body: z.object({ args: z.unknown().optional(), clientOpId: z.string().optional() })
	}, async (ctx) => {
		const name = (ctx.params as any)?.name as string;
		if (!mutators || typeof (mutators as any)[name] !== 'object') {
			return responseFromError(new SyncError('NOT_FOUND', 'Mutator not found'));
		}
		const def = (mutators as any)[name];
		if (def?.args && typeof def.args.parse !== 'function') {
			return responseFromError(new SyncError('BAD_REQUEST', 'Invalid args schema'));
		}
		let parsed = ctx.body?.args;
		if (def?.args) {
			try { parsed = def.args.parse(ctx.body?.args); } catch (e: any) {
				return responseFromError(new SyncError('BAD_REQUEST', 'Validation failed', e?.issues ?? {}));
			}
		}
		const req = (ctx as unknown as { request?: Request }).request;
		const headerKey = req?.headers.get('Idempotency-Key') || undefined;
		const opId = headerKey ?? ctx.body?.clientOpId ?? ulid();
		if (await Promise.resolve(idem.has(opId))) {
			const prev = await Promise.resolve(idem.get(opId));
			return { ...(typeof prev === 'object' && prev && 'result' in (prev as any) ? (prev as any) : { result: prev }), duplicated: true } as any;
		}
		await db.begin();
		try {
			const ctxVal = getContext ? await Promise.resolve(getContext(req as Request)) : {};
			const result = await def.handler({ db, ctx: ctxVal }, parsed);
			await db.commit();
			await Promise.resolve(idem.set(opId, { result }));
			return { result } as any;
		} catch (e) {
			await db.rollback();
			return responseFromError(e);
		}
	});
}

