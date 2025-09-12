import http from 'node:http';
import { core, adapterSqlite } from 'just-sync';
import { schema } from './schema.js';

const sync = core.createSync({ schema, database: adapterSqlite.sqliteAdapter({ url: 'file:./app.db' }) });

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) { res.statusCode = 400; res.end('Bad Request'); return; }
  const url = new URL(req.url, 'http://localhost:3000');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const request = new Request(url.toString(), { method: req.method, headers: req.headers, body: ['GET','HEAD'].includes(req.method) ? undefined : body });
    const response = await sync.fetch(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (response.body) {
      const reader = response.body.getReader();
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) { res.end(); return; }
        res.write(Buffer.from(value));
        return pump();
      });
      pump();
    } else {
      const text = await response.text();
      res.end(text);
    }
  });
});

server.listen(3000, () => {
  console.log('Example server listening on http://localhost:3000');
});
