"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { lab } from "@/lib/jupyterLab";
import { CellEditor, type CellEditorHandle } from "./CellEditor";
import { JpIcon } from "./icons";
import { renderMarkdown } from "./render";

export type FileEditorState = { dirty: boolean; line: number; col: number };
export type FileEditorHandle = { save: (checkpoint?: boolean) => Promise<void>; focus: () => void; togglePreview: () => void; reload: () => Promise<void> };

const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;

/** A text file in a tab (JupyterLab's file editor): line numbers, Ctrl+S; Markdown files can show a preview. */
export const FileEditor = forwardRef<FileEditorHandle, { wid: string; path: string; active: boolean; onState: (path: string, s: FileEditorState) => void }>(
  function FileEditor({ wid, path, onState }, ref) {
    const [text, setText] = useState<string | null>(null);
    const [binary, setBinary] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [cursor, setCursor] = useState({ line: 1, col: 1 });
    const [preview, setPreview] = useState(false);
    const editor = useRef<CellEditorHandle>(null);
    const latest = useRef("");

    const pathRef = useRef(path);
    useEffect(() => {
      pathRef.current = path;
    });
    const load = useCallback(async () => {
      if (IMAGE.test(pathRef.current)) return setBinary(true);
      try {
        const m = await lab.get(wid, pathRef.current);
        if (m.format === "binary") setBinary(true);
        else {
          latest.current = String(m.content ?? "");
          setText(latest.current);
          setDirty(false);
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    }, [wid]);
    // load once: a rename keeps the content
    useEffect(() => {
      void load();
    }, [load]);

    const save = useCallback(async (checkpoint = false) => {
      if (text === null) return;
      await lab.save(wid, path, "file", latest.current, checkpoint);
      setDirty(false);
    }, [wid, path, text]);

    useEffect(() => onState(path, { dirty, line: cursor.line, col: cursor.col }), [onState, path, dirty, cursor]);
    useImperativeHandle(ref, () => ({ save, reload: load, focus: () => editor.current?.focus(), togglePreview: () => setPreview((v) => !v) }));

    if (err) return <div className="jp-FileEditor-preview jp-ErrorText">{err}</div>;
    if (binary)
      return (
        <div className="jp-FileEditor-preview" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          {IMAGE.test(path) ? (
            // eslint-disable-next-line @next/next/no-img-element -- a file of the workspace
            <img alt={path} src={lab.downloadUrl(wid, path)} style={{ maxWidth: "100%" }} />
          ) : (
            <p className="jp-Muted">{path.split("/").pop()} is not UTF-8 encoded text: it cannot be shown in the editor.</p>
          )}
          <a className="jp-Button jp-mod-accept" style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }} href={lab.downloadUrl(wid, path)}>
            <JpIcon name="download" style={{ fill: "#fff" }} /> Download
          </a>
        </div>
      );
    if (text === null) return <div className="jp-FileEditor-preview jp-Muted">Loading…</div>;
    const md = path.toLowerCase().endsWith(".md");
    return (
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div className="jp-FileEditor" style={{ flex: 1 }}>
          <CellEditor
            ref={editor}
            file
            value={text}
            lang={path.endsWith(".py") ? "python" : md ? "markdown" : "text"}
            onChange={(v) => {
              latest.current = v;
              setText(v);
              setDirty(true);
            }}
            onCursor={(line, col) => setCursor({ line, col })}
            keys={{ save: () => void save(true) }}
          />
        </div>
        {md && preview && <div className="jp-FileEditor-preview jp-RenderedHTMLCommon" style={{ flex: 1, borderLeft: "1px solid var(--jp-border-color2)" }} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
      </div>
    );
  },
);
