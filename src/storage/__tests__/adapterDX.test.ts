import { describe, it, expect } from 'vitest';
import { createAdapter } from '../adapter';

function inMemoryMapAdapter() {
	const tables = new Map<string, Map<string, any>>();
	return createAdapter({
		async insert(table, row) { const t = tables.get(table) ?? (tables.set(table, new Map()), tables.get(table)!); const id = String((row as any).id ?? Math.random()); t.set(id, { ...row, id }); return { ...row, id }; },
		async updateByPk(table, pk, set) { const t = tables.get(table) ?? new Map(); const k = String(typeof pk === 'object' ? JSON.stringify(pk) : pk); const cur = t.get(k) || {}; const next = { ...cur, ...set, id: cur.id ?? k }; t.set(k, next); return next; },
		async deleteByPk(table, pk) { const t = tables.get(table) ?? new Map(); const k = String(typeof pk === 'object' ? JSON.stringify(pk) : pk); t.delete(k); return { ok: true } as const; },
		async selectByPk(table, pk) { const t = tables.get(table) ?? new Map(); const k = String(typeof pk === 'object' ? JSON.stringify(pk) : pk); return t.get(k) ?? null; },
		async selectWindow(table, _req) { const t = tables.get(table) ?? new Map(); return { data: Array.from(t.values()), nextCursor: null }; }
	});
}

describe('adapter author DX', () => {
	it('createAdapter wraps minimal spec into full adapter', async () => {
		const a = inMemoryMapAdapter();
		await a.insert('t', { id: 'x', a: 1 });
		const one = await a.selectByPk('t', 'x');
		expect(one?.a).toBe(1);
		await a.updateByPk('t', 'x', { a: 2 });
		expect((await a.selectByPk('t', 'x'))?.a).toBe(2);
		await a.deleteByPk('t', 'x');
		expect(await a.selectByPk('t', 'x')).toBeNull();
	});
});