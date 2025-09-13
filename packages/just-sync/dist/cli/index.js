#!/usr/bin/env node

// src/cli/index.ts
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log("just-sync CLI (MVP)");
    console.log("  init --adapter sqlite --db-url file:./app.db");
    console.log("  generate:schema --adapter sqlite --out migrations/");
    process.exit(0);
  }
  if (cmd === "init") {
    console.log("Initialized just-sync (stub).");
    process.exit(0);
  }
  if (cmd === "generate:schema") {
    const outIdx = args.indexOf("--out");
    const outDir = outIdx !== -1 && typeof args[outIdx + 1] === "string" && args[outIdx + 1] ? args[outIdx + 1] : "migrations";
    await mkdir(outDir, { recursive: true });
    const ddl = `CREATE TABLE IF NOT EXISTS _sync_versions (
  table_name   TEXT    NOT NULL,
  pk_canonical TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  PRIMARY KEY (table_name, pk_canonical)
);
`;
    const fname = join(outDir, `${Date.now()}_sync_versions.sql`);
    await writeFile(fname, ddl, "utf8");
    console.log(`Wrote ${fname}`);
    process.exit(0);
  }
  console.error("Unknown command");
  process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
//# sourceMappingURL=index.js.map