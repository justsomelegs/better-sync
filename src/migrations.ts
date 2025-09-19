import type { DatabaseExecutor, Migration } from './types';

/**
 * Create the core migrations required by the sync engine. These include the
 * migrations ledger and the durable change/version tracking tables.
 */
export function coreMigrations(): Migration[] {
  const m: Migration[] = [];

  m.push({
    id: '001_migrations_ledger',
    up: (db) => {
      if (db.dialect === 'sqlite') {
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          )`,
        );
      } else {
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_migrations (
            id TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`,
        );
      }
    },
  });

  m.push({
    id: '002_change_log_and_versions',
    up: (db) => {
      if (db.dialect === 'sqlite') {
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_versions (
            key TEXT PRIMARY KEY,
            version INTEGER NOT NULL
          )`,
        );
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            record_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            op TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
            payload TEXT,
            ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          )`,
        );
        db.run(
          `CREATE INDEX IF NOT EXISTS idx_changes_ns_rec_ver ON _sync_changes(namespace, record_id, version)`,
        );
      } else {
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_versions (
            key TEXT PRIMARY KEY,
            version BIGINT NOT NULL
          )`,
        );
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_changes (
            id BIGSERIAL PRIMARY KEY,
            namespace TEXT NOT NULL,
            record_id TEXT NOT NULL,
            version BIGINT NOT NULL,
            op TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
            payload JSONB,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`,
        );
        db.run(
          `CREATE INDEX IF NOT EXISTS idx_changes_ns_rec_ver ON _sync_changes(namespace, record_id, version)`,
        );
      }
    },
  });

  m.push({
    id: '003_conflict_resolution_clock',
    up: (db) => {
      if (db.dialect === 'sqlite') {
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_clock (
            namespace TEXT NOT NULL,
            record_id TEXT NOT NULL,
            server_version INTEGER NOT NULL,
            PRIMARY KEY(namespace, record_id)
          )`,
        );
      } else {
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_clock (
            namespace TEXT NOT NULL,
            record_id TEXT NOT NULL,
            server_version BIGINT NOT NULL,
            PRIMARY KEY(namespace, record_id)
          )`,
        );
      }
    },
  });

  m.push({
    id: '004_idempotency',
    up: (db) => {
      if (db.dialect === 'sqlite') {
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_idempotency (
            key TEXT PRIMARY KEY,
            result TEXT,
            version INTEGER,
            ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          )`,
        );
      } else {
        db.run(
          `CREATE TABLE IF NOT EXISTS _sync_idempotency (
            key TEXT PRIMARY KEY,
            result JSONB,
            version BIGINT,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`,
        );
      }
    },
  });

  return m;
}

/**
 * Apply migrations in order, guarding with the migrations ledger.
 */
export async function applyMigrations(
  db: DatabaseExecutor,
  migrations: readonly Migration[],
): Promise<string[]> {
  // Ensure ledger table exists (in case app bypassed core migrations)
  if (db.dialect === 'sqlite') {
    await db.run(
      `CREATE TABLE IF NOT EXISTS _sync_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
    );
  } else {
    await db.run(
      `CREATE TABLE IF NOT EXISTS _sync_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
  }

  const appliedRows = await db.all<{ id: string }>(
    `SELECT id FROM _sync_migrations ORDER BY applied_at ASC, id ASC`,
  );
  const applied = new Set(appliedRows.map((r) => r.id));
  const appliedOrder: string[] = appliedRows.map((r) => r.id);

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await m.up(tx);
      await tx.run(`INSERT INTO _sync_migrations(id) VALUES (?)`, [m.id]);
    });
    applied.add(m.id);
    appliedOrder.push(m.id);
  }

  return appliedOrder;
}

