/*
 * TypeScript functions runner (functions_ts.py): `node runner.cjs <describe|invoke|check> <repo dir> <spec.json>`.
 *
 * Functions are the exported functions of ts-functions/src/**\/*.ts (a default export takes the file's name), and —
 * TypeScript v1 — the decorated methods of exported classes (@Function(), @OntologyEditFunction() + @Edits(...),
 * @Query({ apiName })). The TypeScript compiler reads their signatures (describe) and transpiles the files to CommonJS
 * (invoke); the @osdk/functions, @osdk/client, @osdk/foundry, @ontology/sdk, @foundry/functions-api and
 * @foundry/ontology-api imports resolve to the shims next to this file, which read the Ontology through the platform
 * API with the run's job token (BLUESANDAI_API_URL / BLUESANDAI_API_TOKEN). check (a repository's checks) reports the
 * files' syntax errors, then their type errors against the shims' declarations (types/sdk.d.ts, see typeCheck), and
 * runs the unit tests of *.test.ts / *.spec.ts files (describe / it / expect, see runTests).
 * The result is one JSON line on stdout.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Module = require("module");

const TS_PATH = process.env.BLUESANDAI_TS_PATH || path.join(__dirname, "..", "..", "web", "node_modules", "typescript");
const ts = require(TS_PATH);
const SHIMS = path.join(__dirname, "shims");
const ROOT_DIR = "ts-functions/src";

const TEST_FILE = /\.(test|spec)\.ts$/;

/** The TypeScript files of a folder: the functions' files, or (tests) every file with the unit tests. */
function walk(dir, out = [], tests = false) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, tests);
    else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) && (tests || !TEST_FILE.test(e.name))) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ types

const INJECTED = new Set(["Client", "PlatformClient", "WriteableClient"]);

function typeOf(node, sf) {
  if (!node) return "any";
  const text = node.getText(sf).replace(/\s+/g, "");
  return typeText(text);
}

function typeText(t) {
  t = t.replace(/^Readonly<(.*)>$/, "$1");
  let m;
  if ((m = t.match(/^Promise<(.*)>$/))) return typeText(m[1]);
  if (/^(Edits\.|OntologyEdit)/.test(t) || /^Array<Edits\./.test(t) || /^Edits\..*\[\]$/.test(t) || /^OntologyEdit\[\]$/.test(t)) return "edits";
  if ((m = t.match(/^Array<(.*)>$/)) || (m = t.match(/^(.*)\[\]$/))) return `array<${typeText(m[1])}>`;
  if ((m = t.match(/^(?:Osdk\.Instance|Osdk)<([A-Za-z0-9_]+)(?:,.*)?>$/))) return `object:${m[1]}`;
  if ((m = t.match(/^ObjectSet<([A-Za-z0-9_]+)>$/))) return `object_set:${m[1]}`;
  if ((m = t.match(/^(?:Set|ReadonlyArray)<(.*)>$/))) return `array<${typeText(m[1])}>`;
  if ((m = t.match(/^(?:Record|Map|FunctionsMap)<.*>$/))) return "map";
  if (/\|undefined$|\|null$/.test(t)) return `optional<${typeText(t.replace(/\|(undefined|null)$/, ""))}>`;
  if (t === "string") return "string";
  if (t === "boolean") return "boolean";
  if (["Integer", "Long", "Short", "Byte"].includes(t)) return "integer";
  if (["number", "Double", "Float", "Decimal"].includes(t)) return "double";
  if (["Timestamp", "Date"].includes(t)) return "timestamp";
  if (["LocalDate", "DateISOString"].includes(t)) return "date";
  if (t === "void" || t === "undefined") return "void";
  if (/^\{/.test(t)) return "struct:Struct";
  if (/^[A-Z][A-Za-z0-9_]*$/.test(t)) return `struct:${t}`;
  return "any";
}

const EDITED_TYPE = /Edits\.(?:Object|Interface)<\s*([A-Za-z0-9_]+)\s*>/g;

function declaredEdits(node, sf) {
  // Edits.Object<Employee> | Edits.Interface<Person> | Edits.Link<A, "b"> in the return type, or a WriteableClient<…>
  // first parameter (an interface declares every type implementing it)
  const t = node ? node.getText(sf) : "";
  const out = new Set();
  for (const m of t.matchAll(EDITED_TYPE)) out.add(m[1]);
  for (const m of t.matchAll(/Edits\.Link<\s*([A-Za-z0-9_]+)\s*,\s*["']([A-Za-z0-9_]+)["']\s*>/g)) out.add(`link:${m[1]}.${m[2]}`);
  return [...out];
}

function describeFile(file, repo) {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const rel = path.relative(repo, file).split(path.sep).join("/");
  const aliases = {};
  sf.statements.forEach((s) => {
    if (ts.isTypeAliasDeclaration(s)) aliases[s.name.text] = s.type.getText(sf);
  });
  const out = [];
  const add = (fn, name) => {
    const params = fn.parameters.map((p) => ({ name: p.name.getText(sf), typeNode: p.type, optional: !!p.questionToken || !!p.initializer }));
    const first = params[0] && params[0].typeNode ? params[0].typeNode.getText(sf).replace(/<.*$/, "") : "";
    const injected = INJECTED.has(first) ? params.shift() : null;
    let ret = fn.type;
    let retText = ret ? ret.getText(sf) : "any";
    const aliasName = retText.replace(/^Promise<(.*)>$/, "$1").replace(/\[\]$/, "");
    const edits = declaredEdits(ret, sf).concat(aliases[aliasName] ? [...aliases[aliasName].matchAll(EDITED_TYPE)].map((m) => m[1]) : []);
    if (injected && first === "WriteableClient") {
      const wt = injected.typeNode.getText(sf).replace(/^WriteableClient<(.*)>$/, "$1");
      for (const m of (aliases[wt] || wt).matchAll(EDITED_TYPE)) edits.push(m[1]);
    }
    let output = aliases[aliasName] && /Edits\./.test(aliases[aliasName]) ? "edits" : typeOf(ret, sf);
    const doc = ts.getJSDocCommentsAndTags(fn).map((d) => (typeof d.comment === "string" ? d.comment : "")).join("\n").trim();
    out.push({
      name,
      file: rel,
      doc,
      line: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
      language: "typescript",
      inputs: params.map((p) => ({ name: p.name, type: typeOf(p.typeNode, sf), required: !p.optional })),
      output: injected && first === "WriteableClient" ? output : output,
      api_name: null,
      edits: edits.length || output === "edits" ? [...new Set(edits)] : null,
      sources: [],
      errors: [],
      ...(injected ? { injected: first } : {}),
      ...(injected && first === "WriteableClient" ? { staged_writes: injected.name } : {}),
      kind: output === "edits" || edits.length ? "edit" : "function",
    });
  };
  const base = path.basename(file, ".ts");
  // export const config = { apiName: "…", edits: [Type, …] }: the file's function (its default export, or its only one)
  const config = {};
  sf.statements.forEach((s) => {
    const exported = s.modifiers && s.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported || !ts.isVariableStatement(s)) return;
    for (const d of s.declarationList.declarations) {
      if (d.name.getText(sf) !== "config" || !d.initializer) continue;
      let init = d.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (!ts.isObjectLiteralExpression(init)) continue;
      for (const p of init.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = p.name.getText(sf).replace(/^["']|["']$/g, "");
        if (key === "apiName" && ts.isStringLiteralLike(p.initializer)) config.apiName = p.initializer.text;
        if (key === "edits" && ts.isArrayLiteralExpression(p.initializer)) config.edits = p.initializer.elements.map((e) => e.getText(sf));
      }
    }
  });
  sf.statements.forEach((s) => {
    const exported = s.modifiers && s.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = s.modifiers && s.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(s) && exported) {
      add(s, isDefault ? base : s.name.text);
      if (isDefault) out[out.length - 1].isDefault = true;
    }
    if (ts.isVariableStatement(s) && exported) {
      for (const d of s.declarationList.declarations) {
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) add(d.initializer, d.name.getText(sf));
      }
    }
    if (ts.isExportAssignment(s) && ts.isIdentifier(s.expression)) {
      const target = sf.statements.find((x) => ts.isFunctionDeclaration(x) && x.name && x.name.text === s.expression.text);
      if (target && !out.some((f) => f.name === base)) {
        add(target, base);
        out[out.length - 1].isDefault = true;
      }
    }
  });
  if (config.apiName || config.edits) {
    const target = out.find((f) => f.name === base && f.isDefault) || (out.length === 1 ? out[0] : null);
    if (target) {
      if (config.apiName) target.api_name = config.apiName;
      if (config.edits && config.edits.length) {
        target.edits = [...new Set([...(target.edits || []), ...config.edits])];
        target.kind = "edit";
      }
    }
  }
  out.push(...describeV1(sf, rel));
  return out.map(({ isDefault, ...f }) => f);
}

// TypeScript v1: decorated methods of exported classes (@Function(), @OntologyEditFunction() + @Edits(...),
// @Query({ apiName })); object types are the names imported from @foundry/ontology-api
const V1_DECORATORS = new Set(["Function", "OntologyEditFunction", "Query"]);

function describeV1(sf, rel) {
  const objectTypes = new Set();
  sf.statements.forEach((s) => {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== "@foundry/ontology-api") return;
    const named = s.importClause && s.importClause.namedBindings;
    if (named && ts.isNamedImports(named))
      for (const el of named.elements) if (!["Objects", "ObjectSet", "Filters"].includes(el.name.text)) objectTypes.add(el.name.text);
  });
  const v1Type = (node) => typeOf(node, sf).replace(/struct:([A-Za-z0-9_]+)/g, (m, n) => (objectTypes.has(n) ? `object:${n}` : m));
  const out = [];
  sf.statements.forEach((s) => {
    const exported = s.modifiers && s.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!ts.isClassDeclaration(s) || !exported || !s.name) return;
    for (const m of s.members) {
      if (!ts.isMethodDeclaration(m) || !m.body) continue;
      const decorators = (ts.canHaveDecorators(m) ? ts.getDecorators(m) || [] : []).map((d) => {
        const e = d.expression;
        const callee = ts.isCallExpression(e) ? e.expression : e;
        return { name: callee.getText(sf), args: ts.isCallExpression(e) ? e.arguments : [] };
      });
      const kinds = decorators.filter((d) => V1_DECORATORS.has(d.name));
      if (!kinds.length) continue;
      const isEdit = kinds.some((d) => d.name === "OntologyEditFunction");
      const edits = decorators.filter((d) => d.name === "Edits").flatMap((d) => d.args.map((a) => a.getText(sf)));
      let apiName = null;
      for (const d of decorators.filter((x) => x.name === "Query"))
        for (const a of d.args)
          if (ts.isObjectLiteralExpression(a))
            for (const p of a.properties)
              if (ts.isPropertyAssignment(p) && p.name.getText(sf).replace(/^["']|["']$/g, "") === "apiName" && ts.isStringLiteralLike(p.initializer)) apiName = p.initializer.text;
      const doc = ts.getJSDocCommentsAndTags(m).map((d) => (typeof d.comment === "string" ? d.comment : "")).join("\n").trim();
      out.push({
        name: m.name.getText(sf),
        file: rel,
        doc,
        line: sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1,
        language: "typescript",
        inputs: m.parameters.map((p) => ({ name: p.name.getText(sf), type: v1Type(p.type), required: !p.questionToken && !p.initializer })),
        output: isEdit ? "edits" : v1Type(m.type),
        api_name: apiName,
        edits: isEdit ? [...new Set(edits)] : null,
        sources: [],
        errors: [],
        kind: isEdit ? "edit" : "function",
        typescript_version: 1,
        class: s.name.text,
      });
    }
  });
  return out;
}

function describe(repo) {
  return walk(path.join(repo, ROOT_DIR)).flatMap((f) => describeFile(f, repo));
}

// ------------------------------------------------------------------ invoke

/** Transpile the functions' files (with the unit tests: tests) to outDir; the syntax errors found. */
function transpileAll(repo, outDir, tests = false) {
  const diagnostics = [];
  for (const file of walk(path.join(repo, ROOT_DIR), [], tests)) {
    const rel = path.relative(repo, file);
    const res = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      // experimentalDecorators: TypeScript v1 functions' @Function() / @OntologyEditFunction() / @Edits / @Query
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, experimentalDecorators: true },
      fileName: file,
      reportDiagnostics: true,
    });
    for (const d of res.diagnostics || []) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
      diagnostics.push({ file: rel.split(path.sep).join("/"), line: at.line + 1, column: at.character + 1, code: `TS${d.code}`, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") });
    }
    const dest = path.join(outDir, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, res.outputText);
  }
  return diagnostics;
}

function useShims() {
  // the shims answer the SDK imports
  process.env.NODE_PATH = [SHIMS, process.env.NODE_PATH || ""].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  // the platform SDK's sub-packages (@osdk/foundry.admin, @osdk/foundry.admin/User, …): the functions of platform.js
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const m = /^@osdk\/foundry\.([a-z]+)(?:\/([A-Za-z0-9]+))?$/.exec(request);
    if (m) return require(path.join(SHIMS, "@osdk", "foundry", "platform.js")).subpackage(m[1], m[2]);
    return load.call(this, request, ...rest);
  };
}

// ------------------------------------------------------------------ type check (checks)

const TYPES_DECL = path.join(__dirname, "types", "sdk.d.ts");
// imports answered by the shims: their declarations are types/sdk.d.ts (and the per-check Ontology declarations)
const SDK_MODULE = /^(?:@osdk\/(?:functions(?:\/experimental)?|client|api|foundry(?:\.[a-z]+(?:\/[A-Za-z0-9]+)?)?)|@foundry\/(?:functions-api|ontology-api)|@ontology\/sdk)$/;
const ONTOLOGY_MODULES = { "@ontology/sdk": ["$Queries", "$Objects", "$ObjectTypes", "$Actions", "$Interfaces"], "@foundry/ontology-api": [] };
const V1_FIXED = "export declare const Objects: any;\n  export declare const Filters: any;\n  export declare const ObjectSet: any;\n  export type ObjectSet<T = any> = any;\n";

/**
 * The Ontology's names as the files import them: every name imported from @ontology/sdk or @foundry/ontology-api (an
 * object type, interface or query) is an `any` value and type — the check does not read the Ontology — plus the names
 * read off a namespace import (`import * as sdk` … `sdk.Employee`). Node's built-in modules are untyped (any).
 */
function ontologyDecls(files) {
  const names = Object.fromEntries(Object.entries(ONTOLOGY_MODULES).map(([k, v]) => [k, new Set(v)]));
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
    for (const s of sf.statements) {
      if (!(ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) || !s.moduleSpecifier || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      const set = names[s.moduleSpecifier.text];
      if (!set) continue;
      const bind = ts.isImportDeclaration(s) ? s.importClause && s.importClause.namedBindings : s.exportClause;
      if (bind && (ts.isNamedImports(bind) || ts.isNamedExports(bind))) for (const el of bind.elements) set.add((el.propertyName || el.name).text);
      if (bind && (ts.isNamespaceImport(bind) || ts.isNamespaceExport(bind))) {
        const ns = bind.name.text.replace(/[$]/g, "\\$");
        for (const m of src.matchAll(new RegExp(`\\b${ns}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, "g"))) set.add(m[1]);
      }
    }
  }
  const valid = (n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) && !["default", "Objects", "Filters", "ObjectSet"].includes(n);
  let out = "";
  for (const [mod, set] of Object.entries(names)) {
    out += `declare module "${mod}" {\n  ${mod === "@foundry/ontology-api" ? V1_FIXED : ""}`;
    for (const n of [...set].filter(valid).sort()) out += `  export declare const ${n}: any;\n  export type ${n} = any;\n`;
    out += "}\n";
  }
  for (const b of Module.builtinModules) if (!b.startsWith("_")) out += `declare module "${b}";\ndeclare module "node:${b}";\n`;
  return out;
}

/**
 * Type errors of the functions' and tests' files, checked against the shims' declarations (types/sdk.d.ts): file,
 * line, column, code, message — like the syntax errors. Lenient options (no strict mode) so code that runs is not
 * failed for missing annotations; an import of an npm package (not available here) is an error, as at run time.
 */
function typeCheck(repo) {
  const src = path.join(repo, ROOT_DIR);
  const files = walk(src, [], true);
  const userDecls = [];
  (function decls(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) decls(p);
      else if (/\.d\.ts$/.test(e.name)) userDecls.push(p);
    }
  })(src);
  const generated = path.join(repo, ".bsai-ontology.d.ts");
  fs.writeFileSync(generated, ontologyDecls(files));
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10 || ts.ModuleResolutionKind.NodeJs,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    experimentalDecorators: true,
    resolveJsonModule: true,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options, true);
  host.resolveModuleNames = (names, containing) =>
    names.map((n) => (SDK_MODULE.test(n) || /^(node:)?[a-z_]+$/.test(n) && Module.builtinModules.includes(n.replace(/^node:/, "")) ? undefined : ts.resolveModuleName(n, containing, options, host).resolvedModule));
  const program = ts.createProgram([...files, ...userDecls, TYPES_DECL, generated], options, host);
  const mine = new Set([...files, ...userDecls].map((f) => path.resolve(f).toLowerCase()));
  const out = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error || !d.file || !mine.has(path.resolve(d.file.fileName).toLowerCase())) continue;
    const at = d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    out.push({ file: path.relative(repo, d.file.fileName).split(path.sep).join("/"), line: at.line + 1, column: at.character + 1, code: `TS${d.code}`, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") });
  }
  return out;
}

// ------------------------------------------------------------------ unit tests (checks)

const show = (v) => {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 200 ? s.slice(0, 200) + "..." : s;
  } catch {
    return String(v);
  }
};

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/** Jest's expect, the common matchers: toBe, toEqual, toBeTruthy, toContain, toThrow, ..., .not, .resolves, .rejects. */
function expectOf(actual, negate = false) {
  const assert = (pass, what) => {
    if (pass === negate) throw new Error(`expected ${show(actual)} ${negate ? "not " : ""}${what}`);
  };
  const m = {
    toBe: (x) => assert(Object.is(actual, x), `to be ${show(x)}`),
    toEqual: (x) => assert(deepEqual(actual, x), `to equal ${show(x)}`),
    toStrictEqual: (x) => assert(deepEqual(actual, x), `to equal ${show(x)}`),
    toBeTruthy: () => assert(!!actual, "to be truthy"),
    toBeFalsy: () => assert(!actual, "to be falsy"),
    toBeNull: () => assert(actual === null, "to be null"),
    toBeUndefined: () => assert(actual === undefined, "to be undefined"),
    toBeDefined: () => assert(actual !== undefined, "to be defined"),
    toBeGreaterThan: (x) => assert(actual > x, `to be greater than ${show(x)}`),
    toBeGreaterThanOrEqual: (x) => assert(actual >= x, `to be at least ${show(x)}`),
    toBeLessThan: (x) => assert(actual < x, `to be less than ${show(x)}`),
    toBeLessThanOrEqual: (x) => assert(actual <= x, `to be at most ${show(x)}`),
    toBeCloseTo: (x, digits = 2) => assert(Math.abs(actual - x) < Math.pow(10, -digits) / 2, `to be close to ${show(x)}`),
    toContain: (x) => assert(typeof actual === "string" ? actual.includes(x) : Array.from(actual || []).includes(x), `to contain ${show(x)}`),
    toContainEqual: (x) => assert(Array.from(actual || []).some((y) => deepEqual(y, x)), `to contain ${show(x)}`),
    toHaveLength: (n) => assert(actual != null && actual.length === n, `to have length ${n}`),
    toMatch: (x) => assert(x instanceof RegExp ? x.test(actual) : String(actual).includes(x), `to match ${x}`),
    toThrow: (x) => {
      let e = null;
      try {
        actual();
      } catch (err) {
        e = err || new Error("thrown");
      }
      const fits = !!e && (x === undefined || (x instanceof RegExp ? x.test(e.message) : typeof x === "string" ? String(e.message).includes(x) : e instanceof x));
      if (fits === negate)
        throw new Error(`expected the function ${negate ? "not " : ""}to throw${x === undefined ? "" : " " + (typeof x === "function" ? x.name : show(String(x)))}: ${e ? `it threw ${show(e.message)}` : "it did not throw"}`);
    },
  };
  if (!negate) {
    m.not = expectOf(actual, true);
    m.resolves = new Proxy({}, { get: (_, k) => async (...a) => expectOf(await actual)[k](...a) });
    m.rejects = new Proxy({}, {
      get: (_, k) => async (...a) => {
        let e = null;
        try {
          await actual;
        } catch (err) {
          e = err || new Error("rejected");
        }
        if (!e) throw new Error("expected the promise to reject, it resolved");
        const rethrow = () => {
          throw e;
        };
        return k === "toThrow" ? expectOf(rethrow).toThrow(...a) : expectOf(e)[k](...a);
      },
    });
  }
  return m;
}

/** Run the *.test.ts / *.spec.ts files: describe / it / test (with .skip), beforeEach / afterEach, expect. */
async function runTests(repo, outDir) {
  const results = [];
  for (const file of walk(path.join(repo, ROOT_DIR), [], true).filter((f) => TEST_FILE.test(f)).sort()) {
    const rel = path.relative(repo, file).split(path.sep).join("/");
    const cases = [];
    const scope = [];
    const hooks = { before: [], after: [] };
    const add = (skipped) => (name, fn) => cases.push({ name: [...scope, name].join(" > "), fn, skipped: skipped || typeof fn !== "function", before: hooks.before.slice(), after: hooks.after.slice() });
    const group = (name, fn) => {
      scope.push(name);
      const kept = { before: hooks.before.slice(), after: hooks.after.slice() };
      try {
        fn();
      } finally {
        scope.pop();
        Object.assign(hooks, kept);
      }
    };
    group.skip = () => undefined;
    const it = add(false);
    it.skip = add(true);
    it.todo = add(true);
    Object.assign(global, { describe: group, it, test: it, expect: (v) => expectOf(v), beforeEach: (fn) => hooks.before.push(fn), afterEach: (fn) => hooks.after.push(fn) });
    try {
      require(path.join(outDir, path.relative(repo, file).replace(/\.ts$/, ".js")));
    } catch (e) {
      results.push({ file: rel, name: "(the test file could not be loaded)", line: 0, ok: false, skipped: false, error: `${(e && e.name) || "Error"}: ${(e && e.message) || e}`, ms: 0, output: "" });
      continue;
    }
    for (const c of cases) {
      const started = Date.now();
      let error = null;
      if (!c.skipped) {
        try {
          for (const h of c.before) await h();
          await c.fn();
          for (const h of c.after) await h();
        } catch (e) {
          error = `${(e && e.name) || "Error"}: ${(e && e.message) || e}`;
        }
      }
      results.push({ file: rel, name: c.name, line: 0, ok: !error, skipped: c.skipped, error, ms: Date.now() - started, output: "" });
    }
  }
  return results;
}

/** A repository's checks: syntax errors, the functions that would be published, the unit tests' results. */
async function check(repo) {
  const outDir = path.join(repo, ".ts-out");
  const diagnostics = transpileAll(repo, outDir, true);
  // type errors (against the shims' declarations) once the files parse
  if (!diagnostics.length && process.env.BLUESANDAI_TS_TYPECHECK !== "0") {
    try {
      diagnostics.push(...typeCheck(repo));
    } catch (e) {
      diagnostics.push({ file: "", line: 0, column: 0, code: "typecheck", message: `the type check could not run: ${(e && e.message) || e}` });
    }
  }
  let functions = [];
  try {
    functions = describe(repo).map((f) => ({ name: f.name, file: f.file, kind: f.kind }));
  } catch (e) {
    diagnostics.push({ file: "", line: 0, column: 0, code: "describe", message: `the functions could not be read: ${(e && e.message) || e}` });
  }
  useShims();
  const tests = diagnostics.length ? [] : await runTests(repo, outDir);
  return { ok: true, diagnostics, functions, tests };
}

async function invoke(repo, spec) {
  const outDir = path.join(repo, ".ts-out");
  transpileAll(repo, outDir);
  useShims();
  const rt = require(path.join(SHIMS, "@osdk", "functions", "runtime.js"));
  const sig = describe(repo).find((f) => f.file === spec.file && f.name === spec.function);
  if (!sig) return { ok: false, category: "invalid_inputs", error: `${spec.file} has no function ${spec.function}` };
  const mod = require(path.join(outDir, spec.file.replace(/\.ts$/, ".js")));
  if (sig.typescript_version === 1) return invokeV1(rt, sig, mod, spec);
  const fn = mod[spec.function] || (path.basename(spec.file, ".ts") === spec.function ? mod.default : undefined);
  if (typeof fn !== "function") return { ok: false, category: "invalid_inputs", error: `${spec.function} is not exported` };
  const types = Object.fromEntries(sig.inputs.map((i) => [i.name, i.type]));
  const args = spec.args || {};
  const missing = sig.inputs.filter((i) => i.required && (args[i.name] === undefined || args[i.name] === null)).map((i) => i.name);
  if (missing.length) return { ok: false, category: "invalid_inputs", error: `${missing[0]} is required` };
  // inputs of a scalar type (or arrays of them) must have it: unambiguous strings are converted (numbers, booleans)
  for (const i of sig.inputs) {
    const base = String(i.type).replace(/^(optional<|array<)+|>+$/g, "");
    if (!rt.TYPE_LABEL[base] || args[i.name] === undefined || args[i.name] === null) continue;
    try {
      args[i.name] = await rt.argOf(args[i.name], i.type, i.name, false);
    } catch (e) {
      if (e && e.invalidInput) return { ok: false, category: "invalid_inputs", error: e.message };
      throw e;
    }
  }
  // edit functions (and functions making edit batches): the types and interfaces loaded first, so an edit through an
  // interface is checked at the call
  if (sig.kind === "edit" || /createEditBatch/.test(fs.readFileSync(path.join(repo, spec.file), "utf8"))) await rt.preload();
  const staged = sig.staged_writes ? await rt.beginStaged() : null;
  const call = [];
  if (sig.injected) call.push(sig.injected === "WriteableClient" ? rt.writeableClient(staged) : rt.client());
  for (const i of sig.inputs) call.push(await rt.fromWire(args[i.name], types[i.name]));
  try {
    let value = await fn(...call);
    // nested staged writes: a call inside the transaction failed — every staged edit is discarded, even when the
    // function caught the error (Foundry's rule)
    const nestedFailure = staged ? rt.stagedFailure() : null;
    if (nestedFailure) {
      await rt.endStaged(staged, false);
      return { ok: false, category: "runtime", error: `a call inside the staged-write transaction failed, so every staged edit was discarded: ${nestedFailure}`.slice(0, 2000) };
    }
    // CipherText.updateAsync edits: part of the function's edits, so it must be an Ontology edit function
    const implicit = rt.takeImplicit();
    if (implicit.length && !staged && !(sig.edits && sig.edits.length) && sig.output !== "edits")
      return { ok: false, category: "undeclared_edits", error: "updateAsync edits objects: return Edits.Object<…> (an Ontology edit function) to update CipherText properties" };
    if (staged) {
      staged.batch.edits.push(...implicit);
      const edits = await rt.endStaged(staged, true);
      // a failure the transaction reported only when the run ended (a call a plain query caught, say)
      const lateFailure = rt.stagedFailure();
      if (lateFailure) return { ok: false, category: "runtime", error: `a call inside the staged-write transaction failed, so every staged edit was discarded: ${lateFailure}`.slice(0, 2000) };
      return { ok: true, value: await rt.toWire(value), edits, staged_writes: true, declared_types: await rt.typeIds(sig.edits || []) };
    }
    if (sig.output === "edits" || rt.isEdits(value) || implicit.length) {
      const edits = await rt.editsOf([...(Array.isArray(value) ? value.filter((e) => e && e.__bsaiEdit) : []), ...implicit]);
      const declared = await rt.typeIds(sig.edits || []);
      if (sig.edits && edits.some((e) => e.kind !== "link" && !declared.includes(e.object_type_id)))
        return { ok: false, category: "undeclared_edits", error: "the function edits an object type it does not declare in its Edits type" };
      return { ok: true, edits, declared_types: declared };
    }
    return { ok: true, value: await rt.toWire(value) };
  } catch (e) {
    if (staged) await rt.endStaged(staged, false);
    if (e && e.name === "UserFacingError") return { ok: false, category: "user_facing", user_facing: true, error: e.message };
    return { ok: false, category: "runtime", error: `${(e && e.name) || "Error"}: ${(e && e.message) || e}`, stack: e && e.stack ? String(e.stack).slice(0, 2000) : "" };
  }
}

/** Inputs of a run checked and decoded for a signature (scalar types converted when unambiguous). */
async function inputsOf(rt, sig, spec) {
  const args = spec.args || {};
  const missing = sig.inputs.filter((i) => i.required && (args[i.name] === undefined || args[i.name] === null)).map((i) => i.name);
  if (missing.length) return { error: `${missing[0]} is required` };
  for (const i of sig.inputs) {
    const base = String(i.type).replace(/^(optional<|array<)+|>+$/g, "");
    if (!rt.TYPE_LABEL[base] || args[i.name] === undefined || args[i.name] === null) continue;
    try {
      args[i.name] = await rt.argOf(args[i.name], i.type, i.name, false);
    } catch (e) {
      if (e && e.invalidInput) return { error: e.message };
      throw e;
    }
  }
  const values = [];
  for (const i of sig.inputs) values.push(await rt.fromWire(args[i.name], i.type));
  return { values };
}

/** A TypeScript v1 function: a decorated method of an exported class; edits are the objects' recorded changes. */
async function invokeV1(rt, sig, mod, spec) {
  const v1 = require(path.join(SHIMS, "@foundry", "v1.js"));
  const Cls = mod[sig.class];
  if (typeof Cls !== "function") return { ok: false, category: "invalid_inputs", error: `${sig.class} is not exported` };
  const target = new Cls();
  if (typeof target[sig.name] !== "function") return { ok: false, category: "invalid_inputs", error: `${sig.class}.${sig.name} is not a method` };
  const parsed = await inputsOf(rt, sig, spec);
  if (parsed.error) return { ok: false, category: "invalid_inputs", error: parsed.error };
  // objects are live v1 objects, object sets v1 object sets
  const toV1 = (v) => (Array.isArray(v) ? v.map(toV1) : v instanceof rt.ObjectSet ? v1.fromObjectSet(v) : v && v.__pub ? v1.fromInstance(v) : v);
  try {
    v1.takeEdits();
    const value = await target[sig.name](...parsed.values.map(toV1));
    const recorded = v1.takeEdits();
    if (sig.kind === "edit") {
      const edits = rt.squash(await rt.editsOf(recorded));
      const declared = await rt.typeIds(sig.edits || []);
      if (edits.some((e) => e.kind !== "link" && !declared.includes(e.object_type_id)))
        return { ok: false, category: "undeclared_edits", error: "the function edits an object type it does not declare in @Edits(...)" };
      return { ok: true, edits, declared_types: declared };
    }
    if (recorded.length)
      return { ok: false, category: "undeclared_edits", error: `${sig.name} edits objects: mark it @OntologyEditFunction() with @Edits(...) (a @Function() cannot edit)` };
    return { ok: true, value: await rt.toWire(value) };
  } catch (e) {
    if (e && e.name === "UserFacingError") return { ok: false, category: "user_facing", user_facing: true, error: e.message };
    return { ok: false, category: "runtime", error: `${(e && e.name) || "Error"}: ${(e && e.message) || e}`, stack: e && e.stack ? String(e.stack).slice(0, 2000) : "" };
  }
}

(async () => {
  const [mode, repo, specFile] = process.argv.slice(2);
  let out;
  try {
    const spec = specFile ? JSON.parse(fs.readFileSync(specFile, "utf8")) : {};
    out = mode === "describe" ? { ok: true, functions: describe(repo) } : mode === "check" ? await check(repo) : await invoke(repo, spec);
  } catch (e) {
    out = { ok: false, category: "runtime", error: String((e && e.stack) || e).slice(0, 2000) };
  }
  process.stdout.write("\n__BSAI_RESULT__" + JSON.stringify(out) + "\n");
})();
