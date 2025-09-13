import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { core, adapterSqlite } from 'just-sync';
import { schema } from './schema.js';

const sync = core.createSync({ schema, database: adapterSqlite.sqliteAdapter({ url: 'file:./app.db' }) });

const app = new Hono();

app.get('/events', async (c) => {
  const res = await sync.fetch(new Request(new URL(c.req.url, 'http://localhost').toString(), { method: 'GET', headers: c.req.raw.headers }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/mutate', async (c) => {
  const body = await c.req.text();
  const res = await sync.fetch(new Request(new URL(c.req.url, 'http://localhost').toString(), { method: 'POST', headers: c.req.raw.headers, body }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/select', async (c) => {
  const body = await c.req.text();
  const res = await sync.fetch(new Request(new URL(c.req.url, 'http://localhost').toString(), { method: 'POST', headers: c.req.raw.headers, body }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post('/mutators/:name', async (c) => {
  const body = await c.req.text();
  const url = new URL(c.req.url, 'http://localhost');
  const res = await sync.fetch(new Request(url.toString(), { method: 'POST', headers: c.req.raw.headers, body }));
  return new Response(res.body, { status: res.status, headers: res.headers });
});

serve({ fetch: app.fetch, port: 3000 });
console.log('Hono example listening on http://localhost:3000');
