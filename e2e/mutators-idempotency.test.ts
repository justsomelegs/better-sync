import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import http from 'node:http';
import { createSync, createClient } from '../src';
import { toNodeHandler } from 'better-call/node';
import { memoryAdapter } from '../src/storage/server';
import { z } from 'zod';

let server: http.Server;
let baseURL = '';

beforeAll(async () => {
  const sync = createSync({
    schema: { items: {} },
    database: memoryAdapter(),
    mutators: {
      add: { args: z.object({ id: z.string(), value: z.number() }), async handler({ db }, { id, value }) {
        await db.insert('items', { id, value, updatedAt: Date.now(), version: 1 });
        return { ok: true as const };
      }}
    }
  });
  server = http.createServer(toNodeHandler(sync.handler));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr && 'port' in addr) baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('e2e mutators & idempotency', () => {
  it('mutator executes and idempotency deduplicates', async () => {
    // First call with a clientOpId
    const first = await fetch(`${baseURL}/mutators/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: { id: 'x', value: 1 }, clientOpId: 'same' }) });
    expect(first.ok).toBe(true);
    const firstJson = await first.json();
    // Duplicate call with same clientOpId should return same payload
    const second = await fetch(`${baseURL}/mutators/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: { id: 'x', value: 1 }, clientOpId: 'same' }) });
    expect(second.ok).toBe(true);
    const secondJson = await second.json();
    expect(secondJson.duplicated).toBe(true);
    expect(secondJson.ok).toBe(true);
  });
});

