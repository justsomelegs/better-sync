/** Discriminated success/error result returned by most APIs. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: SyncError };
/** Stable error codes surfaced to clients. */
export type SyncErrorCode =
  | "SYNC:UNAUTHORIZED"   // 401
  | "SYNC:FORBIDDEN"      // 403
  | "SYNC:CURSOR_STALE"   // client needs to re-pull
  | "SYNC:RATE_LIMITED"   // 429
  | "SYNC:SERVER_ERROR"    // 5xx fallback
  | "SYNC:CHANGE_REJECTED"; // invalid payload or server-side validation failed
/** Structured error returned in Result when ok=false. */
export interface SyncError { code: SyncErrorCode; message: string; helpUrl?: string; meta?: Record<string, unknown> }

// Public re-export for serializer type used in config
export type { ModelSerializer } from "../internal/serializer.js";

/** Map of model name → row type. Provided via defineSchema and used to type the client. */
export type SchemaModels = Record<string, unknown>;
/** Extract the string model names from a schema. */
export type ModelName<TSchema extends SchemaModels> = Extract<keyof TSchema, string>;
/** Row type for a given model name in a schema. */
export type RowOf<TSchema extends SchemaModels, TModel extends ModelName<TSchema>> = TSchema[TModel];

/** Generic change shape used by client/server sync flows. */
export interface Change {
  /** Target model name. */
  model: string;
  /** Operation semantics. */
  type: "insert" | "update" | "delete";
  /** Stable primary key. */
  id: string;
  /** Full value for inserts/overwrites. */
  value?: any;
  /** Partial update shape for updates. */
  patch?: Record<string, unknown>;
  /** Optional conflict clock: last-write-wins by ts; actorId tie-breaker. */
  clock?: { ts?: number | string; actorId?: string };
}

/** Optional metrics/events hook fired by the client to aid observability. */
export type SyncClientMetricEvents = {
  connect: { transport: "ws" | "http" };
  applyQueued: { model: string };
  applySent: { count: number; model: string };
  applyAck: { count: number; model: string };
  poke: { model?: string };
  pull: { model?: string };
  backoff: { attempt: number; nextMs: number };
  status: SyncClientStatus;
  retry?: { count: number; model?: string };
};
export interface SyncClientMetrics {
  on<E extends keyof SyncClientMetricEvents>(event: E, data: SyncClientMetricEvents[E]): void;
}
/** High-level connection status emitted by the client. */
export type SyncClientStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "connected-ws" }
  | { state: "connected-http" }
  | { state: "backoff"; attempt: number; nextMs: number }
  | { state: "stopped" };
/** Configuration for createClient. Strongly typed by your schema. */
export interface SyncClientConfig<TSchema extends SchemaModels = SchemaModels> {
  /** Server origin, e.g. http://localhost:3000 */
  baseUrl: string;
  /** Mount path for the sync endpoints (default /api/sync). */
  basePath?: string; // defaults to /api/sync
  /** Optional tenant identifier; propagated via x-tenant-id header. */
  tenantId?: string;
  /** Optional metrics hook for debugging/telemetry. */
  metrics?: SyncClientMetrics;
  /** Optional client storage provider used for snapshots/queue persistence. */
  storage?: ClientStorage;
  /** Optional per-model serializers to convert non-JSON types (e.g. bigint/Date) to wire-safe strings. */
  serializers?: Partial<{ [K in ModelName<TSchema>]: import("../internal/serializer.js").ModelSerializer<any, RowOf<TSchema, K>> }>;
  /** Client backoff base (ms). Default 250. */
  backoffBaseMs?: number;
  /** Client backoff max (ms). Default 30000. */
  backoffMaxMs?: number;
  /** Heartbeat/poke check interval (ms). Default 30000. */
  heartbeatMs?: number;
  /** Max in-memory queue size before rejecting new changes. Default Infinity. */
  queueMaxSize?: number;
  /** Max number of changes per batch. Default 1000. */
  batchMaxCount?: number;
  /** Approximate max JSON bytes per batch before flushing. Default 262144 (256KB). */
  batchMaxBytes?: number;
  /** Compress payloads larger than this many bytes (noop placeholder). Default 8192 (8KB). */
  compressMinBytes?: number;
}
/** Strongly-typed client constructed by createClient<typeof schema>(). */
export interface SyncClient<TSchema extends SchemaModels = SchemaModels> {
  /** Start background WS-first connection with HTTP fallback and heartbeats. */
  connect(): Promise<void>;
  /** Subscribe to connection status changes. */
  onStatus(cb: (s: SyncClientStatus) => void): { unsubscribe(): void };
  /** Get current connection status snapshot. */
  getStatus(): SyncClientStatus;
  /** Enqueue a single change for a model. Typed by schema. */
  applyChange<TModel extends ModelName<TSchema>>(model: TModel, change: { type: "insert" | "update" | "delete"; id: string; value?: RowOf<TSchema, TModel>; patch?: Partial<RowOf<TSchema, TModel>> }): Promise<Result<{ queued: boolean }>>;
  /** Enqueue a batch of changes for a model. */
  applyChanges<TModel extends ModelName<TSchema>>(model: TModel, changes: { type: "insert" | "update" | "delete"; id: string; value?: RowOf<TSchema, TModel>; patch?: Partial<RowOf<TSchema, TModel>> }[]): Promise<Result<{ queued: boolean }>>;
  /** Resolve when the internal queue is empty. */
  drain(): Promise<void>;
  /** Live queue stats useful for backpressure/UX. */
  getQueueStats(): { size: number; pendingBatches: number; bytes: number };
  /** Hint whether caller should back off (queue too large). */
  shouldBackOff(): boolean;
  /** Subscribe to a model; optional select narrows the projected row type. */
  subscribeQuery<
    TModel extends ModelName<TSchema>,
    TKeys extends readonly (keyof RowOf<TSchema, TModel>)[] | undefined = undefined,
    TRow = RowOf<TSchema, TModel>,
    TProjected = TKeys extends readonly (keyof TRow)[] ? Pick<TRow, TKeys[number]> : TRow
  >(
    params: { model: TModel; where?: Partial<RowOf<TSchema, TModel>>; select?: TKeys },
    cb: (rows: Array<TProjected>) => void
  ): { unsubscribe(): void };
  /** Pin a server shape for background refresh (HTTP fallback aware). */
  pinShape(shapeId: string): { unpin(): void };
  /** Create a snapshot of local state (no-op placeholder for future). */
  createSnapshot(model?: string): Promise<void> | void;
  /** Return a tenant-bound client that automatically sends x-tenant-id. */
  withTenant(id?: string): SyncClient<TSchema>;
  /** Stop background activities and close connections. */
  stop(): Promise<void> | void;
}

/** Server configuration for the HTTP/WS endpoints. */
export interface SyncServerConfig {
  /** Mount path for the sync endpoints (default /api/sync). */
  basePath?: string; // defaults to /api/sync
  /** Return false to send SYNC:UNAUTHORIZED (401). */
  authorize?: (req: any) => boolean | Promise<boolean>;
  /** Return true to send SYNC:FORBIDDEN (403). */
  forbid?: (req: any) => boolean | Promise<boolean>;
  /** Return true to send SYNC:RATE_LIMITED (429). */
  shouldRateLimit?: (req: any) => boolean | Promise<boolean>;
  /** Optional row-level ACLs. */
  canRead?: (req: any, model: string, row: any) => boolean | Promise<boolean>;
  canWrite?: (req: any, model: string, change: Change) => boolean | Promise<boolean>;
}
export interface SyncServer {
  attachWebSocket?(server: any): any; // optional WS attach helper
  fetch(): any; // framework handler adapter
  api: {
    apply(input: { tenantId?: string; changes: Change[] }): Promise<Result<{ applied: boolean; cursor: Cursor }>>;
    withTenant(id?: string): SyncServer["api"];
    registerShape(input: { tenantId?: string; model: string; where?: Record<string, unknown>; select?: string[] }): Promise<{ id: string }> | { id: string };
  };
}

/** Cursor is an opaque token; compare using string equality, do not parse. */
export type Cursor = string & { readonly __opaque: unique symbol };

/** Minimal client storage interface used by the client for snapshots/persistence. */
export interface ClientStorage {
  put<T>(store: string, key: string, value: T): Promise<void>;
  get<T>(store: string, key: string): Promise<T | undefined>;
  del(store: string, key: string): Promise<void>;
  list<T>(store: string, opts?: { prefix?: string; limit?: number }): Promise<Array<{ key: string; value: T }>>;
  clear(store: string): Promise<void>;
}
