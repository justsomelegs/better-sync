import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { betterSync } from "../src/public/server.js";
import { createClient } from "../src/public/client.js";

function startServer() {
  const srv = betterSync({ basePath: "/api/sync" });
  const server = http.createServer((req, res) => {
    // @ts-expect-error next unused
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

describe("metrics batch", () => {
  let server: http.Server; let url = ""; let sockets: Set<any>; let wss: any;
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; sockets = s.sockets; wss = s.wss; });
  afterAll(async () => { if (wss?.clients) for (const c of wss.clients as Set<any>) { try { c.terminate(); } catch {} } if (wss?.close) await new Promise((r) => wss.close(() => r(null))); for (const s of sockets) { try { s.destroy(); } catch {} } await new Promise((r) => server.close(() => r(null))); });

  it("fires applyQueued/applySent/applyAck for each change in batch", async () => {
    const seen: string[] = [];
    const c = createClient({ baseUrl: url, metrics: { on: (e) => seen.push(e) } });
    await c.connect();
    await new Promise((r) => setTimeout(r, 50));
    await c.applyChanges("todo", [
      { type: "insert", id: "1", value: { a: 1 } },
      { type: "insert", id: "2", value: { b: 2 } },
      { type: "update", id: "2", patch: { c: 3 } },
    ] as any);
    await c.drain();
    expect(seen.filter((e) => e === "applyQueued").length).toBe(3);
    expect(seen.filter((e) => e === "applySent").length).toBeGreaterThanOrEqual(1);
    expect(seen.includes("applyAck")).toBe(true);
  });
});
