import { sqlExecutorAdapter, type SqlExecutorConfig } from './adapter_sql_executor';
import type { DatabaseAdapter } from '../shared/types';

/**
 * Wrap a Prisma client via $executeRawUnsafe/$queryRawUnsafe.
 * Caller must ensure the Prisma client is connected and provide table names consistent with schema.
 */
export function prismaAdapter(prisma: any): DatabaseAdapter {
	const executor: SqlExecutorConfig = {
		execute(sql: string, args?: unknown[]) {
			return prisma.$executeRawUnsafe(sql, ...(args ?? []));
		},
		query(sql: string, args?: unknown[]) {
			return prisma.$queryRawUnsafe(sql, ...(args ?? [])).then((rows: any[]) => ({ rows }));
		},
		paramStyle: 'positional',
	};
	return sqlExecutorAdapter(executor);
}

