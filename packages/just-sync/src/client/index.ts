export type OrderBy = Record<string, "asc" | "desc">;

export type SelectWindow = {
  select?: string[];
  orderBy?: OrderBy;
  limit?: number;
  cursor?: string | null;
};

export type PrimaryKey = string | number | Record<string, string | number>;

type WatchStatus = "connecting" | "live" | "retrying";

export type ClientOptions = {
  baseURL: string;
  realtime?: "sse" | "poll" | "off";
  pollIntervalMs?: number;
};

export function createClient<TApp = unknown>(opts: ClientOptions) {
  const baseURL = opts.baseURL.replace(/\/$/, "");
  const pollInterval = opts.pollIntervalMs ?? 1500;
  const mode = opts.realtime ?? "sse";
  let lastEventId: string | undefined;
  let es: EventSource | null = null;

  const listeners = new Set<(ev: unknown) => void>();

  function startSse() {
    if (mode !== "sse") return;
    try {
      es = new EventSource(`${baseURL}/events`, { withCredentials: false });
      es.onmessage = (e) => {
        lastEventId = e.lastEventId || undefined;
        const data = JSON.parse(e.data);
        for (const l of listeners) l(data);
      };
      es.onerror = () => {
        // noop basic retry by reconnecting
        es?.close();
        setTimeout(() => startSse(), 1000);
      };
    } catch {
      // fall back to polling
    }
  }

  if (mode === "sse") startSse();

  async function post(path: string, body: unknown) {
    const res = await fetch(`${baseURL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return (await res.json()) as unknown;
  }

  function table(name: string) {
    const api = {
      async select(pkOrQuery?: PrimaryKey | (SelectWindow & { where?: unknown }), opts?: { select?: string[] }) {
        if (typeof pkOrQuery === "string" || typeof pkOrQuery === "number" || (pkOrQuery && !("limit" in (pkOrQuery as any)))) {
          const res = (await post(`/selectByPk`, { table: name, pk: pkOrQuery, select: opts?.select })) as any;
          return res.row as Record<string, unknown> | null;
        }
        const res = (await post(`/select`, { table: name, ...(pkOrQuery ?? {}) })) as any;
        return res as { data: Record<string, unknown>[]; nextCursor?: string | null };
      },
      async insert(row: Record<string, unknown>) {
        return (await post(`/mutate`, { op: "insert", table: name, rows: row })) as any;
      },
      async update(pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }) {
        return (await post(`/mutate`, { op: "update", table: name, pk, set, ifVersion: opts?.ifVersion })) as any;
      },
      async delete(pk: PrimaryKey) {
        return (await post(`/mutate`, { op: "delete", table: name, pk })) as any;
      },
      watch(
        pkOrQuery: PrimaryKey | (SelectWindow & { where?: unknown }),
        cb: (payload: any) => void,
        opts?: { select?: string[] }
      ) {
        let status: WatchStatus = "connecting";
        const unsub = () => {
          // no state to tear down in MVP client
        };
        // naive approach: initial snapshot then subscribe to all events and reselect on any change
        (async () => {
          if (typeof pkOrQuery === "string" || typeof pkOrQuery === "number" || (pkOrQuery && !("limit" in (pkOrQuery as any)))) {
            const item = await api.select(pkOrQuery, opts);
            cb({ item, change: null, cursor: null });
          } else {
            const res = await api.select(pkOrQuery);
            cb({ data: res.data, changes: null, cursor: res.nextCursor ?? null });
          }
          status = "live";
        })();
        const listener = async (_e: any) => {
          // For MVP: simply rerun select on any mutation event
          if (typeof pkOrQuery === "string" || typeof pkOrQuery === "number" || (pkOrQuery && !("limit" in (pkOrQuery as any)))) {
            const item = await api.select(pkOrQuery, opts);
            cb({ item, change: null, cursor: null });
          } else {
            const res = await api.select(pkOrQuery);
            cb({ data: res.data, changes: null, cursor: res.nextCursor ?? null });
          }
        };
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener), status } as const;
      }
    } as const;
    return api;
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "mutators") {
          return new Proxy(
            {},
            {
              get(_t, name) {
                return async (args: unknown) => post(`/mutators/${String(name)}`, { args });
              }
            }
          );
        }
        return table(prop);
      }
    }
  ) as any as { [K in string]: ReturnType<typeof table> } & { mutators: Record<string, (args: unknown) => Promise<unknown>> } & TApp;
}

