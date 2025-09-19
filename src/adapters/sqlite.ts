import { ApplyResult, Change, ConflictResolution, DatabaseAdapter, DatabaseVendor, LogicalClock, RecordId } from "../types";

/**
 * Minimal SQLite/libSQL adapter.
 *
 * @remarks
 * Works with any client exposing `exec(sql, params?)` and `all(sql, params?)` and `get(sql, params?)` methods
 * similar to `better-sqlite3`, `sqlite3`, or `@libsql/client`.
 */
export class SQLiteAdapter implements DatabaseAdapter {
  public readonly vendor: DatabaseVendor = "sqlite";
  private readonly client: {
    exec: (sql: string, params?: any[]) => Promise<void> | void;
    all: (sql: string, params?: any[]) => Promise<any[]> | any[];
    get?: (sql: string, params?: any[]) => Promise<any> | any;
  };
  private readonly tablePrefix: string;

  constructor(client: SQLiteAdapter["client"], options?: { tablePrefix?: string }) {
    this.client = client;
    this.tablePrefix = options?.tablePrefix ?? "sync";
  }

  private t(name: string): string {
    return `${this.tablePrefix}_${name}`;
  }

  async init(): Promise<void> {
    await this.client.exec(`CREATE TABLE IF NOT EXISTS ${this.t("meta")} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    await this.client.exec(`CREATE TABLE IF NOT EXISTS ${this.t("changes")} (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      op TEXT NOT NULL,
      data TEXT,
      clk INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      ts INTEGER NOT NULL
    )`);
    await this.client.exec(`CREATE INDEX IF NOT EXISTS ${this.t("changes_clk_idx")} ON ${this.t("changes")} (clk)`);
    await this.client.exec(`CREATE TABLE IF NOT EXISTS ${this.t("records")} (
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      data TEXT,
      clk INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      PRIMARY KEY (collection, record_id)
    )`);
    // Initialize clock
    const row = this.client.get ? await this.client.get(`SELECT v FROM ${this.t("meta")} WHERE k='clock'`) : (await this.client.all(`SELECT v FROM ${this.t("meta")} WHERE k='clock'`))[0];
    if (!row) {
      await this.client.exec(`INSERT INTO ${this.t("meta")} (k, v) VALUES ('clock', '0')`);
    }
  }

  private async readClock(): Promise<LogicalClock> {
    const row = this.client.get ? await this.client.get(`SELECT v FROM ${this.t("meta")} WHERE k='clock'`) : (await this.client.all(`SELECT v FROM ${this.t("meta")} WHERE k='clock'`))[0];
    return row ? Number(row.v) : 0;
  }

  async tick(): Promise<LogicalClock> {
    const now = await this.readClock();
    const next = now + 1;
    await this.client.exec(`UPDATE ${this.t("meta")} SET v=? WHERE k='clock'`, [String(next)]);
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
    // Insert change if not exists
    await this.client.exec(
      `INSERT OR IGNORE INTO ${this.t("changes")} (id, collection, record_id, op, data, clk, node_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [change.id, change.collection, change.recordId, change.op, change.data != null ? JSON.stringify(change.data) : null, change.clk, change.nodeId, change.ts]
    );

    // Read existing
    const existing = this.client.get
      ? await this.client.get(`SELECT data, clk, node_id FROM ${this.t("records")} WHERE collection=? AND record_id=?`, [change.collection, change.recordId])
      : (await this.client.all(`SELECT data, clk, node_id FROM ${this.t("records")} WHERE collection=? AND record_id=?`, [change.collection, change.recordId]))[0];

    const parsedExisting = existing ? { data: existing.data != null ? JSON.parse(existing.data) : undefined, clk: Number(existing.clk), node_id: existing.node_id as string } : undefined;
    const decision = this.resolve(parsedExisting, change, resolution);

    if (!decision.accept) {
      const current = parsedExisting;
      return { exists: Boolean(current), data: current?.data, noop: true } as ApplyResult<T>;
    }

    if (change.op === "delete") {
      await this.client.exec(`DELETE FROM ${this.t("records")} WHERE collection=? AND record_id=?`, [change.collection, change.recordId]);
      return { exists: false };
    }

    // Upsert
    await this.client.exec(
      `INSERT INTO ${this.t("records")} (collection, record_id, data, clk, node_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(collection, record_id) DO UPDATE SET data=excluded.data, clk=excluded.clk, node_id=excluded.node_id`,
      [change.collection, change.recordId, JSON.stringify(decision.merged), change.clk, change.nodeId]
    );

    // Bump clock if needed
    const currentClock = await this.readClock();
    if (change.clk > currentClock) {
      await this.client.exec(`UPDATE ${this.t("meta")} SET v=? WHERE k='clock'`, [String(change.clk)]);
    }

    return { exists: true, data: decision.merged as T };
  }

  async getChangesSince(sinceClk: LogicalClock, limit = 1000): Promise<Change[]> {
    const rows = await this.client.all(`SELECT id, collection, record_id as recordId, op, data, clk, node_id as nodeId, ts FROM ${this.t("changes")} WHERE clk > ? ORDER BY clk ASC, ts ASC LIMIT ?`, [sinceClk, limit]);
    return rows.map((r) => ({ ...r, data: r.data != null ? JSON.parse(r.data) : undefined }));
  }

  async ingestChanges(changes: Change[], resolution: ConflictResolution): Promise<void> {
    for (const ch of changes) {
      await this.applyChange(ch as any, resolution);
    }
  }

  async getRecord<T>(collection: string, recordId: RecordId): Promise<T | undefined> {
    const row = this.client.get
      ? await this.client.get(`SELECT data FROM ${this.t("records")} WHERE collection=? AND record_id=?`, [collection, recordId])
      : (await this.client.all(`SELECT data FROM ${this.t("records")} WHERE collection=? AND record_id=?`, [collection, recordId]))[0];
    if (!row) return undefined;
    return row.data != null ? (JSON.parse(row.data) as T) : undefined;
  }

  async listRecords<T>(collection: string, limit = 1000, offset = 0): Promise<T[]> {
    const rows = await this.client.all(
      `SELECT data FROM ${this.t("records")} WHERE collection=? ORDER BY record_id LIMIT ? OFFSET ?`,
      [collection, limit, offset]
    );
    return rows.map((r) => (r.data != null ? JSON.parse(r.data) : undefined)).filter((x) => x != null) as T[];
  }

  async listEntries<T = any>(collection: string, limit = 1000, offset = 0): Promise<{ id: string; data: T }[]> {
    const rows = await this.client.all(
      `SELECT record_id as id, data FROM ${this.t("records")} WHERE collection=? ORDER BY record_id LIMIT ? OFFSET ?`,
      [collection, limit, offset]
    );
    return rows
      .map((r) => ({ id: r.id as string, data: r.data != null ? (JSON.parse(r.data) as T) : undefined }))
      .filter((x) => x.data != null) as { id: string; data: T }[];
  }

  async getMeta(key: string): Promise<string | undefined> {
    const row = this.client.get
      ? await this.client.get(`SELECT v FROM ${this.t("meta")} WHERE k=?`, [key])
      : (await this.client.all(`SELECT v FROM ${this.t("meta")} WHERE k=?`, [key]))[0];
    return row ? (row.v as string) : undefined;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.client.exec(
      `INSERT INTO ${this.t("meta")} (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
      [key, value]
    );
  }
}

