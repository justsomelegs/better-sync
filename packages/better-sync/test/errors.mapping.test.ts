import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { betterSync } from "../src/public/server.js";

function startServer() {
  const srv = betterSync({ basePath: "/api/sync", authorize: () => false });
  const server = http.createServer((req, res) => {
    // @ts-expect-error next unused
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

describe("error mapping", () => {
  let server: http.Server; let url = ""; let sockets: Set<any>;
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; sockets = s.sockets; });
  afterAll(async () => { for (const s of sockets) { try { s.destroy(); } catch {} } await new Promise((r) => server.close(() => r(null))); });

  it("returns SYNC:UNAUTHORIZED for unauthorized requests", async () => {
    const res = await fetch(`${url}/api/sync/pull?model=todo`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("SYNC:UNAUTHORIZED");
  });
});
