import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { betterSync } from "../src/public/server.js";

function startServer() {
  const srv = betterSync({ basePath: "/api/sync" });
  const server = http.createServer((req, res) => {
    // @ts-expect-error next unused
    return srv.fetch()(req, res);
  });
  return new Promise<{ server: http.Server, url: string }>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

describe("server error mapping", () => {
  let server: http.Server; let url = "";
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; });
  afterAll(async () => { await new Promise((r) => server.close(() => r(null))); });

  it("maps forced 500 to SYNC:SERVER_ERROR", async () => {
    const res = await fetch(`${url}/api/sync/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ __force500: true }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error.code).toBe("SYNC:SERVER_ERROR");
  });
});
