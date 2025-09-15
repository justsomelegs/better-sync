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

export function mapSqlErrorToCode(message: string): 'CONFLICT' | 'INTERNAL' {
	if (/unique/i.test(message)) return 'CONFLICT';
	return 'INTERNAL';
}

