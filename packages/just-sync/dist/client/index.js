export function createClient(opts) {
    const baseURL = opts.baseURL.replace(/\/$/, "");
    const pollInterval = opts.pollIntervalMs ?? 1500;
    const mode = opts.realtime ?? "sse";
    let lastEventId;
    let es = null;
    const listeners = new Set();
    function startSse() {
        if (mode !== "sse")
            return;
        try {
            es = new EventSource(`${baseURL}/events`, { withCredentials: false });
            es.onmessage = (e) => {
                lastEventId = e.lastEventId || undefined;
                const data = JSON.parse(e.data);
                for (const l of listeners)
                    l(data);
            };
            es.onerror = () => {
                // noop basic retry by reconnecting
                es?.close();
                setTimeout(() => startSse(), 1000);
            };
        }
        catch {
            // fall back to polling
        }
    }
    if (mode === "sse")
        startSse();
    async function post(path, body) {
        const res = await fetch(`${baseURL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        if (!res.ok)
            throw new Error(`Request failed: ${res.status}`);
        return (await res.json());
    }
    function table(name) {
        return {
            async select(pkOrQuery, opts) {
                if (typeof pkOrQuery === "string" || typeof pkOrQuery === "number" || (pkOrQuery && !("limit" in pkOrQuery))) {
                    const res = (await post(`/selectByPk`, { table: name, pk: pkOrQuery, select: opts?.select }));
                    return res.row;
                }
                const res = (await post(`/select`, { table: name, ...(pkOrQuery ?? {}) }));
                return res;
            },
            async insert(row) {
                return (await post(`/mutate`, { op: "insert", table: name, rows: row }));
            },
            async update(pk, set, opts) {
                return (await post(`/mutate`, { op: "update", table: name, pk, set, ifVersion: opts?.ifVersion }));
            },
            async delete(pk) {
                return (await post(`/mutate`, { op: "delete", table: name, pk }));
            },
            watch(pkOrQuery, cb, opts) {
                let status = "connecting";
                const unsub = () => {
                    // no state to tear down in MVP client
                };
                // naive approach: initial snapshot then subscribe to all events and reselect on any change
                (async () => {
                    if (typeof pkOrQuery === "string" || typeof pkOrQuery === "number" || (pkOrQuery && !("limit" in pkOrQuery))) {
                        const item = await this.select(pkOrQuery, opts);
                        cb({ item, change: null, cursor: null });
                    }
                    else {
                        const res = await this.select(pkOrQuery);
                        cb({ data: res.data, changes: null, cursor: res.nextCursor ?? null });
                    }
                    status = "live";
                })();
                const listener = async (_e) => {
                    // For MVP: simply rerun select on any mutation event
                    if (typeof pkOrQuery === "string" || typeof pkOrQuery === "number" || (pkOrQuery && !("limit" in pkOrQuery))) {
                        const item = await this.select(pkOrQuery, opts);
                        cb({ item, change: null, cursor: null });
                    }
                    else {
                        const res = await this.select(pkOrQuery);
                        cb({ data: res.data, changes: null, cursor: res.nextCursor ?? null });
                    }
                };
                listeners.add(listener);
                return { unsubscribe: () => listeners.delete(listener), status };
            }
        };
    }
    return new Proxy({}, {
        get(_target, prop) {
            if (typeof prop !== "string")
                return undefined;
            if (prop === "mutators") {
                return new Proxy({}, {
                    get(_t, name) {
                        return async (args) => post(`/mutators/${String(name)}`, { args });
                    }
                });
            }
            return table(prop);
        }
    });
}
//# sourceMappingURL=index.js.map