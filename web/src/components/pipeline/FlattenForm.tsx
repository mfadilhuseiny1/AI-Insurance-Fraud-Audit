"use client";

import { useState, type ReactNode } from "react";
import {
  flattenTargets,
  fromJsonSchema,
  inferSchema,
  readJsonRecords,
  readSchema,
  SCHEMA_TYPES,
  uid,
  type Params,
  type SchemaField,
  type SchemaType,
  type Table,
} from "@/lib/pipeline";
import { Icon } from "../Icon";
import { TYPE_MARK } from "./DataPreview";
import { inputClass } from "./Modal";

const SAMPLE_ROWS = 200;
const smallButton =
  "rounded-md border border-line-2 px-2.5 py-1 text-xs text-soft hover:border-ocean/50 hover:text-white disabled:opacity-40";

/** Schema from the JSON text in the first rows of a column. */
function schemaFromColumn(table: Table, column: string): SchemaField[] {
  const sample = table.rows
    .slice(0, SAMPLE_ROWS)
    .map((r) => {
      const v = r[column];
      if (typeof v !== "string") return null;
      try {
        return JSON.parse(v) as unknown;
      } catch {
        return null;
      }
    })
    .filter((v) => v !== null);
  return inferSchema(sample);
}

/** Editor for the flatten step: Parse JSON string(column) with a struct schema, then flatten. */
export function FlattenForm({ params, table, onChange }: { params: Params; table: Table; onChange: (p: Params) => void }) {
  const column = typeof params.column === "string" ? params.column : "";
  const schema = readSchema(params);
  const text = (key: string, fallback = "") => (typeof params[key] === "string" ? (params[key] as string) : fallback);
  const set = (patch: Params) => onChange({ ...params, ...patch });
  const setSchema = (fields: SchemaField[]) => set({ schema: JSON.stringify(fields) });
  const [error, setError] = useState<string | null>(null);

  let targets: string[] = [];
  try {
    targets = flattenTargets(params).map((t) => t.name);
  } catch {}

  const pickColumn = (name: string) => {
    const patch: Params = { column: name };
    // first column choice: start the schema from the data
    if (name && !schema.length) {
      try {
        patch.schema = JSON.stringify(schemaFromColumn(table, name));
        setError(null);
      } catch {
        setError(`No JSON objects found in "${name}" — define the schema by hand or paste example data.`);
      }
    }
    set(patch);
  };

  return (
    <div className="space-y-4 border-t border-line px-3 py-3 text-xs">
      <Labelled label="Expression" required>
        <div className="rounded-md border border-line-2">
          <div className="flex items-center gap-2 border-b border-line-2 bg-panel-2 px-2.5 py-1.5">
            <span className="font-mono italic text-muted">fx</span>
            <span className="font-medium">Parse JSON string</span>
            <span className="ml-auto text-muted">reads JSON text into a struct</span>
          </div>
          <div className="space-y-3 p-3">
            <Collapsible title="Example data" hint="Paste a JSON sample and autogenerate a schema">
              <ExampleData
                onSchema={(fields) => {
                  setSchema(fields);
                  setError(null);
                }}
              />
            </Collapsible>
            <Collapsible title="JSON schema" hint="Paste a JSON schema to use">
              <JsonSchemaInput onSchema={setSchema} />
            </Collapsible>

            <Labelled label="JSON" required>
              <div className="flex gap-2">
                <select value={column} onChange={(e) => pickColumn(e.target.value)} className={inputClass}>
                  <option value="">Choose a column…</option>
                  {column && !table.columns.some((c) => c.name === column) && <option value={column}>{column} (missing)</option>}
                  {table.columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {TYPE_MARK[c.type]} {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!column}
                  title="Replace the schema with one generated from this column's values"
                  onClick={() => {
                    try {
                      setSchema(schemaFromColumn(table, column));
                      setError(null);
                    } catch {
                      setError(`No JSON objects found in "${column}".`);
                    }
                  }}
                  className={`${smallButton} whitespace-nowrap`}
                >
                  Generate from column
                </button>
              </div>
            </Labelled>

            <Labelled label="Schema" required>
              <div className="mb-1.5 inline-block rounded-md border border-line-2 bg-panel-2 px-2 py-1">Struct</div>
              <FieldsEditor fields={schema} onChange={setSchema} />
            </Labelled>
            {error && (
              <p className="flex items-center gap-1.5 text-bad">
                <Icon name="alert" className="h-3.5 w-3.5" /> {error}
              </p>
            )}
          </div>
        </div>
      </Labelled>

      <Labelled label="Max depth" required hint="Struct fields nested deeper than this stay as JSON text.">
        <input
          type="number"
          min={1}
          value={text("maxDepth", "1")}
          onChange={(e) => set({ maxDepth: e.target.value })}
          className={inputClass}
        />
      </Labelled>
      <Labelled label="Column prefix" hint="Put in front of every new column name.">
        <input
          value={text("prefix")}
          onChange={(e) => set({ prefix: e.target.value })}
          placeholder="Empty string"
          className={inputClass}
        />
      </Labelled>
      <Labelled label="Separator" required hint="Joins the prefix and nested field names, e.g. address_city.">
        <input
          value={text("separator", "_")}
          onChange={(e) => set({ separator: e.target.value })}
          placeholder="Empty string"
          className={`${inputClass} font-mono`}
        />
      </Labelled>
      <label className="flex cursor-pointer items-center gap-2 text-soft">
        <input
          type="checkbox"
          checked={params.drop === "true"}
          onChange={(e) => set({ drop: e.target.checked ? "true" : "" })}
          className="accent-[var(--color-ocean)]"
        />
        Drop the JSON column after flattening
      </label>

      {targets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-ink p-2">
          <span className="text-muted">New columns:</span>
          {targets.map((n, i) => (
            <span key={i} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono ring-1 ring-line-2">
              {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Editor for "Extract rows from a JSON file": schema (from example data, a JSON schema or the files) + multi-line. */
export function ExtractJsonForm({ params, table, onChange }: { params: Params; table: Table; onChange: (p: Params) => void }) {
  const schema = readSchema(params);
  const multiline = params.multiline === "true";
  const set = (patch: Params) => onChange({ ...params, ...patch });
  const setSchema = (fields: SchemaField[]) => set({ schema: JSON.stringify(fields) });
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4 border-t border-line px-3 py-3 text-xs">
      {table.files ? (
        <p className="flex items-center gap-1.5 text-muted">
          <Icon name="doc" className="h-3.5 w-3.5" />
          {table.files.length} file{table.files.length > 1 ? "s" : ""}: {table.files.map((f) => f.path).join(", ")}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-bad">
          <Icon name="alert" className="h-3.5 w-3.5" /> The input is not a dataset of files.
        </p>
      )}

      <div className="space-y-3">
        <Collapsible title="Example data" hint="Paste a JSON sample and autogenerate a schema" defaultOpen={!schema.length}>
          <ExampleData
            onSchema={(fields) => {
              setSchema(fields);
              setError(null);
            }}
          />
        </Collapsible>
        <Collapsible title="JSON schema" hint="Paste a JSON schema to use">
          <JsonSchemaInput onSchema={setSchema} />
        </Collapsible>
      </div>

      <Labelled label="Schema" required hint="Fields to read and their types. Leave empty to read every field with inferred types.">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="rounded-md border border-line-2 bg-panel-2 px-2 py-1">Struct</span>
          <button
            type="button"
            disabled={!table.files?.length}
            title="Generate the schema from the records in the files"
            onClick={() => {
              try {
                setSchema(inferSchema(readJsonRecords(table.files!, multiline).slice(0, SAMPLE_ROWS)));
                setError(null);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={smallButton}
          >
            Generate from files
          </button>
        </div>
        <FieldsEditor fields={schema} onChange={setSchema} />
        {!schema.length && <p className="mt-1 text-muted">No fields: every field is read with inferred types.</p>}
      </Labelled>
      {error && (
        <p className="flex items-center gap-1.5 text-bad">
          <Icon name="alert" className="h-3.5 w-3.5" /> {error}
        </p>
      )}

      <Switch
        on={multiline}
        onChange={(on) => set({ multiline: on ? "true" : "" })}
        label="Allow JSON values to span multiple lines"
        hint="If off, each JSON record must be entirely on one line (JSON Lines). If on, each file holds one JSON value — an object or a list of objects."
      />
      <Switch
        on={params.includePath === "true"}
        onChange={(on) => set({ includePath: on ? "true" : "" })}
        label="Add a file_path column"
      />
    </div>
  );
}

function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (on: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} title={hint} className="flex items-center gap-2 text-soft">
      <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-ocean" : "bg-line-2"}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      {label}
    </button>
  );
}

function Labelled({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 font-medium text-soft">
        {label}
        {required && <span className="text-bad">*</span>}
        {hint && (
          <span title={hint} className="cursor-help rounded-full border border-line-2 px-1 text-[10px] leading-tight text-muted">
            ?
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Collapsible({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  hint: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 text-left">
        <span className="w-24 shrink-0 font-medium text-soft">{title}</span>
        <span className="text-ocean underline decoration-dotted underline-offset-2">{hint}</span>
        <Icon name={open ? "down" : "right"} className="ml-auto h-3.5 w-3.5 text-muted" />
      </button>
      {open && <div className="mt-2 pl-27">{children}</div>}
    </div>
  );
}

function ExampleData({ onSchema }: { onSchema: (f: SchemaField[]) => void }) {
  const [sample, setSample] = useState("");
  const [error, setError] = useState<string | null>(null);
  const parse = () => {
    try {
      return JSON.parse(sample) as unknown;
    } catch {
      setError("The example is not valid JSON");
      return undefined;
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        value={sample}
        onChange={(e) => {
          setSample(e.target.value);
          setError(null);
        }}
        rows={5}
        spellCheck={false}
        placeholder='{"city": "Yoshikofurt", "street": "331 Susie Wells", "state": "South Carolina"}'
        className={`${inputClass} font-mono`}
      />
      <div className="flex items-center justify-end gap-2">
        {error && <span className="mr-auto text-bad">{error}</span>}
        <button
          type="button"
          disabled={!sample.trim()}
          onClick={() => {
            const v = parse();
            if (v !== undefined) setSample(JSON.stringify(v, null, 2));
          }}
          className={smallButton}
        >
          Prettify
        </button>
        <button
          type="button"
          disabled={!sample.trim()}
          onClick={() => {
            const v = parse();
            if (v === undefined) return;
            try {
              onSchema(inferSchema(v));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          className="rounded-md bg-ocean px-2.5 py-1 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-40"
        >
          Generate schema
        </button>
      </div>
    </div>
  );
}

function JsonSchemaInput({ onSchema }: { onSchema: (f: SchemaField[]) => void }) {
  const [doc, setDoc] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <textarea
        value={doc}
        onChange={(e) => {
          setDoc(e.target.value);
          setError(null);
        }}
        rows={5}
        spellCheck={false}
        placeholder='{"type": "object", "properties": {"city": {"type": "string"}}}'
        className={`${inputClass} font-mono`}
      />
      <div className="flex items-center justify-end gap-2">
        {error && <span className="mr-auto text-bad">{error}</span>}
        <button
          type="button"
          disabled={!doc.trim()}
          onClick={() => {
            try {
              onSchema(fromJsonSchema(JSON.parse(doc)));
            } catch (e) {
              setError(e instanceof SyntaxError ? "The schema is not valid JSON" : (e as Error).message);
            }
          }}
          className="rounded-md bg-ocean px-2.5 py-1 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-40"
        >
          Use schema
        </button>
      </div>
    </div>
  );
}

function FieldsEditor({ fields, onChange }: { fields: SchemaField[]; onChange: (f: SchemaField[]) => void }) {
  const update = (id: string, patch: Partial<SchemaField>) => onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...fields];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-1.5 border-l border-line-2 pl-3">
      {fields.length > 0 && (
        <div className="grid grid-cols-[1fr_8rem_4.5rem] gap-2 text-muted">
          <span>Name</span>
          <span>Type</span>
        </div>
      )}
      {fields.map((f, i) => (
        <div key={f.id}>
          <div className="grid grid-cols-[1fr_8rem_4.5rem] items-center gap-2">
            <input
              value={f.name}
              onChange={(e) => update(f.id, { name: e.target.value })}
              placeholder="field name"
              className={`${inputClass} ${f.name.trim() ? "" : "border-bad/60"}`}
            />
            <select
              value={f.type}
              onChange={(e) => {
                const type = e.target.value as SchemaType;
                update(f.id, { type, fields: type === "Struct" ? (f.fields ?? []) : undefined });
              }}
              className={inputClass}
            >
              {SCHEMA_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <div className="flex">
              <IconButton title="Move up" icon="left" rotate disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton title="Move down" icon="right" rotate disabled={i === fields.length - 1} onClick={() => move(i, 1)} />
              <IconButton title="Delete field" icon="trash" danger onClick={() => onChange(fields.filter((x) => x.id !== f.id))} />
            </div>
          </div>
          {f.type === "Struct" && (
            <div className="mt-1.5 pl-3">
              <FieldsEditor fields={f.fields ?? []} onChange={(nested) => update(f.id, { fields: nested })} />
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...fields, { id: uid(), name: "", type: "String" }])}
        className="flex items-center gap-1 rounded-md border border-line-2 px-2 py-1 text-soft hover:border-ocean/50 hover:text-white"
      >
        <Icon name="plus" className="h-3.5 w-3.5" /> Add field
      </button>
    </div>
  );
}

function IconButton({
  title,
  icon,
  onClick,
  disabled,
  danger,
  rotate,
}: {
  title: string;
  icon: "left" | "right" | "trash";
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  rotate?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded p-1 text-muted disabled:opacity-25 ${danger ? "hover:bg-bad/10 hover:text-bad" : "hover:bg-panel-2 hover:text-white"}`}
    >
      <Icon name={icon} className={`h-3.5 w-3.5 ${rotate ? "rotate-90" : ""}`} />
    </button>
  );
}
