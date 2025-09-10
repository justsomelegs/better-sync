import { describe, it, expect } from "vitest";
import { createClient } from "../src/public/client.js";

describe("client", () => {
  it("connects (skeleton)", async () => {
    const c = createClient({ baseUrl: "http://localhost:3000" });
    await c.connect();
    expect(c.getQueueStats().size).toBe(0);
  });
});
