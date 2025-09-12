declare module 'better-sqlite3' {
  export interface Statement {
    run(...params: any[]): { changes: number; lastInsertRowid: number };
    get<T = any>(...params: any[]): T | undefined;
    all<T = any>(...params: any[]): T[];
  }
  export interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(prag: string): void;
  }
  const DatabaseCtor: {
    new (filename: string): Database;
  };
  export { Database as Database };
  export default DatabaseCtor;
}