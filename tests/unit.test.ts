import { describe, it, expect } from "vitest";
import { InMemoryAdapter, createSyncEngine, defineCollection } from "../src";

interface Doc { id: string; value: number }
const Docs = defineCollection<Doc>({
  name: "docs",
  version: 1,
  parse: (x) => {
    const d = x as Partial<Doc>;
    if (!d || typeof d.id !== "string" || typeof d.value !== "number") throw new Error("Invalid Doc");
    return { id: d.id, value: d.value };
  },
});

describe("SyncEngine basic put/get", () => {
  it("stores and retrieves records", async () => {
    const db = new InMemoryAdapter();
    await db.init();
    const engine = createSyncEngine({ db, schemas: { docs: Docs } });
    await engine.init();
    await engine.migrate();
    await engine.put("docs", "d1", { id: "d1", value: 42 });
    const got = await engine.get("docs", "d1");
    expect(got?.value).toBe(42);
  });
});

describe("Conflict resolution lastWriteWins", () => {
  it("prefers higher clock", async () => {
    const db = new InMemoryAdapter();
    await db.init();
    const engine = createSyncEngine({ db, schemas: { docs: Docs } });
    await engine.init();
    await engine.migrate();
    await engine.put("docs", "d1", { id: "d1", value: 1 });
    await engine.put("docs", "d1", { id: "d1", value: 2 });
    const got = await engine.get("docs", "d1");
    expect(got?.value).toBe(2);
  });
});

describe("Sync propagation", () => {
  it("pulls from A, pushes to B", async () => {
    const dbA = new InMemoryAdapter();
    const dbB = new InMemoryAdapter();
    await dbA.init();
    await dbB.init();
    const a = createSyncEngine({ db: dbA, schemas: { docs: Docs } });
    const b = createSyncEngine({ db: dbB, schemas: { docs: Docs } });
    await a.init();
    await b.init();
    await a.migrate();
    await b.migrate();
    await a.put("docs", "d1", { id: "d1", value: 7 });
    const changes = await a.pull({ since: 0 });
    await b.push({ changes });
    const got = await b.get("docs", "d1");
    expect(got?.value).toBe(7);
  });
});

