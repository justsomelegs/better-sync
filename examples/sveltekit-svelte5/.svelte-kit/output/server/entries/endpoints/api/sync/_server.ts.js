import { createSync } from "just-sync";
import { sqliteAdapter } from "just-sync/storage/server";
import { z } from "zod";
const schema = {
  todos: z.object({ id: z.string(), title: z.string(), done: z.boolean().default(false), updatedAt: z.number() })
};
const sync = createSync({ schema, database: sqliteAdapter({ url: "file:./.data/app.db" }) });
const handler = sync.fetch;
const GET = async ({ request }) => handler(request);
const POST = async ({ request }) => handler(request);
export {
  GET,
  POST
};
