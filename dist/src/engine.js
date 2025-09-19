import { randomUUID } from "node:crypto";
import { schemaVersionKey } from "./schema";
/**
 * Internal utility to generate a change envelope.
 */
function createChange(params) {
    return {
        id: randomUUID(),
        collection: params.collection,
        recordId: params.recordId,
        op: params.op,
        data: params.data,
        clk: params.clk,
        nodeId: params.nodeId,
        ts: Date.now(),
    };
}
/**
 * Core implementation of the SyncEngine.
 *
 * @typeParam Schemas - Map of collection names to their `CollectionSchema` definitions.
 *
 * @remarks
 * This class is exported for advanced use-cases. Most applications should prefer `createSyncEngine`.
 */
export class SyncEngineImpl {
    constructor(options) {
        this.db = options.db;
        this.nodeId = options.nodeId ?? `${this.db.vendor}-${Math.random().toString(36).slice(2)}`;
        this.resolution = options.resolution ?? "lastWriteWins";
        this.schemas = options.schemas;
    }
    async init() {
        await this.db.init();
    }
    async migrate() {
        // Per-collection, ensure stored schema version, upgrade existing records if needed
        for (const [name, schema] of Object.entries(this.schemas)) {
            const key = schemaVersionKey(name);
            const stored = await this.db.getMeta(key);
            const currentVersion = schema.version;
            const storedVersion = stored ? Number(stored) : 0;
            if (storedVersion === 0) {
                // First write of version
                await this.db.setMeta(key, String(currentVersion));
                continue;
            }
            if (storedVersion < currentVersion) {
                if (!schema.upgrade) {
                    // No upgrader; we still set the new version to unblock, but we do not modify data
                    await this.db.setMeta(key, String(currentVersion));
                    continue;
                }
                // Upgrade all entries
                const batchSize = 500;
                let offset = 0;
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const entries = await this.db.listEntries(name, batchSize, offset);
                    if (entries.length === 0)
                        break;
                    for (const { id, data } of entries) {
                        const upgraded = schema.upgrade(storedVersion, data);
                        // Apply as a local change with preserved semantics
                        const clk = await this.db.tick();
                        const ch = {
                            id: randomUUID(),
                            collection: name,
                            recordId: id,
                            op: "put",
                            data: upgraded,
                            clk,
                            nodeId: this.nodeId,
                            ts: Date.now(),
                        };
                        await this.db.applyChange(ch, this.resolution);
                    }
                    offset += entries.length;
                    if (entries.length < batchSize)
                        break;
                }
                await this.db.setMeta(key, String(currentVersion));
            }
        }
    }
    async now() {
        return this.db.now();
    }
    async put(collection, id, value) {
        const schema = this.schemas[collection];
        const parsed = schema.parse(value);
        const clk = await this.db.tick();
        const change = createChange({ collection, recordId: id, op: "put", data: parsed, clk, nodeId: this.nodeId });
        return this.db.applyChange(change, this.resolution);
    }
    async delete(collection, id) {
        const clk = await this.db.tick();
        const change = createChange({ collection, recordId: id, op: "delete", clk, nodeId: this.nodeId });
        return this.db.applyChange(change, this.resolution);
    }
    async get(collection, id) {
        return this.db.getRecord(collection, id);
    }
    async list(collection, limit = 1000, offset = 0) {
        return this.db.listRecords(collection, limit, offset);
    }
    async pull(params) {
        return this.db.getChangesSince(params.since, params.limit);
    }
    async push(params) {
        await this.db.ingestChanges(params.changes, this.resolution);
    }
}
//# sourceMappingURL=engine.js.map