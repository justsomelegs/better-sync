import { describe, it, expect } from "vitest";
import { syncError } from "../src/index.js";

describe("errors", () => {
  it("creates SYNC error shape", () => {
    const e = syncError("SYNC:UNAUTHORIZED", "Missing token", { path: "/api/sync" });
    expect(e.code).toBe("SYNC:UNAUTHORIZED");
    expect(e.message).toBe("Missing token");
  });
});
