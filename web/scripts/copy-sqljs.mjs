// Copies the sql.js (SQLite in WebAssembly) runtime into public/ so the browser can load it for SQL steps.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(web, "node_modules", "sql.js", "dist");
const to = join(web, "public", "sqljs");
mkdirSync(to, { recursive: true });
for (const file of ["sql-wasm.js", "sql-wasm.wasm"]) copyFileSync(join(from, file), join(to, file));
