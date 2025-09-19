import { describe, it, expect } from "vitest";
import { InMemoryAdapter, createSyncEngine, defineCollection } from "../src";

interface User { id: string; name: string }
const Users = defineCollection<User>({
  name: "users",
  version: 1,
  parse: (x) => {
    const u = x as Partial<User>;
    if (!u || typeof u.id !== "string" || typeof u.name !== "string") throw new Error("Invalid User");
    return { id: u.id, name: u.name };
  },
});

describe("InMemory adapter integration", () => {
  it("syncs bi-directionally via pull/push", async () => {
    const db1 = new InMemoryAdapter();
    const db2 = new InMemoryAdapter();
    await db1.init();
    await db2.init();
    const e1 = createSyncEngine({ db: db1, schemas: { users: Users } });
    const e2 = createSyncEngine({ db: db2, schemas: { users: Users } });
    await e1.init();
    await e2.init();
    await e1.migrate();
    await e2.migrate();
    await e1.put("users", "u1", { id: "u1", name: "Alice" });
    await e2.put("users", "u2", { id: "u2", name: "Bob" });

    const from1 = await e1.pull({ since: 0 });
    const from2 = await e2.pull({ since: 0 });
    await e1.push({ changes: from2 });
    await e2.push({ changes: from1 });

    const a = await e1.get("users", "u2");
    const b = await e2.get("users", "u1");
    expect(a?.name).toBe("Bob");
    expect(b?.name).toBe("Alice");
  });
});

