import type { DatabaseAdapter } from '../shared/types';

export function sqliteAdapter(_config: { url: string }): DatabaseAdapter {
  // Placeholder minimal shape
  return {
    async begin() {},
    async commit() {},
    async rollback() {},
    async insert() { return {}; },
    async updateByPk() { return {}; },
    async deleteByPk() { return { ok: true }; },
    async selectByPk() { return null; },
    async selectWindow() { return { data: [], nextCursor: null }; },
  };
}
