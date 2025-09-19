import initSqlJs from 'sql.js';

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
class SQLJsExecutor {
  constructor(db) {
    __publicField(this, "dialect", "sqlite");
    __publicField(this, "db");
    this.db = db;
  }
  /** Create a new in-memory sql.js executor instance. */
  static async create() {
    const SQL = await initSqlJs({});
    const db = new SQL.Database();
    return new SQLJsExecutor(db);
  }
  run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      while (stmt.step()) {
      }
    } finally {
      stmt.free();
    }
  }
  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const rows = [];
    try {
      stmt.bind(params);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        rows.push(row);
      }
    } finally {
      stmt.free();
    }
    return rows;
  }
  get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return void 0;
    } finally {
      stmt.free();
    }
  }
  transaction(fn) {
    this.run("BEGIN");
    try {
      const result = fn(this);
      if (result && typeof result.then === "function") {
        return result.then((value) => {
          this.run("COMMIT");
          return value;
        }).catch((err) => {
          this.run("ROLLBACK");
          throw err;
        });
      }
      this.run("COMMIT");
      return result;
    } catch (err) {
      this.run("ROLLBACK");
      throw err;
    }
  }
}

export { SQLJsExecutor };
