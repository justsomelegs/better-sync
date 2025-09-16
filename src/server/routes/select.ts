import { createEndpoint } from 'better-call';
import { z } from 'zod';
import type { DatabaseAdapter } from '../../shared/types';

export function buildPostSelect(db: DatabaseAdapter, selectSchema: z.ZodTypeAny) {
	return createEndpoint('/select', {
		method: 'POST',
		body: selectSchema
	}, async (ctx) => {
		const { table, where, select, orderBy, limit, cursor } = ctx.body as any;
		const limNum = typeof limit === 'number' ? Math.min(Math.max(limit, 1), 1000) : undefined;
		let order: Record<string, 'asc' | 'desc'> | undefined = undefined;
		if (orderBy && typeof orderBy === 'object') {
			order = {} as any;
			for (const [k, v] of Object.entries(orderBy)) if (typeof k === 'string' && (v === 'asc' || v === 'desc')) (order as any)[k] = v;
		}
		const { data, nextCursor } = await db.selectWindow(table, { select, orderBy: order as any, limit: limNum, cursor, where });
		return { data, nextCursor: nextCursor ?? null } as any;
	});
}

