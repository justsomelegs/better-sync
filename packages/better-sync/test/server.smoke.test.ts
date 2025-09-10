import { describe, it, expect } from "vitest";
import { betterSync } from "../src/public/server.js";

describe("server", () => {
  it("provides fetch handler and apply api", async () => {
    const s = betterSync({});
    const handler = s.fetch();
    expect(typeof handler).toBe("function");
    const res = await s.api.apply({});
    expect(res.ok).toBe(true);
  });
});
