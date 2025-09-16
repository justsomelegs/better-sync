import type { PrimaryKey } from '../shared/types';

export function canonicalPk(pk: PrimaryKey): string {
	if (typeof pk === 'string' || typeof pk === 'number') return String(pk);
	const parts = Object.keys(pk).sort().map((k) => `${k}=${String((pk as any)[k])}`);
	return parts.join('|');
}

export function encodeCursor(lastId: string): string {
	return Buffer.from(JSON.stringify({ last: { id: String(lastId) } }), 'utf8').toString('base64');
}

export function decodeCursor(cursor?: string | null): { lastId?: string } {
	if (!cursor) return {};
	try {
		const json = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8')) as { last?: { id: string } };
		return { lastId: json?.last?.id };
	} catch {
		return {};
	}
}

// Unified window cursor helpers (canonical format)
export type WindowCursorPayload = {
	table: string;
	orderBy: Record<string, 'asc' | 'desc'>;
	last: { keys: Record<string, string | number>; id: string };
};

export function defaultOrderBy(): Record<string, 'asc' | 'desc'> {
	return { updatedAt: 'desc' };
}

export function encodeWindowCursor(payload: WindowCursorPayload): string {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodeWindowCursor(cursor?: string | null): { table?: string; orderBy?: Record<string, 'asc' | 'desc'>; lastId?: string; lastKeys?: Record<string, string | number> } {
	if (!cursor) return {};
	try {
		const json = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8')) as Partial<WindowCursorPayload> & { last?: { id?: string } };
		const lastId = json?.last && 'id' in json.last ? String(json.last.id) : undefined;
		const lastKeys = (json && (json as any).last && typeof (json as any).last.keys === 'object') ? (json as any).last.keys as Record<string, string | number> : undefined;
		return { table: (json as any)?.table, orderBy: (json as any)?.orderBy as any, lastId, lastKeys };
	} catch {
		// Fallback to legacy format { last: { id } }
		const legacy = decodeCursor(cursor);
		return { lastId: legacy.lastId };
	}
}

export function mapSqlErrorToCode(message: string): 'CONFLICT' | 'INTERNAL' {
	if (/unique/i.test(message)) return 'CONFLICT';
	return 'INTERNAL';
}

