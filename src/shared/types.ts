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
}

export interface DatabaseAdapter {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateByPk(table: string, pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }): Promise<Record<string, unknown>>;
  deleteByPk(table: string, pk: PrimaryKey): Promise<{ ok: true }>;
  selectByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null>;
  selectWindow(table: string, req: SelectWindow & { where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }>;
}

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
// `declare module 'just-sync' { interface AppTypes { Schema: { users: User; ... }; Mutators: ... } }`
// to enable zero-generics client typing. Properties are optional so that the library works without augmentation.
export interface AppTypes {
  Schema?: Record<string, Record<string, unknown>>;
  Mutators?: ServerMutatorsSpec;
}

// Utility types for deriving table and row types from AppTypes['Schema'] when provided
export type AppSchema = NonNullable<AppTypes['Schema']> extends Record<string, any> ? NonNullable<AppTypes['Schema']> : {};
export type AppMutators = NonNullable<AppTypes['Mutators']> extends ServerMutatorsSpec ? NonNullable<AppTypes['Mutators']> : {};

export type TableNames<TSchema> = TSchema extends Record<string, any> ? keyof TSchema : never;
export type RowOf<TSchema, K> = K extends keyof TSchema ? TSchema[K] : Record<string, unknown>;
