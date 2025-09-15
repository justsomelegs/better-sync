import { createAdapter } from './adapter';
import type { DatabaseAdapter, PrimaryKey } from '../shared/types';

export function libsqlAdapter(config: { url: string; authToken?: string }): DatabaseAdapter {
	// Placeholder: implement with libsql client (e.g., @libsql/client)
	return createAdapter({
		async ensureMeta() { /* TODO */ },
		async insert() { throwObject('NOT_IMPLEMENTED', 'libsql adapter insert'); },
		async updateByPk() { throwObject('NOT_IMPLEMENTED', 'libsql adapter updateByPk'); },
		async deleteByPk() { throwObject('NOT_IMPLEMENTED', 'libsql adapter deleteByPk'); },
		async selectByPk() { return null; },
		async selectWindow() { return { data: [], nextCursor: null }; }
	});
}

function throwObject(code: 'NOT_IMPLEMENTED' | 'INTERNAL', message: string): never {
	const e: any = new Error(message);
	(e as any).code = code === 'NOT_IMPLEMENTED' ? 'INTERNAL' : code;
	throw e;
}