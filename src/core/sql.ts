import type initSqlJs from "sql.js";

export type SqlJsStatic = initSqlJs.SqlJsStatic;
export type SqlDatabase = initSqlJs.Database;
export type SqlQueryResult = initSqlJs.QueryExecResult;

let sqlPromise: Promise<SqlJsStatic> | undefined;

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && Boolean(process.versions?.node);
}

type InitSqlJsModule = {
  default?: typeof initSqlJs | { default?: typeof initSqlJs };
};

function resolveInitSqlJs(mod: unknown): typeof initSqlJs {
  if (typeof mod === "function") return mod as typeof initSqlJs;
  const record = mod as InitSqlJsModule;
  if (typeof record?.default === "function") return record.default;
  if (typeof record?.default?.default === "function") return record.default.default;
  const globalInit = (globalThis as { initSqlJs?: typeof initSqlJs }).initSqlJs;
  if (typeof globalInit === "function") return globalInit;
  throw new Error("Failed to resolve initSqlJs initializer from sql.js");
}

/**
 * Load SQL.js once in either a browser (via Vite WASM URL import) or Node.js.
 */
export function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlPromise) return sqlPromise;

  sqlPromise = (async () => {
    const mod = await import("sql.js");
    const init = resolveInitSqlJs(mod);

    if (isNodeRuntime()) {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
      return init({ locateFile: () => wasmPath });
    }

    const { default: wasmUrl } = await import("sql.js/dist/sql-wasm-browser.wasm?url");
    return init({
      locateFile: () => wasmUrl,
    });
  })();

  return sqlPromise;
}

export async function openSqlite(bytes: Uint8Array | ArrayBuffer): Promise<SqlDatabase> {
  const SQL = await getSqlJs();
  return new SQL.Database(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}
