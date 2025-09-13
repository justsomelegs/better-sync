import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createSync, adapters } from "just-sync";
import { schema } from "./schema";
const db = adapters.memoryAdapter();
const sync = createSync({ schema, database: db });
const app = new Hono();
app.get("/api/sync/events", async (c) => {
    const url = new URL(c.req.url);
    const since = c.req.header("last-event-id") ?? url.searchParams.get("since") ?? undefined;
    const res = await sync.fetch(new Request(url.toString(), { method: "GET", headers: since ? { "Last-Event-ID": since } : {} }));
    return res;
});
app.post("/api/sync/mutate", async (c) => {
    const res = await sync.fetch(new Request(new URL(c.req.url).toString(), { method: "POST", body: await c.req.raw.clone().text(), headers: { "Content-Type": "application/json" } }));
    return res;
});
app.post("/api/sync/select", async (c) => {
    const res = await sync.fetch(new Request(new URL(c.req.url).toString(), { method: "POST", body: await c.req.raw.clone().text(), headers: { "Content-Type": "application/json" } }));
    return res;
});
app.post("/api/sync/selectByPk", async (c) => {
    const res = await sync.fetch(new Request(new URL(c.req.url).toString(), { method: "POST", body: await c.req.raw.clone().text(), headers: { "Content-Type": "application/json" } }));
    return res;
});
app.post("/api/sync/mutators/:name", async (c) => {
    const res = await sync.fetch(new Request(new URL(c.req.url).toString(), { method: "POST", body: await c.req.raw.clone().text(), headers: { "Content-Type": "application/json" } }));
    return res;
});
serve({ fetch: app.fetch, port: 8787 });
console.log("Hono server running on http://localhost:8787");
//# sourceMappingURL=server.js.map