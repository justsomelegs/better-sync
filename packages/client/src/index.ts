type SchemaLike = Record<string, unknown>;

export type ClientOptions = {
  baseURL: string;
  realtime?: 'sse' | 'poll' | 'off';
  pollIntervalMs?: number;
};

export function createClient<TSchema extends SchemaLike>(options: ClientOptions) {
  const client: Record<string, unknown> = {};
  // Placeholder API surfaces to be implemented next, matching MVP spec.
  return client as unknown as {
    close(): void;
    [K in keyof TSchema & string]: {
      select: (
        idOrQuery: string | Record<string, unknown> | { where?: (row: any) => boolean; select?: readonly string[]; orderBy?: any; limit?: number; cursor?: string },
        opts?: { select?: readonly string[] }
      ) => Promise<any>;
      watch: (
        idOrQuery: string | Record<string, unknown> | { where?: (row: any) => boolean; select?: readonly string[]; orderBy?: any; limit?: number },
        cb: (payload: any) => void,
        opts?: { select?: readonly string[] }
      ) => { unsubscribe(): void; status: 'connecting' | 'live' | 'retrying'; error?: Error; getSnapshot(): any };
      insert: (rowOrRows: any) => Promise<any>;
      update: (idOrWhere: any, patchOrSet: any) => Promise<any>;
      delete: (idOrWhere: any) => Promise<any>;
      $infer: any;
      $pk: any;
    };
  };
}

