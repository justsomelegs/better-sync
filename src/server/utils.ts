import type { PrimaryKey } from '../shared/types';
import type { ZodObject } from 'zod';

export function normalizeSchemaObject(raw: unknown): Map<string, { schema?: ZodObject<any>; primaryKey?: string[]; updatedAt?: string; table?: unknown }> {
	const defs = new Map<string, { schema?: ZodObject<any>; primaryKey?: string[]; updatedAt?: string; table?: unknown }>();
	const s: any = raw as any;
	if (!s || typeof s !== 'object') return defs;
	for (const [key, val] of Object.entries(s)) {
		let schema: ZodObject<any> | undefined;
		let primaryKey: string[] | undefined;
		let updatedAt: string | undefined;
		let tableObj: unknown | undefined;
		if (val && typeof val === 'object' && 'schema' in (val as any)) {
			const obj = val as any;
			if (obj.schema && typeof (obj.schema as any).parse === 'function') schema = obj.schema as ZodObject<any>;
			if (Array.isArray(obj.primaryKey)) primaryKey = obj.primaryKey as string[];
			if (typeof obj.updatedAt === 'string') updatedAt = String(obj.updatedAt);
			if (obj.table) tableObj = obj.table;
		} else if (val && typeof (val as any).parse === 'function') {
			schema = val as unknown as ZodObject<any>;
		}
		defs.set(key, { schema, primaryKey, updatedAt, table: tableObj });
	}
	return defs;
}

export function getUpdatedAtFieldFor(tableDefs: Map<string, { updatedAt?: string }>, name: string): string {
	return tableDefs.get(name)?.updatedAt || 'updatedAt';
}

export function canonicalPkValue(pk: PrimaryKey): string {
	if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
	const parts = Object.keys(pk).sort().map((k) => `${k}=${String((pk as any)[k])}`);
	return parts.join('|');
}

