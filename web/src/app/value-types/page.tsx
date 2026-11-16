"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { AppHeader, Badge, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { om, storedOntology, VALUE_BASE_TYPES, type Ontology, type ValueConstraints, type ValueType } from "@/lib/ontologyModel";

/** A constraint summary in words. */
function describe(c: ValueConstraints, base: string): string[] {
  const out: string[] = [];
  if (c.enum) out.push(`one of ${c.enum.values.map(String).join(", ")}${c.enum.case_sensitive === false ? " (any case)" : ""}`);
  if (c.range) {
    const what = base === "string" ? "length" : base === "array" ? "size" : "value";
    out.push(`${what} ${c.range.min ?? "−∞"} … ${c.range.max ?? "∞"}`);
  }
  if (c.regex) out.push(`matches /${c.regex.pattern}/${c.regex.partial ? " (substring)" : ""}`);
  if (c.rid) out.push("a valid RID");
  if (c.uuid) out.push("a valid UUID");
  if (c.unique) out.push("unique elements");
  if (c.element) out.push(`each element: ${describe(c.element, "string").join(", ")}`);
  if (c.fields) out.push(`fields: ${Object.keys(c.fields).join(", ")}`);
  return out;
}

/**
 * Value Types: semantic wrappers around a base type with constraints and a failure message, reusable on properties,
 * shared properties and action parameters. Constraint changes make new versions that every consumer uses.
 */
export default function ValueTypesPage() {
  // useSearchParams needs a Suspense boundary on a static page
  return (
    <Suspense fallback={null}>
      <ValueTypes />
    </Suspense>
  );
}

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "sand" | "muted"> = { active: "ok", experimental: "warn", deprecated: "bad", example: "sand" };
const lastChange = (v: ValueType) => v.versions.reduce((t, x) => (x.created_at > t ? x.created_at : t), v.created_at);

function ValueTypes() {
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get("open");
  const [list, setList] = useState<ValueType[] | null>(null);
  const [onts, setOnts] = useState<Ontology[]>([]);
  const [space, setSpace] = useState(storedOntology);
  const [editing, setEditing] = useState<ValueType | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([om.valueTypes(), om.ontologies()]).then(
      ([v, o]) => {
        setList(v);
        setOnts(o);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(load, [load]);
  if (error && !list) return <ApiError message={error} />;
  const shown = list?.filter((v) => (v.ontology_id ?? "default") === space) ?? null;
  const open = openId ? list?.find((v) => v.id === openId) : undefined;
  const dialog = editing && <ValueTypeDialog v={editing === "new" ? null : editing} space={space} onClose={() => setEditing(null)} onDone={() => (setEditing(null), load())} />;
  if (open)
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <AppHeader app="Value Types" icon="link" href="/value-types" crumbs={[{ label: open.display_name }]} />
        <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl space-y-4 p-8">
            <Link href="/value-types" className="inline-flex items-center gap-1 text-xs text-muted hover:text-soft">
              <Icon name="left" className="h-3.5 w-3.5" /> All value types
            </Link>
            <div className="rounded-xl border border-line bg-panel">
              <div className="flex items-center gap-3 px-4 py-3">
                <Icon name="link" className="h-4 w-4 text-ocean" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-semibold">
                    {open.display_name} <span className="font-mono text-xs font-normal text-muted">{open.api_name}</span>
                  </div>
                  <div className="text-xs text-muted">
                    {open.base_type}
                    {open.element_type ? `<${open.element_type}>` : ""} · v{open.version} · {describe(open.constraints, open.base_type).join(" · ") || "no constraints"}
                  </div>
                </div>
                <Badge status={open.status} />
                <span className="text-xs text-muted">{open.consumers.length} uses</span>
              </div>
              <ValueTypeDetail
                v={open}
                onEdit={() => setEditing(open)}
                onChanged={() => {
                  load();
                  router.replace("/value-types");
                }}
              />
            </div>
          </div>
        </div>
        {dialog}
      </div>
    );
  return (
    <>
      <AppHome
        app="Value Types"
        icon="link"
        accent="#eab308"
        href="/value-types"
        tagline="Domain types such as “Email” or “Country code”, reused across properties and action parameters."
        description={
          <>
            Domain types such as “Email” or “Country code”: a base type, constraints and a failure message, reused across properties, shared properties and action parameters. Editing constraints creates a new version that every use
            picks up; a breaking change is refused while stored values fail it.
          </>
        }
        headerActions={
          <select value={space} onChange={(e) => setSpace(e.target.value)} className="rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs" title="Space (ontology)">
            {onts.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        }
        noun={["value type", "value types"]}
        items={
          shown?.map((v) => ({
            id: v.id,
            href: `/value-types?open=${v.id}`,
            title: v.display_name,
            updated_at: lastChange(v),
            detail: `${v.api_name} · ${describe(v.constraints, v.base_type).join(" · ") || "no constraints"}`,
            badges: [
              { label: v.status, tone: STATUS_TONE[v.status] ?? "muted" },
              { label: `${v.base_type}${v.element_type ? `<${v.element_type}>` : ""}`, tone: "muted" },
            ],
            meta: `v${v.version} · ${v.consumers.length} uses`,
          })) ?? null
        }
        stats={
          shown
            ? [
                { label: "Value types", value: shown.length.toLocaleString() },
                { label: "Active", value: shown.filter((v) => v.status === "active").length.toLocaleString() },
                { label: "Uses", value: shown.reduce((n, v) => n + v.consumers.length, 0).toLocaleString() },
              ]
            : undefined
        }
        error={error}
        empty={{
          title: "No value types in this space yet",
          hint: "Wrap a base type with constraints and a failure message, then pick it on properties and action parameters.",
          steps: ["Choose a base type", "Add constraints and a failure message", "Use it on a property or parameter"],
        }}
        create={
          <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
            <Icon name="plus" /> New value type
          </button>
        }
      />
      {dialog}
    </>
  );
}

function ValueTypeDetail({ v, onEdit, onChanged }: { v: ValueType; onEdit: () => void; onChanged: () => void }) {
  const [sample, setSample] = useState(v.example ?? "");
  const [result, setResult] = useState<{ valid: boolean; message: string | null } | null>(null);
  return (
    <div className="grid gap-4 border-t border-line p-4 text-sm md:grid-cols-2">
      <div className="space-y-3">
        {v.description && <p className="text-soft">{v.description}</p>}
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Try a value</div>
          <div className="flex gap-2">
            <input value={sample} onChange={(e) => setSample(e.target.value)} className={`${inputClass} flex-1`} />
            <button
              type="button"
              onClick={async () => {
                let value: unknown = sample;
                if (v.base_type === "array" || v.base_type === "struct") {
                  try {
                    value = JSON.parse(sample);
                  } catch {}
                }
                setResult(await om.validateValue(v.id, value));
              }}
              className={buttonClass.secondary}
            >
              Validate
            </button>
          </div>
          {result && <p className={`mt-1 text-xs ${result.valid ? "text-ok" : "text-bad"}`}>{result.valid ? "Valid" : result.message}</p>}
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Used by</div>
          {v.consumers.length === 0 && <p className="text-xs text-muted">Nothing yet: pick it on a property, a shared property or an action parameter.</p>}
          {v.consumers.map((c, i) => (
            <div key={i} className="text-xs text-soft">
              {c.kind === "property" ? `${c.object_type}.${c.property}` : c.kind === "parameter" ? `${c.action_type} → ${c.parameter}` : `Shared property ${c.property}`}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onEdit} className={buttonClass.secondary}>
            <Icon name="pencil" className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!(await confirmDialog(`Delete the value type "${v.display_name}"?`))) return;
              try {
                await om.deleteValueType(v.id);
                onChanged();
              } catch (e) {
                void alertDialog((e as Error).message);
              }
            }}
            className={`${buttonClass.ghost} text-bad`}
          >
            <Icon name="trash" className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-soft">Versions</div>
        <ul className="space-y-2">
          {[...v.versions].reverse().map((ver) => (
            <li key={ver.version} className="rounded-md bg-panel-2 p-2 text-xs">
              <div className="flex items-center">
                <span className="font-medium">v{ver.version}</span>
                {ver.version === v.version && <span className="ml-2 text-ok">current</span>}
                <span className="ml-auto text-muted">{when(ver.created_at)}</span>
              </div>
              <div className="text-muted">{describe(ver.constraints, v.base_type).join(" · ") || "no constraints"}</div>
              {ver.failure_message && <div className="text-soft">“{ver.failure_message}”</div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ValueTypeDialog({ v, space, onClose, onDone }: { v: ValueType | null; space: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(v?.display_name ?? "");
  const [api, setApi] = useState(v?.api_name ?? "");
  const [description, setDescription] = useState(v?.description ?? "");
  const [base, setBase] = useState(v?.base_type ?? "string");
  const [element, setElement] = useState(v?.element_type ?? "string");
  const [c, setC] = useState<ValueConstraints>(v?.constraints ?? {});
  const [message, setMessage] = useState(v?.failure_message ?? "");
  const [example, setExample] = useState(v?.example ?? "");
  const [status, setStatus] = useState(v?.status ?? "experimental");
  const [error, setError] = useState<string | null>(null);
  const strBase = base === "string";
  const numBase = ["integer", "long", "short", "double", "float", "decimal"].includes(base);
  const submit = async (force = false) => {
    setError(null);
    const body = { display_name: name, api_name: api || undefined, description, base_type: base, element_type: base === "array" ? element : null, constraints: c, failure_message: message, example, status, ontology_id: space, force };
    try {
      if (v) await om.updateValueType(v.id, body);
      else await om.createValueType(body);
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      if (v && /fail the new constraints/.test(msg) && (await confirmDialog({ title: "Breaking change", message: `${msg}\n\nApply it anyway?`, danger: true, confirmLabel: "Force new version" }))) return submit(true);
      setError(msg);
    }
  };
  return (
    <Modal title={v ? `Edit ${v.display_name}` : "New value type"} icon="link" onClose={onClose} wide>
      <div className="space-y-4 p-4 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Email address" className={inputClass} />
          </Field>
          <Field label="API name">
            <input value={api} onChange={(e) => setApi(e.target.value)} placeholder="auto" className={`${inputClass} font-mono`} />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as ValueType["status"])} className={inputClass}>
              {["experimental", "active", "deprecated", "example"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Base type" hint={v ? "Immutable" : undefined}>
            <select value={base} disabled={!!v} onChange={(e) => (setBase(e.target.value), setC({}))} className={inputClass}>
              {VALUE_BASE_TYPES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </Field>
          {base === "array" && (
            <Field label="Element type">
              <select value={element} disabled={!!v} onChange={(e) => setElement(e.target.value)} className={inputClass}>
                {VALUE_BASE_TYPES.filter((b) => b !== "array" && b !== "struct").map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Example value">
            <input value={example} onChange={(e) => setExample(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div className="space-y-2 rounded-md border border-line-2 p-3">
          <div className="text-xs font-medium text-soft">Constraints</div>
          {(strBase || numBase || base === "boolean") && (
            <label className="flex flex-wrap items-center gap-2 text-xs">
              <input type="checkbox" checked={!!c.enum} onChange={(e) => setC({ ...c, enum: e.target.checked ? { values: [], case_sensitive: true } : undefined })} /> One of
              {c.enum && (
                <>
                  <input
                    value={c.enum.values.join(", ")}
                    onChange={(e) => setC({ ...c, enum: { ...c.enum!, values: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
                    placeholder="comma separated values"
                    className={`${fieldClass} flex-1 text-xs`}
                  />
                  {strBase && (
                    <label className="flex items-center gap-1 text-muted">
                      <input type="checkbox" checked={c.enum.case_sensitive !== false} onChange={(e) => setC({ ...c, enum: { ...c.enum!, case_sensitive: e.target.checked } })} /> case-sensitive
                    </label>
                  )}
                </>
              )}
            </label>
          )}
          {base !== "boolean" && base !== "struct" && (
            <label className="flex flex-wrap items-center gap-2 text-xs">
              <input type="checkbox" checked={!!c.range} onChange={(e) => setC({ ...c, range: e.target.checked ? {} : undefined })} /> {strBase ? "Length" : base === "array" ? "Size" : "Range"}
              {c.range && (
                <>
                  <input value={String(c.range.min ?? "")} onChange={(e) => setC({ ...c, range: { ...c.range, min: e.target.value === "" ? undefined : e.target.value } })} placeholder="min" className={`${fieldClass} w-28 text-xs`} />
                  <input value={String(c.range.max ?? "")} onChange={(e) => setC({ ...c, range: { ...c.range, max: e.target.value === "" ? undefined : e.target.value } })} placeholder="max" className={`${fieldClass} w-28 text-xs`} />
                </>
              )}
            </label>
          )}
          {strBase && (
            <>
              <label className="flex flex-wrap items-center gap-2 text-xs">
                <input type="checkbox" checked={!!c.regex} onChange={(e) => setC({ ...c, regex: e.target.checked ? { pattern: "" } : undefined })} /> Regex
                {c.regex && (
                  <>
                    <input value={c.regex.pattern} onChange={(e) => setC({ ...c, regex: { ...c.regex!, pattern: e.target.value } })} placeholder="[^@]+@[^@]+" className={`${fieldClass} flex-1 font-mono text-xs`} />
                    <label className="flex items-center gap-1 text-muted">
                      <input type="checkbox" checked={!!c.regex.partial} onChange={(e) => setC({ ...c, regex: { ...c.regex!, partial: e.target.checked } })} /> substring match
                    </label>
                  </>
                )}
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!c.rid} onChange={(e) => setC({ ...c, rid: e.target.checked || undefined })} /> Must be a RID
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!c.uuid} onChange={(e) => setC({ ...c, uuid: e.target.checked || undefined })} /> Must be a UUID
              </label>
            </>
          )}
          {base === "array" && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!c.unique} onChange={(e) => setC({ ...c, unique: e.target.checked || undefined })} /> Unique elements
              </label>
              <label className="flex flex-wrap items-center gap-2 text-xs">
                <input type="checkbox" checked={!!c.element} onChange={(e) => setC({ ...c, element: e.target.checked ? {} : undefined })} /> Element regex
                {c.element && element === "string" && (
                  <input value={c.element.regex?.pattern ?? ""} onChange={(e) => setC({ ...c, element: { regex: { pattern: e.target.value } } })} placeholder="pattern each element matches" className={`${fieldClass} flex-1 font-mono text-xs`} />
                )}
              </label>
            </>
          )}
        </div>
        <Field label="Failure message" hint="Shown when a value fails the constraints (in actions and on properties)">
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Enter a valid email address" className={inputClass} />
        </Field>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim()} onClick={() => submit()} className={buttonClass.primary}>
            {v ? "Save (new version if constraints changed)" : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
