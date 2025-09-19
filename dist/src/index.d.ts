export * from "./types";
export * from "./engine";
export * from "./schema";
export * from "./adapters";
/**
 * Creates a new sync engine instance for the provided database.
 *
 * @param options - Configuration including the database connection and optional settings.
 * @returns A fully configured SyncEngine instance.
 *
 * @remarks
 * This is the main entry point. Users only need to supply a database via an adapter; all sync logic is handled internally.
 */
export { createSyncEngine } from "./public";
//# sourceMappingURL=index.d.ts.map