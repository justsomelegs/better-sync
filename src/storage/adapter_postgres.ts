import { createAdapter } from './adapter';
import type { DatabaseAdapter } from '../shared/types';

export function postgresAdapter(config: { url: string }): DatabaseAdapter {
	// Placeholder: implement with pg
	return createAdapter({
		async ensureMeta() { /* TODO: create _sync_versions */ },
		async insert() { throwObject('NOT_IMPLEMENTED', 'postgres adapter insert'); },
		async updateByPk() { throwObject('NOT_IMPLEMENTED', 'postgres adapter updateByPk'); },
		async deleteByPk() { throwObject('NOT_IMPLEMENTED', 'postgres adapter deleteByPk'); },
		async selectByPk() { return null; },
		async selectWindow() { return { data: [], nextCursor: null }; }
	});
}

function throwObject(code: 'NOT_IMPLEMENTED' | 'INTERNAL', message: string): never {
	const e: any = new Error(message);
	(e as any).code = code === 'NOT_IMPLEMENTED' ? 'INTERNAL' : code;
	throw e;
}