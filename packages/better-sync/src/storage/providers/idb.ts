export function idb(options: { dbName: string }) {
  return { kind: "idb", options } as const;
}
