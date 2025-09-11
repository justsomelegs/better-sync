export type Primitive = string | number | boolean | null;

export type TableSchema = unknown; // BYO (Zod/ArkType/TS-only)

export type CollectionConfig =
  | TableSchema
  | {
      table?: string;
      primaryKey?: readonly string[];
      updatedAt?: string;
      schema: TableSchema;
    };

export type SchemaObject = Record<string, CollectionConfig>;

export type CreateSyncOptions = {
  schema: SchemaObject;
  storage: {
    insert: (table: string, row: Record<string, unknown>) => Promise<Record<string, unknown>>;
    updateByPk: (table: string, pk: Record<string, unknown>, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
    deleteByPk: (table: string, pk: Record<string, unknown>) => Promise<{ ok: true }>;
    selectByPk: (table: string, pk: Record<string, unknown>, select?: readonly string[]) => Promise<Record<string, unknown> | null>;
    selectPage: (table: string, args: {
      select?: readonly string[];
      orderBy?: Record<string, 'asc' | 'desc'> | readonly Record<string, 'asc' | 'desc'>[];
      limit?: number;
      cursor?: string | undefined;
      wherePredicate?: (row: Record<string, unknown>) => boolean; // client-side eval in MVP
    }) => Promise<{ data: Record<string, unknown>[]; nextCursor?: string }>;
  };
};

export type HttpHandlers = {
  handler: unknown;
  fetch: (req: Request) => Promise<Response>;
  nextHandlers: () => { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> };
};

export function createSync(options: CreateSyncOptions): HttpHandlers {
  // Placeholder: transport and router are internal; return minimal stubs for now.
  const fetch = async (req: Request) => new Response('not implemented', { status: 501 });
  const handler = {} as unknown;
  const nextHandlers = () => ({ GET: fetch, POST: fetch });
  return { handler, fetch, nextHandlers };
}

