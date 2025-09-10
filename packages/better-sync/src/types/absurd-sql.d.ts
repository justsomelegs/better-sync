declare module "@jlongster/sql.js" {
  const init: (opts?: { locateFile?: (file: string) => string }) => Promise<any>;
  export default init;
}
declare module "absurd-sql" {
  export class SQLiteFS {
    constructor(fs: any, backend: any);
  }
}
declare module "absurd-sql/dist/indexeddb-backend.js" {
  const IndexedDBBackend: any;
  export default IndexedDBBackend;
}
