declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => any;
  }
  export default function initSqlJs(opts?: { locateFile?: (path: string) => string }): Promise<SqlJsStatic>;
}
