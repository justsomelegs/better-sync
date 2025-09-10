import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { betterSync } from "../src/public/server.js";
import { createClient } from "../src/public/client.js";

function startServer(withWS: boolean) {
  const srv = betterSync({ basePath: "/api/sync" });
  const server = http.createServer((req, res) => {
    // use our express-style handler
    return srv.fetch()(req, res);
  });
  const wss = withWS && srv.attachWebSocket ? srv.attachWebSocket(server) : undefined;
  return new Promise<{ server: http.Server, url: string, wss?: any }>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}`, wss });
    });
  });
}

describe("integration ws", () => {
  let server: http.Server; let url = ""; let wss: any;
  beforeAll(async () => { const s = await startServer(true); server = s.server; url = s.url; wss = s.wss; });
  afterAll(async () => {
    try {
      if (wss?.clients) {
        for (const c of wss.clients as Set<any>) { try { c.terminate(); } catch { } }
      }
      if (wss?.close) await new Promise((r) => wss.close(() => r(null)));
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  }, 20000);

  it("subscribes and receives live update via ws poke", async () => {
    const c = createClient({ baseUrl: url });
    await c.connect();
    const rows: any[] = [];
    const sub = c.subscribeQuery({ model: "todo" }, (r) => rows.splice(0, rows.length, ...r));
    await c.applyChange("todo", { type: "insert", id: "1", value: { title: "A" } });
    await c.drain();
    // wait briefly for ws poke to trigger refresh
    await new Promise((r) => setTimeout(r, 50));
    expect(rows.length).toBe(1);
    sub.unsubscribe();
  });
});
