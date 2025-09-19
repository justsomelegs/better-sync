import type { ChangeRow, DatabaseExecutor, PullOptions, PullResult } from './types';

export async function pullChangesSince(
  db: DatabaseExecutor,
  options: PullOptions,
): Promise<PullResult> {
  const since = options.since ?? 0;
  const limit = options.limit ?? 1000;
  const ns = options.namespace;

  let sql = `SELECT id, namespace, record_id, version, op, payload, ts FROM _sync_changes WHERE version > ${db.dialect === 'sqlite' ? '?' : '$1'}`;
  const params: unknown[] = [since];
  if (ns) {
    sql += ` AND namespace = ${db.dialect === 'sqlite' ? '?' : '$2'}`;
    params.push(ns);
  }
  sql += ` ORDER BY version ASC, id ASC LIMIT ${db.dialect === 'sqlite' ? '?' : (ns ? '$3' : '$2')}`;
  params.push(limit);

  const rows = await db.all<ChangeRow>(sql, params);
  // Normalize payload type for sqlite (stored as TEXT)
  const normalized = rows.map((r) => ({
    ...r,
    payload: typeof r.payload === 'string' ? (r.payload ? JSON.parse(r.payload) : null) : (r.payload as any),
  }));
  const lastVersion = normalized.length > 0 ? normalized[normalized.length - 1]!.version : since;
  return { changes: normalized, lastVersion };
}

