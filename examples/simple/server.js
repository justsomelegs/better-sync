import http from 'node:http';
import { createSync, z } from '../../packages/core/dist/index.js';
import { sqliteAdapter } from '../../packages/adapter-sqlite/dist/index.js';

// Define schema in JS using zod
const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() })
};

const sync = createSync({ schema, database: sqliteAdapter({ url: 'app.db' }), mutators: {
  addTodo: {
    args: z.object({ title: z.string().min(1) }),
    handler: async ({ db }, { title }) => {
      const row = await db.insert('todos', { title, done: false });
      return row;
    }
  }
} });

const handler = sync.fetch;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    await new Promise((r) => req.on('end', r));
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    const request = new Request(`http://localhost:8787${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined
    });
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if ((response.headers.get('content-type') || '').startsWith('text/event-stream')) {
      const reader = response.body.getReader();
      async function pump() {
        const { value, done } = await reader.read();
        if (done) { res.end(); return; }
        res.write(Buffer.from(value));
        pump();
      }
      pump();
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});

server.listen(8787, () => console.log('Sync server listening on http://localhost:8787'));
