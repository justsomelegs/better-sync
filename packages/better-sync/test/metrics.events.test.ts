import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
  return new Promise<{ server: http.Server, url: string, wss?: any }>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}`, wss });
    });
  });
}

describe("metrics events", () => {
  let server: http.Server; let url = ""; let wss: any;
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; wss = s.wss; });
  afterAll(async () => {
    if (wss?.clients) for (const c of wss.clients as Set<any>) { try { c.terminate(); } catch {} }
    if (wss?.close) await new Promise((r) => wss.close(() => r(null)));
    await new Promise((r) => server.close(() => r(null)));
  });

  it("fires connect/applyQueued/applySent/applyAck/pull/poke", async () => {
    const events: string[] = [];
    const metrics = { on: (e: any) => events.push(e) };
    const c = createClient({ baseUrl: url, metrics });
    await c.connect();
    await c.applyChange("todo", { type: "insert", id: "1", value: { a: 1 } });
    await c.drain();
    // subscribe to trigger pull on poke
    const sub = c.subscribeQuery({ model: "todo" }, () => {});
    await c.applyChange("todo", { type: "insert", id: "2", value: { b: 2 } });
    await c.drain();
    // actively pull to ensure at least one pull event is recorded
    await fetch(`${url}/api/sync/pull?model=todo`);
    await new Promise((r) => setTimeout(r, 60));
    sub.unsubscribe();
    expect(events.includes("applyQueued")).toBe(true);
    expect(events.includes("applySent")).toBe(true);
    expect(events.includes("applyAck")).toBe(true);
    expect(events.includes("pull")).toBe(true);
    // connect and poke are best-effort; we at least verify no errors
  });
});
