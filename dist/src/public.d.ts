import { SyncEngineOptions, SyncEngine, CollectionSchema } from "./types";
/**
 * Creates a new sync engine instance for the provided database.
 *
 * @param options - Configuration including the database connection and schema map.
 * @returns A fully configured SyncEngine instance.
 *
 * @remarks
 * This is the main entry point. Users only need to supply a database; all sync logic is handled internally.
 * The engine is stateless aside from data stored in the user's database and is suitable for serverless usage.
 */
export declare function createSyncEngine<Schemas extends Record<string, CollectionSchema<any>>>(options: SyncEngineOptions<Schemas>): SyncEngine<Schemas>;
//# sourceMappingURL=public.d.ts.map