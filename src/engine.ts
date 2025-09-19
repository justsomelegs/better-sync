import { ApplyResult, Change, ConflictResolution, LogicalClock, NodeId, PushParams, PullParams, RecordId, SyncEngine, SyncEngineOptions, CollectionSchema } from "./types";
import { randomUUID } from "node:crypto";
import { schemaVersionKey } from "./schema";

/**
 * Internal utility to generate a change envelope.
 */
function createChange<T>(params: { collection: string; recordId: RecordId; op: "put" | "delete"; data?: T; clk: LogicalClock; nodeId: NodeId }): Change<T> {
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
export class SyncEngineImpl<Schemas extends Record<string, CollectionSchema<any>>> implements SyncEngine<Schemas> {
  public readonly nodeId: NodeId;
  private readonly resolution: ConflictResolution;
  private readonly db: SyncEngineOptions<Schemas>["db"];
  private readonly schemas: Schemas;

  constructor(options: SyncEngineOptions<Schemas>) {
    this.db = options.db;
    this.nodeId = options.nodeId ?? `${this.db.vendor}-${Math.random().toString(36).slice(2)}`;
    this.resolution = options.resolution ?? "lastWriteWins";
    this.schemas = options.schemas;
  }

  async init(): Promise<void> {
    await this.db.init();
  }

  async migrate(): Promise<void> {
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
          const entries = await this.db.listEntries<any>(name, batchSize, offset);
          if (entries.length === 0) break;
          for (const { id, data } of entries) {
            const upgraded = schema.upgrade(storedVersion, data);
            // Apply as a local change with preserved semantics
            const clk = await this.db.tick();
            const ch: Change<any> = {
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
          if (entries.length < batchSize) break;
        }
        await this.db.setMeta(key, String(currentVersion));
      }
    }
  }

  async now(): Promise<LogicalClock> {
    return this.db.now();
  }

  async put<K extends keyof Schemas & string>(collection: K, id: RecordId, value: ReturnType<Schemas[K]["parse"]>): Promise<ApplyResult<ReturnType<Schemas[K]["parse"]>>> {
    const schema = this.schemas[collection] as Schemas[K];
    const parsed = (schema as CollectionSchema<any>).parse(value) as ReturnType<Schemas[K]["parse"]>;
    const clk = await this.db.tick();
    const change = createChange({ collection, recordId: id, op: "put", data: parsed, clk, nodeId: this.nodeId });
    return this.db.applyChange(change, this.resolution) as Promise<ApplyResult<ReturnType<Schemas[K]["parse"]>>>;
  }

  async delete(collection: keyof Schemas & string, id: RecordId): Promise<ApplyResult<unknown>> {
    const clk = await this.db.tick();
    const change = createChange({ collection, recordId: id, op: "delete", clk, nodeId: this.nodeId });
    return this.db.applyChange(change, this.resolution);
  }

  async get<K extends keyof Schemas & string>(collection: K, id: RecordId): Promise<ReturnType<Schemas[K]["parse"]> | undefined> {
    return this.db.getRecord(collection, id) as Promise<ReturnType<Schemas[K]["parse"]> | undefined>;
  }

  async list<K extends keyof Schemas & string>(collection: K, limit = 1000, offset = 0): Promise<ReturnType<Schemas[K]["parse"]>[]> {
    return this.db.listRecords(collection, limit, offset) as Promise<ReturnType<Schemas[K]["parse"]>[]>;
  }

  async pull(params: PullParams): Promise<Change[]> {
    return this.db.getChangesSince(params.since, params.limit);
  }

  async push(params: PushParams): Promise<void> {
    await this.db.ingestChanges(params.changes, this.resolution);
  }
}

