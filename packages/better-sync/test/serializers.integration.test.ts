import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { betterSync } from "../src/public/server.js";
import { createClient, defineSchema, serializers } from "../src/index.js";

function startServer() {
  const srv = betterSync({ basePath: "/api/sync" });
  const server = http.createServer((req, res) => {
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

type Row = { id: string; amount: bigint; issuedAt: Date };
const schema = defineSchema({ inv: {} as Row });

describe("serializers integration", () => {
  let server: http.Server; let url = ""; let sockets: Set<any>; let wss: any;
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; sockets = s.sockets; wss = s.wss; });
  afterAll(async () => { if (wss?.clients) for (const c of wss.clients as Set<any>) { try { c.terminate(); } catch { } } if (wss?.close) await new Promise((r) => wss.close(() => r(null))); for (const s of sockets) { try { s.destroy(); } catch { } } await new Promise((r) => server.close(() => r(null))); });

  it("encodes bigint/date to wire and decodes on pull", async () => {
    const c = createClient<typeof schema>({
      baseUrl: url,
      serializers: {
        inv: serializers.compose(
          serializers.bigIntFields("amount"),
          serializers.dateFields("issuedAt"),
        )
      }
    });
    await c.connect();
    await new Promise((r) => setTimeout(r, 50));
    await c.applyChange("inv", { type: "insert", id: "1", value: { id: "1", amount: 5n, issuedAt: new Date("2020-01-01T00:00:00Z") } });
    await c.drain();
    let rows: Row[] = [];
    c.subscribeQuery({ model: "inv" }, (r) => rows = r);
    await new Promise((r) => setTimeout(r, 40));
    expect(typeof rows[0].amount).toBe("bigint");
    expect(rows[0].issuedAt instanceof Date).toBe(true);
  });
});
