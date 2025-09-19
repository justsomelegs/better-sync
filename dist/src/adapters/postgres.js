/**
 * Postgres adapter using a minimal client (pg-like) with query method.
 */
export class PostgresAdapter {
    constructor(client, options) {
        this.vendor = "postgres";
        this.client = client;
        this.schema = options?.schema ?? "public";
        this.tablePrefix = options?.tablePrefix ?? "sync";
    }
    t(name) {
        return `${this.schema}."${this.tablePrefix}_${name}"`;
    }
    async init() {
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
    async readClock() {
        const { rows } = await this.client.query(`SELECT v FROM ${this.t("meta")} WHERE k='clock'`);
        return rows[0] ? Number(rows[0].v) : 0;
    }
    async tick() {
        const now = await this.readClock();
        const next = now + 1;
        await this.client.query(`UPDATE ${this.t("meta")} SET v=$1 WHERE k='clock'`, [String(next)]);
        return next;
    }
    async now() {
        return this.readClock();
    }
    resolve(existing, change, resolution) {
        if (!existing)
            return { accept: change.op === "put", merged: change.data };
        if (change.clk > existing.clk) {
            if (change.op === "delete")
                return { accept: true };
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
    async applyChange(change, resolution) {
        await this.client.query(`INSERT INTO ${this.t("changes")} (id, collection, record_id, op, data, clk, node_id, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`, [change.id, change.collection, change.recordId, change.op, change.data ?? null, change.clk, change.nodeId, change.ts]);
        const { rows } = await this.client.query(`SELECT data, clk, node_id FROM ${this.t("records")} WHERE collection=$1 AND record_id=$2`, [change.collection, change.recordId]);
        const existing = rows[0] ? { data: rows[0].data, clk: Number(rows[0].clk), node_id: rows[0].node_id } : undefined;
        const decision = this.resolve(existing, change, resolution);
        if (!decision.accept) {
            return { exists: Boolean(existing), data: existing?.data, noop: true };
        }
        if (change.op === "delete") {
            await this.client.query(`DELETE FROM ${this.t("records")} WHERE collection=$1 AND record_id=$2`, [change.collection, change.recordId]);
            return { exists: false };
        }
        await this.client.query(`INSERT INTO ${this.t("records")} (collection, record_id, data, clk, node_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (collection, record_id) DO UPDATE SET data=EXCLUDED.data, clk=EXCLUDED.clk, node_id=EXCLUDED.node_id`, [change.collection, change.recordId, decision.merged, change.clk, change.nodeId]);
        const currentClock = await this.readClock();
        if (change.clk > currentClock) {
            await this.client.query(`UPDATE ${this.t("meta")} SET v=$1 WHERE k='clock'`, [String(change.clk)]);
        }
        return { exists: true, data: decision.merged };
    }
    async getChangesSince(sinceClk, limit = 1000) {
        const { rows } = await this.client.query(`SELECT id, collection, record_id as "recordId", op, data, clk, node_id as "nodeId", ts FROM ${this.t("changes")} WHERE clk > $1 ORDER BY clk ASC, ts ASC LIMIT $2`, [sinceClk, limit]);
        return rows;
    }
    async ingestChanges(changes, resolution) {
        for (const ch of changes) {
            await this.applyChange(ch, resolution);
        }
    }
    async getRecord(collection, recordId) {
        const { rows } = await this.client.query(`SELECT data FROM ${this.t("records")} WHERE collection=$1 AND record_id=$2`, [collection, recordId]);
        if (rows.length === 0)
            return undefined;
        return rows[0].data;
    }
    async listRecords(collection, limit = 1000, offset = 0) {
        const { rows } = await this.client.query(`SELECT data FROM ${this.t("records")} WHERE collection=$1 ORDER BY record_id LIMIT $2 OFFSET $3`, [collection, limit, offset]);
        return rows.map((r) => r.data);
    }
    async listEntries(collection, limit = 1000, offset = 0) {
        const { rows } = await this.client.query(`SELECT record_id as id, data FROM ${this.t("records")} WHERE collection=$1 ORDER BY record_id LIMIT $2 OFFSET $3`, [collection, limit, offset]);
        return rows.map((r) => ({ id: r.id, data: r.data })).filter((x) => x.data != null);
    }
    async getMeta(key) {
        const { rows } = await this.client.query(`SELECT v FROM ${this.t("meta")} WHERE k=$1`, [key]);
        return rows[0]?.v;
    }
    async setMeta(key, value) {
        await this.client.query(`INSERT INTO ${this.t("meta")} (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [key, value]);
    }
}
//# sourceMappingURL=postgres.js.map