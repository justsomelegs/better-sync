export function sqlite(options: { file: string; ensureSchema?: boolean; autoMigrate?: boolean }) {
  return { dialect: "sqlite", options } as const;
}
export function postgres(options: { connectionString?: string; pool?: unknown }) {
  return { dialect: "postgres", options } as const;
}
