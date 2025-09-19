import { CreateSyncEngineOptions, SyncEngine } from './types.mjs';
export { DatabaseExecutor, Dialect, Migration } from './types.mjs';

/**
 * Create the Sync Engine instance. Step 1 focuses on bootstrapping core tables
 * and applying migrations. Future steps will add change capture, conflict
 * resolution, and query APIs.
 */
declare function createSyncEngine(options: CreateSyncEngineOptions): Promise<SyncEngine>;

export { CreateSyncEngineOptions, SyncEngine, createSyncEngine };
