import { CreateSyncEngineOptions, SyncEngine } from './types.mjs';
export { DatabaseAdapter, DatabaseExecutor, Dialect, Migration, MutationInput, MutationOp, MutationResult } from './types.mjs';

/**
 * Create the Sync Engine instance.
 *
 * Step 1 focuses on bootstrapping core tables and applying migrations. Future
 * steps will add change capture, conflict resolution, and query APIs.
 *
 * @param options - Engine creation options including the application-provided database executor.
 * @returns A SyncEngine instance with basic schema/migration helpers.
 */
declare function createSyncEngine(options: CreateSyncEngineOptions): Promise<SyncEngine>;

export { CreateSyncEngineOptions, SyncEngine, createSyncEngine };
