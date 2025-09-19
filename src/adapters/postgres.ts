import { ApplyResult, Change, ConflictResolution, DatabaseAdapter, DatabaseVendor, LogicalClock, RecordId } from "../types";

/**
 * Postgres adapter using a minimal client (pg-like) with query method.
 */
export class PostgresAdapter implements DatabaseAdapter {
  public readonly vendor: DatabaseVendor = "postgres";
  private readonly client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };
  private readonly schema: string;
  private readonly tablePrefix: string;

  constructor(client: PostgresAdapter["client"], options?: { schema?: string; tablePrefix?: string }) {
    this.client = client;
    this.schema = options?.schema ?? "public";
    this.tablePrefix = options?.tablePrefix ?? "sync";
  }

  private t(name: string): string {
    return `${this.schema}."${this.tablePrefix}_${name}"`;
  }

  async init(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.t("meta")} (k text PRIMARY KEY, v text NOT NULL)`);
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.t("changes")} (
      id text PRIMARY KEY,
      collection text NOT NULL,
      record_id text NOT NULL,
      op text NOT NULL,
      data jsonb,
      clk bigint NOT NULL,
      node_id text NOT NULL,
      ts bigint NOT NULL
    )`);
    await this.client.query(`CREATE INDEX IF NOT EXISTS "${this.tablePrefix}_changes_clk_idx" ON ${this.t("changes")} (clk)`);
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.t("records")} (
      collection text NOT NULL,
      record_id text NOT NULL,
      data jsonb,
      clk bigint NOT NULL,
      node_id text NOT NULL,
      PRIMARY KEY (collection, record_id)
    )`);
    const { rows } = await this.client.query(`SELECT v FROM ${this.t("meta")} WHERE k='clock'`);
    if (rows.length === 0) {
      await this.client.query(`INSERT INTO ${this.t("meta")} (k, v) VALUES ('clock', '0')`);
    }
  }

  private async readClock(): Promise<LogicalClock> {
    const { rows } = await this.client.query(`SELECT v FROM ${this.t("meta")} WHERE k='clock'`);
    return rows[0] ? Number(rows[0].v) : 0;
  }

  async tick(): Promise<LogicalClock> {
    const now = await this.readClock();
    const next = now + 1;
    await this.client.query(`UPDATE ${this.t("meta")} SET v=$1 WHERE k='clock'`, [String(next)]);
    return next;
  }

  async now(): Promise<LogicalClock> {
    return this.readClock();
  }

  private resolve(existing: { data: any; clk: number; node_id: string } | undefined, change: Change, resolution: ConflictResolution): { accept: boolean; merged?: any } {
    if (!existing) return { accept: change.op === "put", merged: change.data };
    if (change.clk > existing.clk) {
      if (change.op === "delete") return { accept: true };
      if (resolution === "lastWriteWins") {
        return { accept: true, merged: change.data };
      }
      if (resolution === "merge") {
        const merged = typeof existing.data === "object" && typeof change.data === "object" ? { ...existing.data, ...change.data } : change.data;
        return { accept: true, merged };
      }
    }
    return { accept: false };
  }

  async applyChange<T>(change: Change<T>, resolution: ConflictResolution): Promise<ApplyResult<T>> {
    await this.client.query(
      `INSERT INTO ${this.t("changes")} (id, collection, record_id, op, data, clk, node_id, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [change.id, change.collection, change.recordId, change.op, change.data ?? null, change.clk, change.nodeId, change.ts]
    );

    const { rows } = await this.client.query(`SELECT data, clk, node_id FROM ${this.t("records")} WHERE collection=$1 AND record_id=$2`, [change.collection, change.recordId]);
    const existing = rows[0] ? { data: rows[0].data, clk: Number(rows[0].clk), node_id: rows[0].node_id as string } : undefined;
    const decision = this.resolve(existing, change, resolution);

    if (!decision.accept) {
      return { exists: Boolean(existing), data: existing?.data, noop: true } as ApplyResult<T>;
    }

    if (change.op === "delete") {
      await this.client.query(`DELETE FROM ${this.t("records")} WHERE collection=$1 AND record_id=$2`, [change.collection, change.recordId]);
      return { exists: false };
    }

    await this.client.query(
      `INSERT INTO ${this.t("records")} (collection, record_id, data, clk, node_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (collection, record_id) DO UPDATE SET data=EXCLUDED.data, clk=EXCLUDED.clk, node_id=EXCLUDED.node_id`,
      [change.collection, change.recordId, decision.merged, change.clk, change.nodeId]
    );

    const currentClock = await this.readClock();
    if (change.clk > currentClock) {
      await this.client.query(`UPDATE ${this.t("meta")} SET v=$1 WHERE k='clock'`, [String(change.clk)]);
    }
    return { exists: true, data: decision.merged as T };
  }

  async getChangesSince(sinceClk: LogicalClock, limit = 1000): Promise<Change[]> {
    const { rows } = await this.client.query(
      `SELECT id, collection, record_id as "recordId", op, data, clk, node_id as "nodeId", ts FROM ${this.t("changes")} WHERE clk > $1 ORDER BY clk ASC, ts ASC LIMIT $2`,
      [sinceClk, limit]
    );
    return rows as Change[];
  }

  async ingestChanges(changes: Change[], resolution: ConflictResolution): Promise<void> {
    for (const ch of changes) {
      await this.applyChange(ch as any, resolution);
    }
  }

  async getRecord<T>(collection: string, recordId: RecordId): Promise<T | undefined> {
    const { rows } = await this.client.query(`SELECT data FROM ${this.t("records")} WHERE collection=$1 AND record_id=$2`, [collection, recordId]);
    if (rows.length === 0) return undefined;
    return rows[0].data as T;
  }

  async listRecords<T>(collection: string, limit = 1000, offset = 0): Promise<T[]> {
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.t("records")} WHERE collection=$1 ORDER BY record_id LIMIT $2 OFFSET $3`,
      [collection, limit, offset]
    );
    return rows.map((r) => r.data as T);
  }

  async listEntries<T = any>(collection: string, limit = 1000, offset = 0): Promise<{ id: string; data: T }[]> {
    const { rows } = await this.client.query(
      `SELECT record_id as id, data FROM ${this.t("records")} WHERE collection=$1 ORDER BY record_id LIMIT $2 OFFSET $3`,
      [collection, limit, offset]
    );
    return rows.map((r) => ({ id: r.id as string, data: r.data as T })).filter((x) => x.data != null);
  }

  async getMeta(key: string): Promise<string | undefined> {
    const { rows } = await this.client.query(`SELECT v FROM ${this.t("meta")} WHERE k=$1`, [key]);
    return rows[0]?.v as string | undefined;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.t("meta")} (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`,
      [key, value]
    );
  }
}

