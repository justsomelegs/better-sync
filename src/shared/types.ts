export type PrimaryKey = string | number | Record<string, string | number>;
export type OrderBy = Record<string, 'asc' | 'desc'>;
export type SelectWindow = {
  select?: string[];
  orderBy?: OrderBy;
  limit?: number;
  cursor?: string | null;
};

export type VersionedRow<T extends Record<string, unknown> = Record<string, unknown>> = T & { version: number; updatedAt: number };

export interface IdempotencyStore<V = unknown> {
  has(key: string): Promise<boolean> | boolean;
  get(key: string): Promise<V | undefined> | V | undefined;
  set(key: string, value: V): Promise<void> | void;
  acquire?(key: string, ttlMs: number): Promise<{ ok: true } | { ok: false }> | { ok: true } | { ok: false };
  release?(key: string): Promise<void> | void;
}

export type AdapterError = { code: 'CONFLICT' | 'NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL'; message?: string; details?: unknown };

export interface DatabaseAdapter {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateByPk(table: string, pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }): Promise<Record<string, unknown>>;
  deleteByPk(table: string, pk: PrimaryKey): Promise<{ ok: true }>;
  selectByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
  selectWindow(table: string, req: SelectWindow & { where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }>;
  ensureMeta?(): Promise<void>;
}

export type AdapterFactory = (url: string, opts?: Record<string, unknown>) => Promise<DatabaseAdapter> | DatabaseAdapter;

// Mutator typing helpers (for server and client type-safety)
export type MutatorSpec<Args, Result> = { args?: unknown } & Record<string, unknown>;
export type MutatorsSpec = Record<string, MutatorSpec<any, any>>;
export type MutatorArgs<T> = T extends MutatorSpec<infer A, any> ? A : unknown;
export type MutatorResult<T> = T extends MutatorSpec<any, infer R> ? Awaited<R> : unknown;

// Server-side declaration (structure only for typing)
export type ServerMutatorDef<Args, Result> = { args?: unknown; handler: (ctx: any, args: Args) => Promise<Result> | Result };
export type ServerMutatorsSpec = Record<string, ServerMutatorDef<any, any>>;

type ServerMutatorArg<T> = T extends { handler: (ctx: any, args: infer A) => any } ? A : unknown;
type ServerMutatorRet<T> = T extends { handler: (...a: any) => infer R } ? Awaited<R> : unknown;

// Client-side mapper from ServerMutatorsSpec to callable mutators
export type ClientMutatorsFromServer<TSpec extends ServerMutatorsSpec> = {
  [K in keyof TSpec]: (args: ServerMutatorArg<TSpec[K]>) => Promise<ServerMutatorRet<TSpec[K]>>;
};

// Client-side direct mapping from a local MutatorsSpec (when not using server spec)
export type ClientMutators<TSpec extends MutatorsSpec> = {
  [K in keyof TSpec]: (args: MutatorArgs<TSpec[K]>) => Promise<MutatorResult<TSpec[K]>>;
};

export function defineMutators<T extends MutatorsSpec>(spec: T): T { return spec; }

// App-wide type augmentation hook. Libraries/apps can augment this interface via
// `declare module 'just-sync' { interface AppTypes { Schema: any; Mutators: any } }`
// to enable zero-generics client typing.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AppTypes { }
