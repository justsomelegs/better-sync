import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { createSync } from '../';
import { toNodeHandler } from 'better-call/node';

async function readUntilEvent(res: Response, timeoutMs = 3000) {
	const reader = res.body!.getReader();
	const td = new TextDecoder();
	const start = Date.now();
	let buffer = '';
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (Date.now() - start > timeoutMs) throw new Error('timeout');
		const { value, done } = await reader.read();
		if (done) throw new Error('done');
		if (value) {
			buffer += td.decode(value);
			const frames = buffer.split('\n\n');
			buffer = frames.pop() || '';
			for (const f of frames) {
				if (f.includes('event: mutation')) return f;
			}
		}
	}
}

describe('E2E SSE basic', () => {
	it('serves SSE and emits on mutation', async () => {
		const sync = createSync({ schema: {}, database: { async begin() {}, async commit() {}, async rollback() {}, async insert(_t: string, row: any) { return { ...row }; }, async updateByPk() { return {}; }, async deleteByPk() { return { ok: true }; }, async selectByPk() { return null; }, async selectWindow() { return { data: [], nextCursor: null }; } } as any });
		const server = http.createServer(toNodeHandler(sync.handler));
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const addr = server.address();
		if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('port');
		const base = `http://127.0.0.1:${addr.port}`;

		const ac = new AbortController();
		const sseRes = await fetch(`${base}/events`, { signal: ac.signal });
		expect(sseRes.ok).toBe(true);
		expect(sseRes.headers.get('Content-Type')).toContain('text/event-stream');

		const mutateRes = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'insert', table: 'todos', rows: { title: 'y' } }) });
		expect(mutateRes.ok).toBe(true);

		const frame = await readUntilEvent(sseRes);
		expect(frame).toContain('event: mutation');
		ac.abort();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
});