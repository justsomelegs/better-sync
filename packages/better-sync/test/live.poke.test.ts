import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { betterSync } from "../src/public/server.js";
import { createClient } from "../src/public/client.js";

function startServer(withWS: boolean) {
  const srv = betterSync({ basePath: "/api/sync" });
  const server = http.createServer((req, res) => {
    // @ts-expect-error next not used
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

describe("live poke", () => {
  let server: http.Server; let url = ""; let wss: any;
  beforeAll(async () => { const s = await startServer(true); server = s.server; url = s.url; wss = s.wss; });
  afterAll(async () => {
    if (wss?.clients) for (const c of wss.clients as Set<any>) { try { c.terminate(); } catch {} }
    if (wss?.close) await new Promise((r) => wss.close(() => r(null)));
    await new Promise((r) => server.close(() => r(null)));
  });

  it("refreshes subscribers on WS poke", async () => {
    const c = createClient({ baseUrl: url });
    await c.connect();
    const rows: any[] = [];
    const sub = c.subscribeQuery({ model: "todo" }, (r) => { rows.splice(0, rows.length, ...r); });
    // cause a poke by applying a change
    await c.applyChange("todo", { type: "insert", id: "1", value: { a: 1 } });
    await c.drain();
    await new Promise((r) => setTimeout(r, 40));
    expect(rows.length).toBeGreaterThan(0);
    sub.unsubscribe();
  });
});
