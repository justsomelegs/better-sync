import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { toNodeHandler } from 'better-call/node';
import { z } from 'zod';
import { createSync } from '../../';
import { createClient } from '../createClient';

function makeDb() {
  const rows: any[] = [];
  return {
    async begin() {}, async commit() {}, async rollback() {},
    async insert(_t: string, row: any) { rows.push(row); return { ...row }; },
    async updateByPk(_t: string, _pk: any, set: any) { Object.assign(rows[0], set); return { ...rows[0] }; },
    async deleteByPk() { return { ok: true }; },
    async selectByPk() { return null; },
    async selectWindow(_t: string) { return { data: rows.slice(), nextCursor: null }; }
  } as const;
}

describe('watch immediate notify and debounce', () => {
  it('emits immediate notify on mutation, then snapshot', async () => {
    const sync = createSync({ schema: { notes: { schema: z.object({ id: z.string().optional(), title: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } }, database: makeDb() as any, sse: { keepaliveMs: 200 } });
    const server = http.createServer(toNodeHandler(sync.handler));
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
    const baseURL = `http://127.0.0.1:${addr.port}`;

    const client = createClient({ baseURL, realtime: 'sse' });
    const events: any[] = [];
    const stop = client.watch({ table: 'notes', limit: 10 }, (evt) => events.push(evt), { initialSnapshot: false, debounceMs: 10 });

    await client.insert('notes', { title: 'a' });

    const start = Date.now();
    while (!events.find((e) => Array.isArray(e.data))) {
      if (Date.now() - start > 3000) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    stop();
    await new Promise<void>((r) => server.close(() => r()))

    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = events[0];
    expect(first.table).toBe('notes');
    // first should be the immediate notify (no data)
    expect(first.data ?? undefined).toBeUndefined();
    // eventually a snapshot should arrive
    const snap = events.find((e) => Array.isArray(e.data));
    expect(!!snap).toBe(true);
  });

  it('debounces snapshot refresh for burst of mutations', async () => {
    const sync = createSync({ schema: { items: { schema: z.object({ id: z.string().optional(), name: z.string(), updatedAt: z.number().optional(), version: z.number().optional() }) } }, database: makeDb() as any, sse: { keepaliveMs: 200 } });
    const server = http.createServer(toNodeHandler(sync.handler));
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr || !('port' in addr)) throw new Error('no port');
    const baseURL = `http://127.0.0.1:${addr.port}`;

    const client = createClient({ baseURL, realtime: 'sse' });
    const events: any[] = [];
    const stop = client.watch({ table: 'items', limit: 100 }, (evt) => events.push(evt), { initialSnapshot: false, debounceMs: 30 });

    // burst
    await Promise.all([
      client.insert('items', { name: 'a' }),
      client.insert('items', { name: 'b' }),
      client.insert('items', { name: 'c' })
    ]);

    const start = Date.now();
    while (events.filter((e) => Array.isArray(e.data)).length < 1) {
      if (Date.now() - start > 3000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    stop();
    await new Promise<void>((r) => server.close(() => r()))

    const immediateCount = events.filter((e) => e.pks).length;
    const snapshotCount = events.filter((e) => Array.isArray(e.data)).length;
    expect(immediateCount).toBeGreaterThan(0);
    expect(snapshotCount).toBeGreaterThanOrEqual(1);
    expect(snapshotCount).toBeLessThanOrEqual(2);
  });
});

