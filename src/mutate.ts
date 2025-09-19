import type { DatabaseExecutor, MutationInput, MutationResult } from './types';
import { shouldApplyMutation } from './conflicts';

function ensureNamespaceTable(db: DatabaseExecutor, namespace: string) {
  if (db.dialect === 'sqlite') {
    db.run(
      `CREATE TABLE IF NOT EXISTS ${JSON.stringify(namespace)} (
        id TEXT PRIMARY KEY,
        doc TEXT
      )`,
    );
  } else {
    db.run(
      `CREATE TABLE IF NOT EXISTS ${JSON.stringify(namespace)} (
        id TEXT PRIMARY KEY,
        doc JSONB
      )`,
    );
  }
}

async function getNextGlobalVersion(db: DatabaseExecutor): Promise<number> {
  if (db.dialect === 'sqlite') {
    const row = await db.get<{ version: number }>(
      `SELECT version FROM _sync_versions WHERE key = 'global'`,
    );
    if (!row) {
      await db.run(`INSERT INTO _sync_versions(key, version) VALUES ('global', 1)`);
      return 1;
    }
    const next = (row.version ?? 0) + 1;
    await db.run(`UPDATE _sync_versions SET version = ? WHERE key = 'global'`, [next]);
    return next;
  } else {
    const row = await db.get<{ version: number }>(
      `SELECT version FROM _sync_versions WHERE key = 'global'`,
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

function upsertClock(db: DatabaseExecutor, namespace: string, recordId: string, serverVersion: number) {
  if (db.dialect === 'sqlite') {
    db.run(
      `INSERT INTO _sync_clock(namespace, record_id, server_version) VALUES (?, ?, ?)
       ON CONFLICT(namespace, record_id) DO UPDATE SET server_version = excluded.server_version`,
      [namespace, recordId, serverVersion],
    );
  } else {
    db.run(
      `INSERT INTO _sync_clock(namespace, record_id, server_version) VALUES ($1, $2, $3)
       ON CONFLICT(namespace, record_id) DO UPDATE SET server_version = EXCLUDED.server_version`,
      [namespace, recordId, serverVersion],
    );
  }
}

function insertChange(
  db: DatabaseExecutor,
  namespace: string,
  recordId: string,
  version: number,
  op: string,
  payload: unknown,
) {
  if (db.dialect === 'sqlite') {
    db.run(
      `INSERT INTO _sync_changes(namespace, record_id, version, op, payload) VALUES (?, ?, ?, ?, ?)`,
      [namespace, recordId, version, op, payload == null ? null : JSON.stringify(payload)],
    );
  } else {
    db.run(
      `INSERT INTO _sync_changes(namespace, record_id, version, op, payload) VALUES ($1, $2, $3, $4, $5)`,
      [namespace, recordId, version, op, payload == null ? null : payload],
    );
  }
}

function applyToNamespaceTable(
  db: DatabaseExecutor,
  namespace: string,
  recordId: string,
  op: 'insert' | 'update' | 'delete',
  payload: unknown,
) {
  ensureNamespaceTable(db, namespace);
  if (op === 'delete') {
    db.run(`DELETE FROM ${JSON.stringify(namespace)} WHERE id = ${db.dialect === 'sqlite' ? '?' : '$1'}`, [recordId]);
    return;
  }
  // server-wins: last write replaces doc
  if (db.dialect === 'sqlite') {
    db.run(
      `INSERT INTO ${JSON.stringify(namespace)}(id, doc) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET doc = excluded.doc`,
      [recordId, JSON.stringify(payload ?? null)],
    );
  } else {
    db.run(
      `INSERT INTO ${JSON.stringify(namespace)}(id, doc) VALUES ($1, $2)
       ON CONFLICT(id) DO UPDATE SET doc = EXCLUDED.doc`,
      [recordId, payload ?? null],
    );
  }
}

export async function applyMutations(
  db: DatabaseExecutor,
  mutations: readonly MutationInput[],
): Promise<MutationResult[]> {
  const results: MutationResult[] = [];
  await db.transaction(async (tx) => {
    for (const m of mutations) {
      // Idempotency shortcut per-mutation
      if (m.idempotencyKey) {
        const existing = await tx.get<{ result: string | null; version: number | null }>(
          `SELECT result, version FROM _sync_idempotency WHERE key = ${tx.dialect === 'sqlite' ? '?' : '$1'}`,
          [m.idempotencyKey],
        );
        if (existing) {
          const parsed = existing.result ? JSON.parse(existing.result) : undefined;
          results.push(parsed as MutationResult);
          continue;
        }
      }

      const clock = await tx.get<{ server_version: number }>(
        `SELECT server_version FROM _sync_clock WHERE namespace = ${tx.dialect === 'sqlite' ? '?' : '$1'} AND record_id = ${tx.dialect === 'sqlite' ? '?' : '$2'}`,
        [m.namespace, m.recordId],
      );
      const current = clock?.server_version ?? 0;
      const decision = shouldApplyMutation(current, m);
      if (!decision.apply) {
        // conflict: server wins, record intent as a change for audit
        insertChange(tx, m.namespace, m.recordId, current, 'update', m.payload ?? null);
        const conflictResult: MutationResult = { applied: false, serverVersion: current, conflict: { reason: decision.reason ?? 'conflict', serverVersion: current } };
        if (m.idempotencyKey) {
          tx.run(
            `INSERT INTO _sync_idempotency(key, result, version) VALUES (${tx.dialect === 'sqlite' ? '?, ?, ?' : '$1, $2, $3'})`,
            [m.idempotencyKey, JSON.stringify(conflictResult), current],
          );
        }
        results.push(conflictResult);
        continue;
      }
      const nextVersion = await getNextGlobalVersion(tx);
      insertChange(tx, m.namespace, m.recordId, nextVersion, m.op, m.payload ?? null);
      upsertClock(tx, m.namespace, m.recordId, nextVersion);
      applyToNamespaceTable(tx, m.namespace, m.recordId, m.op, m.payload ?? null);
      const successResult: MutationResult = { applied: true, serverVersion: nextVersion };
      if (m.idempotencyKey) {
        tx.run(
          `INSERT INTO _sync_idempotency(key, result, version) VALUES (${tx.dialect === 'sqlite' ? '?, ?, ?' : '$1, $2, $3'})`,
          [m.idempotencyKey, JSON.stringify(successResult), nextVersion],
        );
      }
      results.push(successResult);
    }
  });
  return results;
}

