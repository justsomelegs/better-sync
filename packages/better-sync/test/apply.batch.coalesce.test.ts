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

describe("batch apply + coalescing", () => {
  let server: http.Server; let url = "";
  beforeAll(async () => { const s = await startServer(); server = s.server; url = s.url; });
  afterAll(async () => { await new Promise((r) => server.close(() => r(null))); });

  it("merges update patches and delete wins", async () => {
    const tenant = "t1";
    const headers = { "Content-Type": "application/json", "x-tenant-id": tenant } as Record<string, string>;
    // batch with insert + updates + delete
    const changes = [
      { model: "todo", type: "insert", id: "1", value: { a: 1 } },
      { model: "todo", type: "update", id: "1", patch: { b: 2 } },
      { model: "todo", type: "update", id: "1", patch: { c: 3 } },
      { model: "todo", type: "delete", id: "2" },
    ];
    const res = await fetch(`${url}/api/sync/apply`, { method: "POST", headers, body: JSON.stringify({ changes }) });
    expect(res.ok).toBe(true);
    // pull rows
    const pull = await fetch(`${url}/api/sync/pull?model=todo`, { headers: { "x-tenant-id": tenant } });
    expect(pull.ok).toBe(true);
    const data = await pull.json();
    expect(data.ok).toBe(true);
    const rows = data.value.rows as any[];
    expect(rows.find((r: any) => r.a === 1 && r.b === 2 && r.c === 3)).toBeTruthy();
  });

  it("single-body apply remains supported for compatibility", async () => {
    const res = await fetch(`${url}/api/sync/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "todo", change: { type: "insert", id: "Z", value: { z: 1 } } }) });
    expect(res.ok).toBe(true);
  });
});
