"""The TypeScript functions repository template (Code Repositories → New repository → TypeScript functions).

ts-functions/src holds TypeScript v2 functions (functions_ts.py runs them with Node): an API-named query
(src/queries/countObjects.ts), in src/index.ts a read function with an $or where clause, an Ontology edit function and
a function of pure logic, and that function's unit tests (src/index.test.ts, run by the repository's checks). The
examples use an object type of the Ontology the creator can see (its title property), or Employee / name when there is
none.
"""

from __future__ import annotations

import re
from typing import Optional

README = """# {name}

TypeScript functions (TypeScript v2, `@osdk/functions`), published from Functions → Publish like Python functions.

```
ts-functions
├── package.json
├── tsconfig.json
└── src
    ├── index.ts                  a read function, an Ontology edit function and a function of pure logic
    ├── index.test.ts             unit tests (describe / it / expect), run by the checks of every commit
    └── queries
        └── countObjects.ts       an API-named query (export const config = {{ apiName }})
```

- Every exported function of `ts-functions/src/**/*.ts` is a function; a default export takes the file's name.
- A first parameter typed `Client` is injected; `WriteableClient` (from `@osdk/functions/experimental`) stages
  writes. Inputs and outputs use `string`, `Integer`, `Double`, `boolean`, `Timestamp`, arrays, `Osdk.Instance<T>`,
  `ObjectSet<T>` and custom types.
- Object types are imported by API name from `@ontology/sdk`; `client(Type).where({{ ... }})` takes OSDK where
  clauses (`$eq`, `$in`, `$startsWith`, `$containsAnyTerm`, `$isNull`, `$and` / `$or` / `$not`, ...).
- An Ontology edit function returns `Edits.Object<T>[]` from `createEditBatch`.
- `export const config = {{ apiName: "..." }}` publishes a file's function as a query: other functions call it with
  `client(query).executeFunction({{ ... }})`, apps through the API gateway.
- `*.test.ts` / `*.spec.ts` files are unit tests, not functions: the checks compile the TypeScript files and run
  them (`describe`, `it` / `test`, `beforeEach` / `afterEach`, `expect(...)` with the common Jest matchers, `.not`,
  `.resolves`, `.rejects`). They run without the Ontology: test the logic.
- TypeScript v1 functions also run here: decorated methods of an exported class (`@Function()`,
  `@OntologyEditFunction()` with `@Edits(Type)`, `@Query({{ apiName }})` from `@foundry/functions-api`), with
  `Objects.search()` / `Objects.create()` and `Filters` from `@foundry/ontology-api`.
- npm dependencies are not installed: only the SDK packages above resolve. The checks find syntax errors, not type
  errors.
"""

PACKAGE = """{{
  "name": "{package}",
  "version": "0.0.0",
  "private": true,
  "description": "TypeScript v2 functions",
  "dependencies": {{
    "@osdk/client": "^2.0.0",
    "@osdk/functions": "^1.0.0"
  }},
  "devDependencies": {{
    "typescript": "^5.4.0"
  }}
}}
"""

TSCONFIG = """{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "experimentalDecorators": true,
    "skipLibCheck": true,
    "outDir": "build"
  },
  "include": ["src"]
}
"""

QUERY = """import {{ Client }} from "@osdk/client";
import {{ Integer }} from "@osdk/functions";
import {{ {type} }} from "@ontology/sdk";

// Published as the query {api_name}: other functions call it with client({api_name}).executeFunction({{ ... }})
// (import {{ {api_name} }} from "@ontology/sdk"), apps through POST /api/functions/queries/{api_name}/execute.
export const config = {{
  apiName: "{api_name}",
}};

/** How many {type} objects there are, or minimum when there are fewer. */
export default async function countObjects(client: Client, minimum?: Integer): Promise<Integer> {{
  const result = await client({type}).aggregate({{ $select: {{ $count: "unordered" }} }});
  return Math.max(result.$count, minimum ?? 0);
}}
"""

INDEX = """import {{ Client, Osdk }} from "@osdk/client";
import {{ createEditBatch, Edits, Integer, UserFacingError }} from "@osdk/functions";
import {{ {type} }} from "@ontology/sdk";

/** The titles of up to `limit` {type} objects whose {prop} starts with the text or contains one of its words. */
export async function findObjects(client: Client, text: string, limit?: Integer): Promise<string[]> {{
  const page = await client({type})
    .where({{ $or: [{{ {prop}: {{ $startsWith: text }} }}, {{ {prop}: {{ $containsAnyTerm: text }} }}] }})
    .fetchPage({{ $pageSize: limit ?? 10 }});
  return page.data.map((o) => String(o.$title ?? o.$primaryKey));
}}

/** An Ontology edit function: sets the {prop} of a {type} (apply it from a function-backed action). */
export function renameObject(client: Client, object: Osdk.Instance<{type}>, newValue: string): Edits.Object<{type}>[] {{
  if (!newValue.trim()) throw new UserFacingError("Enter a value");
  const batch = createEditBatch<Edits.Object<{type}>>(client);
  batch.update(object, {{ {prop}: newValue.trim() }});
  return batch.getEdits();
}}

/** Initials of a name ("Ada Lovelace" → "AL"): logic without the Ontology, tested in index.test.ts. */
export function initials(name: string): string {{
  return name
    .split(/\\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join("");
}}
"""

TEST = """import { UserFacingError } from "@osdk/functions";
import { initials, renameObject } from "./index";

describe("initials", () => {
  it("takes the first letter of each word", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
  });

  it("ignores extra spaces and upper-cases", () => {
    expect(initials("grace  brewster hopper")).toBe("GBH");
  });

  it("is empty for an empty name", () => {
    expect(initials("")).toBe("");
  });
});

describe("renameObject", () => {
  it("refuses an empty value before it edits anything", () => {
    expect(() => renameObject(undefined as any, undefined as any, "   ")).toThrow(UserFacingError);
    expect(() => renameObject(undefined as any, undefined as any, "   ")).toThrow("Enter a value");
  });
});
"""


def _sample_type() -> tuple[str, str]:
    """An object type the creator can see (API name) and a string property of it (its title property first)."""
    try:
        import auth
        import ontology

        types = auth.visible_resources("object_type", ontology._all("object-types"))
        for t in sorted(types, key=lambda x: ("(test)" in (x.get("display_name") or ""), x.get("display_name") or "")):
            strings = [p["api_name"] for p in t.get("properties") or [] if p.get("type") == "string" and not p.get("array")
                       and p["api_name"] != t.get("primary_key")]
            if t.get("api_name") and strings:
                prop = t.get("title_property") if t.get("title_property") in strings else strings[0]
                return t["api_name"], prop
    except Exception:  # noqa: BLE001
        pass
    return "Employee", "name"


def _api_prefix(name: str) -> str:
    words = [w for w in re.split(r"[^A-Za-z0-9]+", name) if w]
    first = (words[0].lower() if words else "my")
    if first[0].isdigit():
        first = "fn" + first
    return first + "".join(w[:1].upper() + w[1:].lower() for w in words[1:])


def ts_functions_files(name: str, settings: str, sample: Optional[tuple[str, str]] = None) -> dict[str, str]:
    type_name, prop = sample or _sample_type()
    api_name = _api_prefix(name) + "CountObjects"
    package = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-.") or "ts-functions"
    return {
        "README.md": README.format(name=name),
        "repoSettings.json": settings,
        "ts-functions/package.json": PACKAGE.format(package=package),
        "ts-functions/tsconfig.json": TSCONFIG,
        "ts-functions/src/index.ts": INDEX.format(type=type_name, prop=prop),
        "ts-functions/src/index.test.ts": TEST,
        "ts-functions/src/queries/countObjects.ts": QUERY.format(type=type_name, api_name=api_name),
    }
