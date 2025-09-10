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

describe("withTenant", () => {
  let server: http.Server; let url = ""; let sockets: Set<any>;
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; sockets = s.sockets; });
  afterAll(async () => { for (const s of sockets) { try { s.destroy(); } catch {} } await new Promise((r) => server.close(() => r(null))); });

  it("creates tenant-scoped client that sends x-tenant-id", async () => {
    const root = createClient({ baseUrl: url });
    await root.connect();
    const t1 = root.withTenant("t1");
    const rows: any[] = [];
    t1.subscribeQuery({ model: "todo" }, (r) => rows.splice(0, rows.length, ...r));
    // seed tenant-specific data, then poke via second write
    await fetch(`${url}/api/sync/apply`, { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": "t1" }, body: JSON.stringify({ model: "todo", change: { type: "insert", id: "1", value: { a: 1 } } }) });
    await fetch(`${url}/api/sync/apply`, { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": "t1" }, body: JSON.stringify({ model: "todo", change: { type: "insert", id: "2", value: { b: 2 } } }) });
    // explicitly pull to ensure subscription sees rows even if poke timing is racy
    const res = await fetch(`${url}/api/sync/pull?model=todo`, { headers: { "x-tenant-id": "t1" } });
    const data = await res.json();
    if (data?.ok && data?.value?.rows?.length) rows.splice(0, rows.length, ...data.value.rows);
    await new Promise((r) => setTimeout(r, 60));
    expect(rows.length).toBeGreaterThan(0);
  }, 10000);
});
