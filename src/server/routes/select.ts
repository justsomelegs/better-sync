import { createEndpoint } from 'better-call';
import { z } from 'zod';
import type { DatabaseAdapter } from '../../shared/types';

export function buildPostSelect(db: DatabaseAdapter, selectSchema: z.ZodTypeAny) {
	return createEndpoint('/select', {
		method: 'POST',
		body: selectSchema
	}, async (ctx) => {
		const { table, where, select, orderBy, limit, cursor } = ctx.body as any;
		const { data, nextCursor } = await db.selectWindow(table, { select, orderBy: orderBy as any, limit, cursor, where });
		return { data, nextCursor: nextCursor ?? null } as any;
	});
}

