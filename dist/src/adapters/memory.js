/**
 * In-memory adapter backed by Maps. Useful for tests and examples.
 */
export class InMemoryAdapter {
    constructor() {
        this.vendor = "inmemory";
        this.clock = 0;
        this.changes = [];
        this.collections = new Map();
        this.meta = new Map();
    }
    async init() {
        // Nothing to initialize
    }
    async tick() {
        this.clock += 1;
        return this.clock;
    }
    async now() {
        return this.clock;
    }
    getCollection(name) {
        let col = this.collections.get(name);
        if (!col) {
            col = new Map();
            this.collections.set(name, col);
        }
        return col;
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
        const col = this.getCollection(change.collection);
        const existing = col.get(change.recordId);
        const decision = this.resolve(existing, change, resolution);
        // Append to changelog idempotently: ensure uniqueness by id
        if (!this.changes.find((c) => c.id === change.id)) {
            this.changes.push(change);
            // Keep sorted by clk ascending for deterministic reads
            this.changes.sort((a, b) => a.clk - b.clk || a.ts - b.ts);
            if (change.clk > this.clock)
                this.clock = change.clk;
        }
        if (!decision.accept) {
            const after = col.get(change.recordId);
            return { exists: Boolean(after), data: after?.data, noop: true };
        }
        if (change.op === "delete") {
            col.delete(change.recordId);
            return { exists: false };
        }
        col.set(change.recordId, { data: decision.merged, clk: change.clk, nodeId: change.nodeId });
        return { exists: true, data: decision.merged };
    }
    async getChangesSince(sinceClk, limit = 1000) {
        const out = [];
        for (const ch of this.changes) {
            if (ch.clk > sinceClk) {
                out.push(ch);
                if (out.length >= limit)
                    break;
            }
        }
        return out;
    }
    async ingestChanges(changes, resolution) {
        for (const ch of changes) {
            await this.applyChange(ch, resolution);
        }
    }
    async getRecord(collection, recordId) {
        const col = this.getCollection(collection);
        return col.get(recordId)?.data;
    }
    async listRecords(collection, limit = 1000, offset = 0) {
        const col = this.getCollection(collection);
        const items = Array.from(col.values()).slice(offset, offset + limit).map((x) => x.data);
        return items;
    }
    async listEntries(collection, limit = 1000, offset = 0) {
        const col = this.getCollection(collection);
        const items = Array.from(col.entries()).slice(offset, offset + limit).map(([id, v]) => ({ id, data: v.data }));
        return items;
    }
    async getMeta(key) {
        return this.meta.get(key);
    }
    async setMeta(key, value) {
        this.meta.set(key, value);
    }
}
//# sourceMappingURL=memory.js.map