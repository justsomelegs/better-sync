import { describe, it, expect } from "vitest";
import * as storage from "../src/storage.js";
import * as transport from "../src/transport.js";
import * as auth from "../src/auth.js";

describe("providers (single-package)", () => {
  it("exports storage providers", () => {
    expect(typeof (storage as any).idb).toBe("function");
    expect(typeof (storage as any).sqlite).toBe("function");
    expect(typeof (storage as any).postgres).toBe("function");
  });
  it("exports transport providers", () => {
    expect(typeof (transport as any).ws).toBe("function");
    expect(typeof (transport as any).rpc).toBe("function");
  });
  it("exports auth providers", () => {
    expect(typeof (auth as any).jwt).toBe("function");
  });
});
