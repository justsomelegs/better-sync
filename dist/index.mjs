import { coreMigrations, applyMigrations } from './migrations.mjs';

function ensureNamespaceTable(db, namespace) {
  if (db.dialect === "sqlite") {
    db.run(
      `CREATE TABLE IF NOT EXISTS ${JSON.stringify(namespace)} (
        id TEXT PRIMARY KEY,
        doc TEXT
      )`
    );
  } else {
    db.run(
      `CREATE TABLE IF NOT EXISTS ${JSON.stringify(namespace)} (
        id TEXT PRIMARY KEY,
        doc JSONB
      )`
    );
  }
}
async function getNextGlobalVersion(db) {
  if (db.dialect === "sqlite") {
    const row = await db.get(
      `SELECT version FROM _sync_versions WHERE key = 'global'`
    );
    if (!row) {
      await db.run(`INSERT INTO _sync_versions(key, version) VALUES ('global', 1)`);
      return 1;
    }
    const next = (row.version ?? 0) + 1;
    await db.run(`UPDATE _sync_versions SET version = ? WHERE key = 'global'`, [next]);
    return next;
  } else {
    const row = await db.get(
      `SELECT version FROM _sync_versions WHERE key = 'global'`
    );
    if (!row) {
      await db.run(`INSERT INTO _sync_versions(key, version) VALUES ('global', 1)`);
      return 1;
    }
    const next = (row.version ?? 0) + 1;
    await db.run(`UPDATE _sync_versions SET version = $1 WHERE key = 'global'`, [next]);
    return next;
  }
}
function upsertClock(db, namespace, recordId, serverVersion) {
  if (db.dialect === "sqlite") {
    db.run(
      `INSERT INTO _sync_clock(namespace, record_id, server_version) VALUES (?, ?, ?)
       ON CONFLICT(namespace, record_id) DO UPDATE SET server_version = excluded.server_version`,
      [namespace, recordId, serverVersion]
    );
  } else {
    db.run(
      `INSERT INTO _sync_clock(namespace, record_id, server_version) VALUES ($1, $2, $3)
       ON CONFLICT(namespace, record_id) DO UPDATE SET server_version = EXCLUDED.server_version`,
      [namespace, recordId, serverVersion]
    );
  }
}
function insertChange(db, namespace, recordId, version, op, payload) {
  if (db.dialect === "sqlite") {
    db.run(
      `INSERT INTO _sync_changes(namespace, record_id, version, op, payload) VALUES (?, ?, ?, ?, ?)`,
      [namespace, recordId, version, op, payload == null ? null : JSON.stringify(payload)]
    );
  } else {
    db.run(
      `INSERT INTO _sync_changes(namespace, record_id, version, op, payload) VALUES ($1, $2, $3, $4, $5)`,
      [namespace, recordId, version, op, payload == null ? null : payload]
    );
  }
}
function applyToNamespaceTable(db, namespace, recordId, op, payload) {
  ensureNamespaceTable(db, namespace);
  if (op === "delete") {
    db.run(`DELETE FROM ${JSON.stringify(namespace)} WHERE id = ${db.dialect === "sqlite" ? "?" : "$1"}`, [recordId]);
    return;
  }
  if (db.dialect === "sqlite") {
    db.run(
      `INSERT INTO ${JSON.stringify(namespace)}(id, doc) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET doc = excluded.doc`,
      [recordId, JSON.stringify(payload ?? null)]
    );
  } else {
    db.run(
      `INSERT INTO ${JSON.stringify(namespace)}(id, doc) VALUES ($1, $2)
       ON CONFLICT(id) DO UPDATE SET doc = EXCLUDED.doc`,
      [recordId, payload ?? null]
    );
  }
}
async function applyMutations(db, mutations) {
  const results = [];
  await db.transaction(async (tx) => {
    for (const m of mutations) {
      const clock = await tx.get(
        `SELECT server_version FROM _sync_clock WHERE namespace = ${tx.dialect === "sqlite" ? "?" : "$1"} AND record_id = ${tx.dialect === "sqlite" ? "?" : "$2"}`,
        [m.namespace, m.recordId]
      );
      const current = clock?.server_version ?? 0;
      if (current !== m.clientVersion) {
        insertChange(tx, m.namespace, m.recordId, current, "update", m.payload ?? null);
        results.push({ applied: false, serverVersion: current, conflict: { reason: "version_mismatch", serverVersion: current } });
        continue;
      }
      const nextVersion = await getNextGlobalVersion(tx);
      insertChange(tx, m.namespace, m.recordId, nextVersion, m.op, m.payload ?? null);
      upsertClock(tx, m.namespace, m.recordId, nextVersion);
      applyToNamespaceTable(tx, m.namespace, m.recordId, m.op, m.payload ?? null);
      results.push({ applied: true, serverVersion: nextVersion });
    }
  });
  return results;
}

async function pullChangesSince(db, options) {
  const since = options.since ?? 0;
  const limit = options.limit ?? 1e3;
  const ns = options.namespace;
  let sql = `SELECT id, namespace, record_id, version, op, payload, ts FROM _sync_changes WHERE version > ${db.dialect === "sqlite" ? "?" : "$1"}`;
  const params = [since];
  if (ns) {
    sql += ` AND namespace = ${db.dialect === "sqlite" ? "?" : "$2"}`;
    params.push(ns);
  }
  sql += ` ORDER BY version ASC, id ASC LIMIT ${db.dialect === "sqlite" ? "?" : ns ? "$3" : "$2"}`;
  params.push(limit);
  const rows = await db.all(sql, params);
  const normalized = rows.map((r) => ({
    ...r,
    payload: typeof r.payload === "string" ? r.payload ? JSON.parse(r.payload) : null : r.payload
  }));
  const lastVersion = normalized.length > 0 ? normalized[normalized.length - 1].version : since;
  return { changes: normalized, lastVersion };
}

async function createSyncEngine(options) {
  const { database, migrations = [] } = options;
  const db = database.session();
  const allMigrations = [...coreMigrations(), ...migrations];
  await applyMigrations(db, allMigrations);
  return {
    async getAppliedMigrations() {
      const rows = await db.all(
        `SELECT id FROM _sync_migrations ORDER BY applied_at ASC, id ASC`
      );
      return rows.map((r) => r.id);
    },
    async getSchemaVersion() {
      const row = await db.get(
        `SELECT COUNT(1) as n FROM _sync_migrations`
      );
      return row?.n ?? 0;
    },
    async dispose() {
    },
    async mutate(mutations) {
      return applyMutations(db, mutations);
    },
    async pull(options2) {
      return pullChangesSince(db, options2);
    }
  };
}

export { createSyncEngine };
