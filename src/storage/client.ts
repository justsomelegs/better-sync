export function memory() {
  return {
    async apply() {},
    async reconcile() {},
    async readByPk() { return null; },
    async readWindow() { return { data: [], nextCursor: null }; },
  } as const;
}

export function absurd() {
  // Placeholder: real impl would wire absurd-sql in a web worker
  return {
    async apply() {},
    async reconcile() {},
    async readByPk() { return null; },
    async readWindow() { return { data: [], nextCursor: null }; },
  } as const;
}
