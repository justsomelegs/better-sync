import { createSync } from "just-sync";
import { sqliteAdapter } from "just-sync/storage/server";
import { toSvelteKitHandle } from "just-sync/sveltekit";
import { z } from "zod";
const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() })
};
const sync = createSync({ schema, database: sqliteAdapter({ url: "file:./.data/app.db" }) });
const handle = toSvelteKitHandle(sync.fetch, { basePath: "/api/sync" });
export {
  handle
};
