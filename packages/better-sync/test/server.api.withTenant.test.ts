import { describe, it, expect } from "vitest";
import { betterSync } from "../src/public/server.js";

describe("server api withTenant", () => {
  it("isolates cursors per tenant", async () => {
    const s = betterSync({ basePath: "/api/sync" });
    const a = s.api.withTenant("a");
    const b = s.api.withTenant("b");
    const r1 = await a.apply({ changes: [{ model: "todo", type: "insert", id: "1", value: { a: 1 } }] });
    const r2 = await b.apply({ changes: [{ model: "todo", type: "insert", id: "1", value: { b: 1 } }] });
    expect(r1.ok && r2.ok).toBe(true);
    // cursors should both be "1" independently
    expect((r1 as any).value.cursor).toBe("1");
    expect((r2 as any).value.cursor).toBe("1");
  });
});
