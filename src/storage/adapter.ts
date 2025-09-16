import type { DatabaseAdapter, PrimaryKey } from '../shared/types';

export type MinimalAdapterSpec = {
	begin?(): Promise<void> | void;
	commit?(): Promise<void> | void;
	rollback?(): Promise<void> | void;
	insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
	updateByPk(table: string, pk: PrimaryKey, set: Record<string, unknown>, opts?: { ifVersion?: number }): Promise<Record<string, unknown>> | Record<string, unknown>;
	deleteByPk(table: string, pk: PrimaryKey): Promise<{ ok: true }> | { ok: true };
	selectByPk(table: string, pk: PrimaryKey, select?: string[]): Promise<Record<string, unknown> | null> | (Record<string, unknown> | null);
	selectWindow(table: string, req: { select?: string[]; orderBy?: Record<string,'asc'|'desc'>; limit?: number; cursor?: string | null; where?: unknown }): Promise<{ data: Record<string, unknown>[]; nextCursor?: string | null }> | { data: Record<string, unknown>[]; nextCursor?: string | null };
	ensureMeta?(): Promise<void> | void;
};

export function createAdapter(spec: MinimalAdapterSpec): DatabaseAdapter {
	return {
		async ensureMeta() { if (spec.ensureMeta) await spec.ensureMeta(); },
		async begin() { if (spec.begin) await spec.begin(); },
		async commit() { if (spec.commit) await spec.commit(); },
		async rollback() { if (spec.rollback) await spec.rollback(); },
		async insert(table, row) { return spec.insert(table, row); },
		async updateByPk(table, pk, set, opts) { return spec.updateByPk(table, pk, set, opts); },
		async deleteByPk(table, pk) { return spec.deleteByPk(table, pk); },
		async selectByPk(table, pk, select) { return spec.selectByPk(table, pk, select); },
		async selectWindow(table, req) { return spec.selectWindow(table, req); }
	};
}