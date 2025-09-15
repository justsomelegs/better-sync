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
	const base = sqlExecutorAdapter(executor) as DatabaseAdapter;
	return {
		...base,
		async begin() { await prisma.$executeRawUnsafe('BEGIN'); },
		async commit() { await prisma.$executeRawUnsafe('COMMIT'); },
		async rollback() { await prisma.$executeRawUnsafe('ROLLBACK'); },
	};
}

