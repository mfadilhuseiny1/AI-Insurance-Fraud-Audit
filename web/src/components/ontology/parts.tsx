"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { uploadDriveFile } from "@/lib/api";
import {
  formatValue,
  mediaThumbUrl,
  mediaUrl,
  ontology,
  platformBranch,
  setPlatformBranch,
  BRANCH_EVENT,
  type OntologyObject,
  type Parameter,
  type PlatformBranch,
  type Property,
} from "@/lib/ontology";
import { conditionalStyle, formatProperty } from "@/lib/ontologyFormat";
import { CIPHER_VALUE } from "@/lib/cipher";
import { CipherValue } from "@/components/security/CipherValue";

/** The header bar of the three apps: app name, then a breadcrumb trail. */
export function AppHeader({
  app,
  icon,
  href,
  crumbs = [],
  children,
  compact = false,
}: {
  app: string;
  icon: IconName;
  href: string;
  crumbs?: { label: string; href?: string }[];
  children?: ReactNode;
  /** a shorter bar, for an app embedded in another page */
  compact?: boolean;
}) {
  return (
    <header className={`flex shrink-0 items-center gap-2 border-b border-line bg-panel text-sm ${compact ? "h-10 px-3" : "h-14 px-5"}`}>
      <Link href={href} className="flex items-center gap-2 font-medium text-soft hover:text-white">
        <span className="rounded-md bg-ocean/15 p-1 text-ocean">
          <Icon name={icon} className="h-4 w-4" />
        </span>
        {app}
      </Link>
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          <Icon name="right" className="h-3.5 w-3.5 shrink-0 text-muted" />
          {c.href ? (
            <Link href={c.href} className="truncate text-muted hover:text-white">
              {c.label}
            </Link>
          ) : (
            <span className="truncate">{c.label}</span>
          )}
        </Fragment>
      ))}
      <div className="ml-auto flex items-center gap-2">
        <BranchTaskbar />
        {children}
      </div>
    </header>
  );
}

/** The platform branch, when one is active: every app's Ontology reads and actions use it until Exit. */
function BranchTaskbar() {
  const [branch, setBranch] = useState<PlatformBranch | null>(null);
  useEffect(() => {
    const sync = () => setBranch(platformBranch());
    sync();
    window.addEventListener(BRANCH_EVENT, sync);
    return () => window.removeEventListener(BRANCH_EVENT, sync);
  }, []);
  if (!branch) return null;
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-sand/15 px-2.5 py-1 text-xs text-sand ring-1 ring-sand/40" title="Nexus reads and actions in every app use this branch (scenario)">
      <Icon name="split" className="h-3.5 w-3.5" />
      Branch: <Link href={`/insight?scenario=${encodeURIComponent(branch.id)}`} className="font-medium hover:underline">{branch.name}</Link>
      <button type="button" onClick={() => setPlatformBranch(null)} className="ml-1 rounded px-1 hover:bg-sand/20" title="Back to main">Exit</button>
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  experimental: "bg-warn/15 text-warn ring-warn/30",
  active: "bg-ok/15 text-ok ring-ok/30",
  deprecated: "bg-bad/15 text-bad ring-bad/30",
  succeeded: "bg-ok/15 text-ok ring-ok/30",
  failed: "bg-bad/15 text-bad ring-bad/30",
  enabled: "bg-ok/15 text-ok ring-ok/30",
  paused: "bg-panel-2 text-muted ring-line-2",
  example: "bg-panel-2 text-soft ring-line-2",
  promoted: "bg-purple-500/15 text-purple-300 ring-purple-400/40",
  approved: "bg-ok/15 text-ok ring-ok/30",
  rejected: "bg-bad/15 text-bad ring-bad/30",
  in_progress: "bg-warn/15 text-warn ring-warn/30",
  in_review: "bg-warn/15 text-warn ring-warn/30",
  merged: "bg-purple-500/15 text-purple-300 ring-purple-400/40",
  open: "bg-ocean/15 text-ocean ring-ocean/30",
  closed: "bg-panel-2 text-muted ring-line-2",
};

export function Badge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ${STATUS_STYLE[status] ?? STATUS_STYLE.paused}`}>
      {label ?? status.replace("_", " ")}
    </span>
  );
}

export function Card({ title, count, action, children, className = "" }: { title: string; count?: number; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="rounded-full bg-panel-2 px-1.5 text-xs font-normal text-muted ring-1 ring-line-2">{count}</span>}
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{message}</div>;
}

/**
 * A property value in a table cell: media as a thumbnail, arrays and long text clipped. With the property (and the
 * object's other values) it applies the property's value formatting and conditional formatting.
 */
export function ValueCell({
  type,
  value,
  large,
  prop,
  object,
  edit,
}: {
  type: string;
  value: unknown;
  large?: boolean;
  prop?: Property;
  object?: Record<string, unknown>;
  /** the object, for in-line edits of an encrypted property with the type class cipher: editable */
  edit?: { typeId: string; pk: string };
}) {
  // hubble:media_url / icon / thumbnail: the value is a URL rendered as media
  const urlClass = (prop?.type_classes ?? []).find((tc) => ["hubble:media_url", "hubble:icon", "hubble:thumbnail"].includes(tc));
  if (urlClass && typeof value === "string" && /^(https?:\/\/|\/)/.test(value)) {
    if (urlClass === "hubble:media_url" && /\.(mp4|webm|ogg)(\?|$)/i.test(value)) return <video src={value} controls className={large ? "max-h-72 rounded" : "h-10 rounded"} />;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={value} alt="" className={urlClass === "hubble:icon" ? "h-5 w-5 rounded" : large ? "max-h-72 rounded" : "h-10 rounded object-cover"} />;
  }
  // Cipher text (a cipher property, or any CIPHER::…::CIPHER value): masked, with Decrypt (Operational User license)
  if (typeof value === "string" && (type === "cipher" || CIPHER_VALUE.test(value)) && CIPHER_VALUE.test(value))
    return (
      <CipherValue
        value={value}
        context={prop ? `${prop.display_name ?? prop.api_name}${object?.__pk ? ` of ${String(object.__pk)}` : ""}` : ""}
        edit={edit && prop && (prop.type_classes ?? []).some((tc) => tc.replace(/\s/g, "").toLowerCase() === "cipher:editable") ? { ...edit, property: prop.api_name } : undefined}
      />
    );
  if (prop) {
    const style = conditionalStyle(prop, object ?? {});
    if (type !== "media" && type !== "boolean" && type !== "attachment") {
      const text = formatProperty(prop, value);
      if (text === null) return <span className="text-muted">—</span>;
      return (
        <span
          className={`${large ? "whitespace-pre-wrap break-words" : "line-clamp-2 break-all"} ${style?.background ? "rounded px-1.5 py-0.5" : ""} ${style?.align === "right" ? "block text-right" : ""}`}
          style={style ? { color: style.color, background: style.background } : undefined}
          title={large ? undefined : text.slice(0, 600)}
        >
          {text}
        </span>
      );
    }
    if (style && type === "boolean" && value !== null && value !== undefined)
      return (
        <span className="rounded px-1.5 py-0.5" style={{ color: style.color, background: style.background }}>
          {value ? "true" : "false"}
        </span>
      );
  }
  if (value === null || value === undefined || value === "") return <span className="text-muted">—</span>;
  if (type === "attachment" && typeof value === "string")
    return (
      <a href={mediaUrl(value)} target="_blank" rel="noreferrer" className="text-ocean hover:underline">
        Attachment
      </a>
    );
  if (type === "media" && typeof value === "string")
    return (
      <a href={mediaUrl(value)} target="_blank" rel="noreferrer" title="Open the file" className="inline-block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={mediaThumbUrl(value, large ? 480 : 120)}
          alt=""
          className={`${large ? "max-h-72" : "h-10 w-8"} rounded border border-line-2 bg-white object-cover`}
        />
      </a>
    );
  if (type === "boolean") return <span className={value ? "text-ok" : "text-muted"}>{value ? "true" : "false"}</span>;
  if (type === "geopoint")
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs" title="latitude, longitude (WGS 84)">
        <Icon name="globe" className="h-3 w-3 shrink-0 text-ocean" />
        {String(value).replace(",", ", ")}
      </span>
    );
  if (type === "geoshape") {
    let label = "Geoshape";
    try {
      const g = JSON.parse(String(value)) as { type: string; coordinates: unknown };
      const n = JSON.stringify(g.coordinates).match(/\[-?[\d.e+-]+,-?[\d.e+-]+/g)?.length ?? 0;
      label = `${g.type} · ${n} positions`;
    } catch {}
    return large ? (
      <span className="block">
        <span className="mb-1 inline-flex items-center gap-1 text-xs">
          <Icon name="globe" className="h-3 w-3 text-ocean" /> {label}
        </span>
        <code className="line-clamp-6 block break-all text-[11px] text-muted">{String(value)}</code>
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-xs" title={String(value).slice(0, 600)}>
        <Icon name="globe" className="h-3 w-3 shrink-0 text-ocean" /> {label}
      </span>
    );
  }
  if (type === "geotemporal_series_reference")
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs" title="Geotemporal series reference: the series id">
        <Icon name="wave" className="h-3 w-3 shrink-0 text-ocean" />
        {String(value)}
      </span>
    );
  const text = formatValue(value);
  return (
    <span className={large ? "whitespace-pre-wrap break-words" : "line-clamp-2 break-all"} title={large ? undefined : text.slice(0, 600)}>
      {text}
    </span>
  );
}

/** Pick one object of a type (searchable). */
export function ObjectPicker({
  objectTypeId,
  value,
  onChange,
}: {
  objectTypeId: string;
  value: string;
  onChange: (pk: string, obj?: OntologyObject) => void;
}) {
  const [objects, setObjects] = useState<OntologyObject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    ontology
      .objects(objectTypeId)
      .then((r) => !stale && setObjects(r.objects))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [objectTypeId]);
  if (error) return <div className="text-xs text-bad">{error}</div>;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value, objects?.find((o) => o.primary_key === e.target.value))}
      className={inputClass}
    >
      <option value="">{objects === null ? "Loading…" : objects.length ? "Select an object…" : "No objects yet"}</option>
      {objects?.map((o) => (
        <option key={o.primary_key} value={o.primary_key}>
          {o.title === o.primary_key ? o.title : `${o.title} · ${o.primary_key.slice(0, 12)}`}
        </option>
      ))}
    </select>
  );
}

/** A media value: upload a file (to My Project / Ontology) or pick one from Files. */
export function MediaInput({ value, onChange, objectTypeId, property }: { value: string; onChange: (ref: string) => void; objectTypeId?: string; property?: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setError(null);
    setProgress(0);
    try {
      // the property's upload destination (a media set), else My Project / Ontology
      const folder = await ontology.mediaFolder(objectTypeId, property);
      const item = await uploadDriveFile(file, folder.id, setProgress);
      setName(item.name);
      onChange(item.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        {value ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line-2 bg-ink px-2 py-1">
            <ValueCell type="media" value={value} />
            <span className="truncate text-xs text-soft">{name ?? value}</span>
            <button type="button" onClick={() => onChange("")} className="ml-auto text-muted hover:text-white" aria-label="Clear">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <span className="flex-1 text-xs text-muted">{progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : "No file"}</span>
        )}
        <button type="button" onClick={() => fileRef.current?.click()} className={buttonClass.secondary} disabled={progress !== null}>
          <Icon name="upload" className="h-3.5 w-3.5" /> Upload
        </button>
        <button type="button" onClick={() => setPicking(true)} className={buttonClass.ghost}>
          <Icon name="folder" className="h-3.5 w-3.5" /> Files
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
      />
      {error && <div className="mt-1 text-xs text-bad">{error}</div>}
      {picking && (
        <DrivePicker
          title="Pick a PDF or image"
          canPick={(item) =>
            item.kind === "file" && (item.content_type === "application/pdf" || item.content_type?.startsWith("image/") || /\.pdf$/i.test(item.name))
              ? null
              : "Only PDFs and images"
          }
          onPick={(item) => {
            setName(item.name);
            onChange(item.id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** One parameter's input, by type. */
export function ParamInput({
  param,
  objectTypeId,
  value,
  onChange,
  property,
}: {
  param: Pick<Parameter, "type"> & { array?: boolean };
  objectTypeId?: string;
  value: unknown;
  onChange: (v: unknown) => void;
  /** the property the parameter writes (struct fields) */
  property?: Property;
}) {
  const json = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 1));
  if (param.array && param.type !== "string_array") {
    if (param.type === "struct" || param.type === "geoshape")
      return <textarea rows={4} value={json(value)} placeholder='[{"field": "value"}]' onChange={(e) => onChange(e.target.value)} className={`${inputClass} font-mono text-xs`} />;
    const lines = Array.isArray(value) ? value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join("\n") : String(value ?? "");
    return (
      <textarea
        rows={3}
        value={lines}
        placeholder="One value per line"
        onChange={(e) => onChange(e.target.value.split("\n").filter((x) => x.trim()))}
        className={inputClass}
      />
    );
  }
  if (param.type === "struct" && property?.struct_fields?.length) {
    const rec = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return (
      <div className="grid grid-cols-2 gap-2 rounded-md border border-line-2 p-2">
        {property.struct_fields.map((f) => (
          <label key={f.api_name} className="text-xs">
            <span className="text-muted">
              {f.display_name || f.api_name}
              {f.main ? " (main)" : ""}
            </span>
            <ParamInput param={{ type: f.type }} value={rec[f.api_name]} onChange={(v) => onChange({ ...rec, [f.api_name]: v === "" ? null : v })} />
          </label>
        ))}
      </div>
    );
  }
  const text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join("\n") : String(value);
  switch (param.type) {
    case "long":
    case "short":
    case "byte":
      return <input type="number" step={1} value={text} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
    case "float":
    case "decimal":
      return <input inputMode="decimal" value={text} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
    case "geopoint":
      return <input value={text} placeholder="latitude,longitude" onChange={(e) => onChange(e.target.value)} className={inputClass} />;
    case "geoshape":
    case "vector":
    case "struct":
      return (
        <textarea
          rows={3}
          value={json(value)}
          placeholder={param.type === "vector" ? "[0.1, 0.2, …]" : param.type === "geoshape" ? '{"type": "Polygon", "coordinates": […]}' : "{}"}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} font-mono text-xs`}
        />
      );
    case "attachment":
      return <MediaInput value={text} onChange={onChange} />;
    case "object":
      return objectTypeId ? <ObjectPicker objectTypeId={objectTypeId} value={text} onChange={(pk) => onChange(pk)} /> : null;
    case "media":
      return <MediaInput value={text} onChange={onChange} objectTypeId={objectTypeId} property={property?.api_name} />;
    case "boolean":
      return (
        <select value={text} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")} className={inputClass}>
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "integer":
    case "double":
      return <input type="number" step={param.type === "integer" ? 1 : "any"} value={text} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
    case "date":
      return <input type="date" value={text.slice(0, 10)} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
    case "timestamp":
      return <input type="datetime-local" value={text.slice(0, 16)} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
    case "geopoint":
      return <input value={text} placeholder="latitude,longitude (e.g. -6.104,106.886) or a geohash" onChange={(e) => onChange(e.target.value)} className={`${inputClass} font-mono`} />;
    case "geoshape":
      return (
        <textarea
          rows={4}
          value={text}
          placeholder='GeoJSON geometry in WGS 84, e.g. {"type":"Polygon","coordinates":[[[lon,lat],…]]} (exterior ring counter-clockwise)'
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} font-mono text-xs`}
        />
      );
    case "geotemporal_series_reference":
      return <input value={text} placeholder="Series ID (1–100 characters)" onChange={(e) => onChange(e.target.value)} className={`${inputClass} font-mono`} />;
    case "string_array":
      return (
        <textarea
          rows={3}
          value={text}
          placeholder="One value per line"
          onChange={(e) => onChange(e.target.value.split("\n").filter((s) => s.trim()))}
          className={inputClass}
        />
      );
    default:
      return <textarea rows={text.length > 80 ? 4 : 1} value={text} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
  }
}

/** JSON-ish output of a block or run, readable. */
export function OutputView({ value, className = "" }: { value: unknown; className?: string }) {
  if (value === null || value === undefined) return <div className={`text-xs text-muted ${className}`}>null</div>;
  if (typeof value === "string")
    return <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink p-2.5 text-xs text-soft ${className}`}>{value}</pre>;
  if (Array.isArray(value) && value.every((v) => typeof v === "string"))
    return (
      <div className={`max-h-72 space-y-1 overflow-auto ${className}`}>
        {value.map((v, i) => (
          <div key={i} className="rounded-md bg-ink p-2 text-xs">
            <span className="mr-2 font-mono text-muted">[{i}]</span>
            <span className="whitespace-pre-wrap break-words text-soft">{v as string}</span>
          </div>
        ))}
      </div>
    );
  return (
    <pre className={`max-h-72 overflow-auto rounded-md bg-ink p-2.5 font-mono text-xs text-soft ${className}`}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export const EMPTY_BOX =
  "mt-8 flex w-full flex-col items-center rounded-2xl border-2 border-dashed border-line-2 py-16 hover:border-ocean/60 hover:bg-panel/60";
