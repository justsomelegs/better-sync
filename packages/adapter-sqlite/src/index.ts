export type SqliteAdapterOptions = {
  url: string; // e.g., file:./app.db
};

export function sqliteAdapter(options: SqliteAdapterOptions) {
  // Placeholder adapter with the interface required by @sync/core.
  return {
    async insert(table: string, row: Record<string, unknown>) {
      return row;
    },
    async updateByPk(table: string, pk: Record<string, unknown>, patch: Record<string, unknown>) {
      return { ...pk, ...patch };
    },
    async deleteByPk(table: string, pk: Record<string, unknown>) {
      return { ok: true as const };
    },
    async selectByPk(table: string, pk: Record<string, unknown>, select?: readonly string[]) {
      return null;
    },
    async selectPage(table: string, args: {
      select?: readonly string[];
      orderBy?: Record<string, 'asc' | 'desc'> | readonly Record<string, 'asc' | 'desc'>[];
      limit?: number;
      cursor?: string | undefined;
      wherePredicate?: (row: Record<string, unknown>) => boolean;
    }) {
      return { data: [], nextCursor: undefined as string | undefined };
    }
  };
}

