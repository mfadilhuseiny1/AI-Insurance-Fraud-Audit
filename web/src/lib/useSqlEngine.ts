"use client";

import { useEffect, useState } from "react";
import type { SqlRuntime } from "./pipeline";
import { makeSqlEngine, type SqlJs } from "./sql";

declare global {
  interface Window {
    initSqlJs?: (config: { locateFile: (file: string) => string }) => Promise<SqlJs>;
  }
}

const NOT_LOADED: SqlRuntime = { engine: null, error: null };
let runtime: SqlRuntime = NOT_LOADED;
let loading: Promise<SqlRuntime> | null = null;

/** Loads the SQLite runtime (public/sqljs, copied from node_modules by scripts/copy-sqljs.mjs) once per page. */
function loadSqlEngine(): Promise<SqlRuntime> {
  loading ??= new Promise<SqlJs>((resolve, reject) => {
    const init = () => window.initSqlJs!({ locateFile: (file) => `/sqljs/${file}` }).then(resolve, reject);
    if (window.initSqlJs) return init();
    const script = document.createElement("script");
    script.src = "/sqljs/sql-wasm.js";
    script.onload = init;
    script.onerror = () => reject(new Error("Could not load the SQL engine (/sqljs/sql-wasm.js) — run npm install in web/"));
    document.head.appendChild(script);
  }).then(
    (SQL) => (runtime = { engine: makeSqlEngine(SQL), error: null }),
    (e: Error) => (runtime = { engine: null, error: e.message }),
  );
  return loading;
}

/** The SQL engine for steps; starts loading it the first time `needed` is true. */
export function useSqlEngine(needed: boolean): SqlRuntime {
  const [state, setState] = useState(runtime);
  useEffect(() => {
    if (!needed) return;
    let live = true;
    loadSqlEngine().then((r) => live && setState(r));
    return () => {
      live = false;
    };
  }, [needed]);
  return state;
}
