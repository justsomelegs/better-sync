import { InMemoryAdapter, createSyncEngine, defineCollection } from "../src";
const Users = defineCollection({
    name: "users",
    version: 1,
    parse: (x) => {
        const u = x;
        if (!u || typeof u.id !== "string" || typeof u.name !== "string" || typeof u.email !== "string") {
            throw new Error("Invalid User");
        }
        return { id: u.id, name: u.name, email: u.email, updatedAt: u.updatedAt ?? Date.now() };
    },
});
async function main() {
    const dbA = new InMemoryAdapter();
    const dbB = new InMemoryAdapter();
    await dbA.init();
    await dbB.init();
    const engineA = createSyncEngine({ db: dbA, schemas: { users: Users } });
    const engineB = createSyncEngine({ db: dbB, schemas: { users: Users } });
    await engineA.init();
    await engineB.init();
    await engineA.migrate();
    await engineB.migrate();
    await engineA.put("users", "u1", { id: "u1", name: "Ada", email: "ada@example.com", updatedAt: Date.now() });
    const changes = await engineA.pull({ since: 0 });
    await engineB.push({ changes });
    const ada = await engineB.get("users", "u1");
    console.log("Synced user on B:", ada);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=basic.js.map