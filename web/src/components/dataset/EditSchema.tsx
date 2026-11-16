"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import {
  cellText,
  datasetPreview,
  FOUNDRY_TYPES,
  SOURCE_READER,
  TEXT_READER,
  type Column,
  type DatasetSchema,
  type FoundryType,
  type TextParserParams,
  type Validation,
} from "@/lib/datasetPreview";

const DELIMS: [string, string][] = [
  [",", "Comma"],
  [";", "Semicolon"],
  ["\t", "Tab"],
  ["|", "Pipe"],
];

/**
 * Edit schema (CSV / TSV / JSON datasets): parsing options of the TextDataFrameReader (or Spark's CSV reader), column
 * names and types, with a preview of the first rows and the validation result. Save and validate refuses a schema
 * some rows fail to parse with; Save without validating keeps it anyway (the FAQ's way out for unusual CSVs).
 */
export function EditSchema({ datasetId, initial, onClose, onSaved }: { datasetId: string; initial: DatasetSchema; onClose: () => void; onSaved: () => void }) {
  const [schema, setSchema] = useState<DatasetSchema>(initial);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [json, setJson] = useState(JSON.stringify(initial, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ validation: Validation; columns: Column[]; rows: Record<string, unknown>[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  const text = schema.dataFrameReaderClass === TEXT_READER;
  const p = (schema.customMetadata.textParserParams ?? {}) as TextParserParams;
  const o = (schema.customMetadata.options ?? {}) as Record<string, unknown>;
  const setP = (c: Partial<TextParserParams>) => setSchema({ ...schema, customMetadata: { ...schema.customMetadata, textParserParams: { ...p, ...c } } });
  const setO = (c: Record<string, unknown>) => setSchema({ ...schema, customMetadata: { ...schema.customMetadata, options: { ...o, ...c } } });

  const refresh = useCallback((s: DatasetSchema) => {
    datasetPreview.previewSchema(datasetId, s).then(
      (r) => {
        setPreview(r);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [datasetId]);
  useEffect(() => {
    const t = setTimeout(() => refresh(schema), 350);
    return () => clearTimeout(t);
  }, [schema, refresh]);

  const reinfer = async () => {
    setBusy(true);
    try {
      const opts = text ? { fieldDelimiter: p.fieldDelimiter, quoteCharacter: p.quoteCharacter, skipLines: p.skipLines, charsetName: p.charsetName, parser: p.parser } : {};
      const r = await datasetPreview.inferSchema(datasetId, opts);
      setSchema(r.schema);
      setJson(JSON.stringify(r.schema, null, 2));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (validate: boolean) => {
    setBusy(true);
    setSaveMenu(false);
    try {
      await datasetPreview.saveSchema(datasetId, schema, validate);
      onSaved();
    } catch (e) {
      const d = (e as Error & { detail?: { validation?: Validation } }).detail;
      if (d?.validation) setPreview((cur) => (cur ? { ...cur, validation: d.validation! } : cur));
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fields = schema.fieldSchemaList;
  const setField = (i: number, c: Partial<(typeof fields)[number]>) => setSchema({ ...schema, fieldSchemaList: fields.map((f, j) => (j === i ? { ...f, ...c } : f)) });
  const v = preview?.validation;
  return (
    <Modal title="Edit schema" icon="sliders" onClose={onClose} xl>
      <div className="grid h-[75vh] min-h-0 gap-0 overflow-hidden md:grid-cols-[22rem_1fr]">
        <div className="min-h-0 space-y-3 overflow-y-auto border-r border-line p-4 text-xs">
          <div className="flex overflow-hidden rounded-md border border-line">
            {(["form", "json"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  if (m === "json") setJson(JSON.stringify(schema, null, 2));
                  setMode(m);
                }}
                className={`flex-1 px-2 py-1 ${mode === m ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}
              >
                {m === "form" ? "Parsing options" : "Schema JSON"}
              </button>
            ))}
          </div>
          {mode === "json" ? (
            <div>
              <textarea
                value={json}
                spellCheck={false}
                onChange={(e) => {
                  setJson(e.target.value);
                  try {
                    setSchema(JSON.parse(e.target.value));
                    setJsonError(null);
                  } catch (err) {
                    setJsonError((err as Error).message);
                  }
                }}
                rows={30}
                className={`${inputClass} font-mono text-[11px]`}
              />
              {jsonError && <p className="mt-1 text-bad">{jsonError}</p>}
              <p className="mt-1 text-muted">
                dataFrameReaderClass: TextDataFrameReader (textParserParams), DataSourceDataFrameReader (format csv / json / parquet with Spark options such as header, multiLine,
                mode PERMISSIVE) or ParquetDataFrameReader.
              </p>
            </div>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-soft">Reader</span>
                <select
                  value={schema.dataFrameReaderClass === SOURCE_READER ? `source:${schema.customMetadata.format ?? "csv"}` : "text"}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "text") setSchema({ ...schema, dataFrameReaderClass: TEXT_READER, customMetadata: { textParserParams: p.parser ? p : (initial.customMetadata.textParserParams as TextParserParams) } });
                    else setSchema({ ...schema, dataFrameReaderClass: SOURCE_READER, customMetadata: { format: val.split(":")[1], options: val.endsWith("csv") ? { header: true, multiLine: true, mode: "PERMISSIVE" } : {} } });
                  }}
                  className={inputClass}
                >
                  <option value="text">CSV (TextDataFrameReader)</option>
                  <option value="source:csv">CSV (Spark CSV reader)</option>
                  <option value="source:json">JSON lines (Spark JSON reader)</option>
                  <option value="source:parquet">Parquet</option>
                </select>
              </label>
              {text ? (
                <>
                  <label className="block">
                    <span className="mb-1 block text-soft">Parser</span>
                    <select value={p.parser} onChange={(e) => setP({ parser: e.target.value as TextParserParams["parser"] })} className={inputClass}>
                      <option value="CSV_PARSER">CSV (quotes within one line)</option>
                      <option value="MULTILINE_CSV_PARSER">Multiline CSV (newlines inside quotes)</option>
                      <option value="SIMPLE_PARSER">Simple (split on the delimiter, no quotes)</option>
                      <option value="SINGLE_COLUMN_PARSER">Single column (one value per line)</option>
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-soft">Columns separated by</span>
                      <select
                        value={DELIMS.some(([d]) => d === p.fieldDelimiter) ? p.fieldDelimiter : "other"}
                        onChange={(e) => e.target.value !== "other" && setP({ fieldDelimiter: e.target.value })}
                        className={inputClass}
                      >
                        {DELIMS.map(([d, l]) => (
                          <option key={l} value={d}>
                            {l}
                          </option>
                        ))}
                        <option value="other">Other…</option>
                      </select>
                      {!DELIMS.some(([d]) => d === p.fieldDelimiter) && <input value={p.fieldDelimiter} maxLength={1} onChange={(e) => setP({ fieldDelimiter: e.target.value })} className={`${inputClass} mt-1`} />}
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-soft">Quotes</span>
                      <select value={p.quoteCharacter ?? ""} onChange={(e) => setP({ quoteCharacter: e.target.value })} className={inputClass}>
                        <option value={'"'}>Double (&quot;)</option>
                        <option value="'">Single (&apos;)</option>
                        <option value="">None</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-soft">Lines to skip (header rows)</span>
                      <input type="number" min={0} value={p.skipLines ?? 0} onChange={(e) => setP({ skipLines: Math.max(0, Number(e.target.value)) })} className={inputClass} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-soft">Encoding</span>
                      <select value={p.charsetName ?? "UTF-8"} onChange={(e) => setP({ charsetName: e.target.value })} className={inputClass}>
                        {["UTF-8", "UTF-16", "ISO-8859-1", "windows-1252", "Shift_JIS", "GBK"].map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-soft">Values read as null (comma separated)</span>
                    <input
                      value={(p.nullValues ?? []).join(",")}
                      onChange={(e) => setP({ nullValues: e.target.value.split(",").map((s) => s.trim()) })}
                      placeholder="(empty), NA, null"
                      className={inputClass}
                    />
                  </label>
                  <fieldset className="space-y-1.5 rounded-md border border-line p-2">
                    <legend className="px-1 text-soft">Parsing options</legend>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={p.jaggedRowBehavior === "DROP_ROW"} onChange={(e) => setP({ jaggedRowBehavior: e.target.checked ? "DROP_ROW" : "THROW_EXCEPTION" })} className="accent-[var(--color-ocean)]" />
                      Ignore jagged rows (more or fewer fields than columns)
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={p.parseErrorBehavior === "REPLACE_WITH_NULL"}
                        onChange={(e) => setP({ parseErrorBehavior: e.target.checked ? "REPLACE_WITH_NULL" : "THROW_EXCEPTION" })}
                        className="accent-[var(--color-ocean)]"
                      />
                      Values that do not parse become null
                    </label>
                    {(
                      [
                        ["addFilePath", "Add a file path column (_file_path)"],
                        ["addByteOffset", "Add the byte offset of the row (_byte_offset)"],
                        ["addImportedAt", "Add the import timestamp (_import_timestamp)"],
                        ["addRowNumber", "Add the row number (_row_number)"],
                      ] as const
                    ).map(([k, label]) => (
                      <label key={k} className="flex items-center gap-2">
                        <input type="checkbox" checked={!!p[k]} onChange={(e) => setP({ [k]: e.target.checked })} className="accent-[var(--color-ocean)]" />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                </>
              ) : (
                schema.customMetadata.format !== "parquet" && (
                  <fieldset className="space-y-1.5 rounded-md border border-line p-2">
                    <legend className="px-1 text-soft">Spark options</legend>
                    {schema.customMetadata.format === "csv" && (
                      <>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={String(o.header) === "true"} onChange={(e) => setO({ header: e.target.checked })} className="accent-[var(--color-ocean)]" /> header
                        </label>
                        <label className="flex items-center gap-2">
                          sep <input value={String(o.sep ?? ",")} maxLength={1} onChange={(e) => setO({ sep: e.target.value })} className={`${fieldClass} w-12`} />
                        </label>
                        <label className="flex items-center gap-2">
                          mode
                          <select value={String(o.mode ?? "PERMISSIVE")} onChange={(e) => setO({ mode: e.target.value })} className={fieldClass}>
                            {["PERMISSIVE", "DROPMALFORMED", "FAILFAST"].map((m) => (
                              <option key={m}>{m}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={String(o.multiLine) === "true"} onChange={(e) => setO({ multiLine: e.target.checked })} className="accent-[var(--color-ocean)]" /> multiLine
                    </label>
                    <p className="text-muted">PERMISSIVE pads rows with fewer fields with nulls: a standardized schema over CSVs that gained columns.</p>
                  </fieldset>
                )
              )}
              <div className="flex justify-between">
                <span className="font-medium text-soft">Columns ({fields.length})</span>
                <button type="button" onClick={() => setSchema({ ...schema, fieldSchemaList: [...fields, { type: "STRING", name: `column_${fields.length + 1}`, nullable: null, customMetadata: {} }] })} className="text-ocean hover:underline">
                  + Add column
                </button>
              </div>
              <ul className="space-y-1">
                {fields.map((f, i) => (
                  <li key={i} className="flex items-center gap-1">
                    <input value={f.name} onChange={(e) => setField(i, { name: e.target.value })} className={`${fieldClass} min-w-0 flex-1 font-mono`} />
                    <select value={f.type} onChange={(e) => setField(i, { type: e.target.value as FoundryType })} className={`${fieldClass} w-24`}>
                      {FOUNDRY_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    {text && (f.type === "DATE" || f.type === "TIMESTAMP") && (
                      <input
                        value={p.dateFormat?.[f.name] ?? ""}
                        placeholder={f.type === "DATE" ? "yyyy-MM-dd" : "ISO"}
                        title="JodaTime pattern (dateFormat)"
                        onChange={(e) => {
                          const df = { ...(p.dateFormat ?? {}) };
                          if (e.target.value) df[f.name] = e.target.value;
                          else delete df[f.name];
                          setP({ dateFormat: df });
                        }}
                        className={`${fieldClass} w-24 font-mono`}
                      />
                    )}
                    <button type="button" onClick={() => setSchema({ ...schema, fieldSchemaList: fields.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove column">
                      <Icon name="x" className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" disabled={busy} onClick={reinfer} className={`${buttonClass.secondary} w-full justify-center py-1 text-xs`}>
                <Icon name="refresh" className="h-3.5 w-3.5" /> Infer columns again with these options
              </button>
            </>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="border-b border-line p-3 text-xs">
            {v ? (
              v.problems.length ? (
                <p className="text-bad">{v.problems.join("; ")}</p>
              ) : v.ok ? (
                <p className="text-ok">
                  All {v.rows.toLocaleString()} rows parse{v.dropped_rows ? ` (${v.dropped_rows} jagged rows dropped)` : ""}.
                </p>
              ) : (
                <div className="text-bad">
                  Your dataset failed to validate on {v.failed_rows.toLocaleString()} rows.
                  <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-4 text-muted">
                    {v.errors.slice(0, 8).map((e, i) => (
                      <li key={i}>
                        {e.file ? `${e.file}, row ${e.row}: ` : ""}
                        {e.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            ) : (
              <p className="text-muted">Checking…</p>
            )}
            {error && <p className="mt-1 text-bad">{error}</p>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-panel text-left">
                <tr>
                  {(preview?.columns ?? []).map((c) => (
                    <th key={c.name} className="whitespace-nowrap border-b border-line px-2 py-1.5 font-medium">
                      {c.name} <span className="font-mono text-[9px] text-muted">{c.type}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(preview?.rows ?? []).map((r, i) => (
                  <tr key={i}>
                    {(preview?.columns ?? []).map((c) => (
                      <td key={c.name} className={`max-w-56 truncate border-b border-line px-2 py-1 ${r[c.name] === null ? "italic text-muted" : ""}`}>
                        {r[c.name] === null ? "null" : cellText(r[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="relative flex justify-end gap-2 border-t border-line p-3">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <div className="flex">
              <button type="button" disabled={busy || !!jsonError} onClick={() => save(true)} className={`${buttonClass.primary} rounded-r-none`}>
                <Icon name="save" className="h-3.5 w-3.5" /> Save and validate
              </button>
              <button type="button" disabled={busy || !!jsonError} onClick={() => setSaveMenu(!saveMenu)} className={`${buttonClass.primary} rounded-l-none border-l border-ink/30 px-1.5`} aria-label="More save options">
                <Icon name="down" className="h-3.5 w-3.5" />
              </button>
            </div>
            {saveMenu && (
              <div className="absolute bottom-12 right-3 w-56 rounded-md border border-line bg-panel py-1 text-xs shadow-2xl">
                <button type="button" onClick={() => save(false)} className="block w-full px-3 py-1.5 text-left hover:bg-panel-2">
                  Save without validating
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
