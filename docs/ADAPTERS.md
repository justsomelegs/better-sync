## Writing a custom DatabaseAdapter

Implement the `DatabaseAdapter` interface and wrap it with `createAdapter`. Helpful utilities are exported for cursor and PK handling.

```ts
import { createAdapter, canonicalPk, decodeWindowCursor, encodeWindowCursor } from 'just-sync';
import type { DatabaseAdapter, PrimaryKey } from 'just-sync';

export function myAdapter(conn: any): DatabaseAdapter {
  async function run(sql: string, args?: any[]) { /* ... */ }
  async function query(sql: string, args?: any[]) { /* ... return { rows } */ }
  return createAdapter({
    async ensureMeta() {
      await run(`CREATE TABLE IF NOT EXISTS _sync_versions (table_name TEXT NOT NULL, pk_canonical TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (table_name, pk_canonical))`);
    },
    async begin() { /* BEGIN */ },
    async commit() { /* COMMIT */ },
    async rollback() { /* ROLLBACK */ },
    async insert(table, row) { /* INSERT and mirror version to _sync_versions; return row */ return row as any; },
    async updateByPk(table, pk: PrimaryKey, set, opts) {
      const key = canonicalPk(pk);
      if (opts?.ifVersion != null) {
        // CAS: read version from _sync_versions and compare
      }
      // UPDATE and mirror version
      return {} as any;
    },
    async deleteByPk(table, pk) { /* delete row + version */ return { ok: true } as const; },
    async selectByPk(table, pk, select) { /* select row and join version */ return null; },
    async selectWindow(table, req) {
      const orderBy = req.orderBy ?? { updatedAt: 'desc' };
      const keys = Object.keys(orderBy);
      const cur = decodeWindowCursor(req.cursor);
      // Build WHERE using cur.lastId/lastKeys as needed
      // Return rows and nextCursor using encodeWindowCursor
      return { data: [], nextCursor: null };
    }
  });
}
```

Guidelines:
- Always maintain `_sync_versions` meta table for authoritative per-row versioning.
- Enforce `ifVersion` CAS on updates when provided.
- `selectWindow` must respect the provided `orderBy` and encode a stable `nextCursor`.

