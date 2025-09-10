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
  const wss = srv.attachWebSocket ? srv.attachWebSocket(server) : undefined;
  const sockets = new Set<any>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise<{ server: http.Server, url: string, sockets: Set<any>, wss?: any }>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}`, sockets, wss });
    });
  });
}

describe("client sender loop", () => {
  let server: http.Server; let url = ""; let sockets: Set<any>; let wss: any;
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; sockets = s.sockets; wss = s.wss; });
  afterAll(async () => {
    if (wss?.clients) for (const c of wss.clients as Set<any>) { try { c.terminate(); } catch {} }
    if (wss?.close) await new Promise((r) => wss.close(() => r(null)));
    for (const s of sockets) { try { s.destroy(); } catch {} }
    await new Promise((r) => server.close(() => r(null)));
  });

  it("drains queued changes after connection established", async () => {
    const c = createClient({ baseUrl: url });
    await c.connect();
    await new Promise((r) => setTimeout(r, 50));
    await c.applyChange("todo", { type: "insert", id: "1", value: { title: "A" } });
    await c.applyChange("todo", { type: "insert", id: "2", value: { title: "B" } });
    expect(c.getQueueStats().size).toBe(2);
    await c.drain();
    expect(c.getQueueStats().size).toBe(0);
  }, 10000);
});
