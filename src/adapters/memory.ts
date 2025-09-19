import { ApplyResult, Change, ConflictResolution, DatabaseAdapter, DatabaseVendor, LogicalClock, RecordId } from "../types";

/**
 * In-memory adapter backed by Maps. Useful for tests and examples.
 */
export class InMemoryAdapter implements DatabaseAdapter {
  public readonly vendor: DatabaseVendor = "inmemory";
  private clock: LogicalClock = 0;
  private readonly changes: Change[] = [];
  private readonly collections: Map<string, Map<RecordId, { data: any; clk: LogicalClock; nodeId: string }>> = new Map();
  private readonly meta: Map<string, string> = new Map();

  async init(): Promise<void> {
    // Nothing to initialize
  }

  async tick(): Promise<LogicalClock> {
    this.clock += 1;
    return this.clock;
  }

  async now(): Promise<LogicalClock> {
    return this.clock;
  }

  private getCollection(name: string): Map<RecordId, { data: any; clk: LogicalClock; nodeId: string }> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map();
      this.collections.set(name, col);
    }
    return col;
  }

  private resolve(existing: { data: any; clk: LogicalClock; nodeId: string } | undefined, change: Change, resolution: ConflictResolution): { accept: boolean; merged?: any } {
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
    const col = this.getCollection(change.collection);
    const existing = col.get(change.recordId);
    const decision = this.resolve(existing, change, resolution);

    // Append to changelog idempotently: ensure uniqueness by id
    if (!this.changes.find((c) => c.id === change.id)) {
      this.changes.push(change);
      // Keep sorted by clk ascending for deterministic reads
      this.changes.sort((a, b) => a.clk - b.clk || a.ts - b.ts);
      if (change.clk > this.clock) this.clock = change.clk;
    }

    if (!decision.accept) {
      const after = col.get(change.recordId);
      return { exists: Boolean(after), data: after?.data, noop: true } as ApplyResult<T>;
    }

    if (change.op === "delete") {
      col.delete(change.recordId);
      return { exists: false };
    }

    col.set(change.recordId, { data: decision.merged as T, clk: change.clk, nodeId: change.nodeId });
    return { exists: true, data: decision.merged as T };
  }

  async getChangesSince(sinceClk: LogicalClock, limit = 1000): Promise<Change[]> {
    const out: Change[] = [];
    for (const ch of this.changes) {
      if (ch.clk > sinceClk) {
        out.push(ch);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async ingestChanges(changes: Change[], resolution: ConflictResolution): Promise<void> {
    for (const ch of changes) {
      await this.applyChange(ch as any, resolution);
    }
  }

  async getRecord<T>(collection: string, recordId: RecordId): Promise<T | undefined> {
    const col = this.getCollection(collection);
    return col.get(recordId)?.data as T | undefined;
  }

  async listRecords<T>(collection: string, limit = 1000, offset = 0): Promise<T[]> {
    const col = this.getCollection(collection);
    const items = Array.from(col.values()).slice(offset, offset + limit).map((x) => x.data as T);
    return items;
  }

  async listEntries<T = any>(collection: string, limit = 1000, offset = 0): Promise<{ id: RecordId; data: T }[]> {
    const col = this.getCollection(collection);
    const items = Array.from(col.entries()).slice(offset, offset + limit).map(([id, v]) => ({ id, data: v.data as T }));
    return items;
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.meta.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }
}

