import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createClient } from "../src/public/client.js";
import { betterSync } from "../src/public/server.js";

function startServer() {
  const srv = betterSync({ basePath: "/api/sync" });
  const server = http.createServer((req, res) => {
    // @ts-expect-error next not used
    return srv.fetch()(req, res);
  });
  const sockets = new Set<any>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise<{ server: http.Server, url: string, sockets: Set<any> }>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}`, sockets });
    });
  });
}

describe("pull since cursor", () => {
  let server: http.Server; let url = ""; let sockets: Set<any>;
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; sockets = s.sockets; });
  afterAll(async () => { for (const s of sockets) { try { s.destroy(); } catch {} } await new Promise((r) => server.close(() => r(null))); });

  it("client can pass since= to avoid unnecessary rows (manual call)", async () => {
    const c = createClient({ baseUrl: url });
    await c.connect();
    // seed data to increment cursor
    await fetch(`${url}/api/sync/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "todo", change: { type: "insert", id: "1", value: { a: 1 } } }) });

    // initial pull
    let res = await fetch(`${url}/api/sync/pull?model=todo`);
    const initial = await res.json();
    expect(initial.value.rows.length).toBeGreaterThanOrEqual(1);

    // next pull with since
    res = await fetch(`${url}/api/sync/pull?model=todo&since=${initial.value.cursor}`);
    const later = await res.json();
    expect(later.value.rows.length).toBe(0);
  });
});
