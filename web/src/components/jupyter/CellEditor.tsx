"use client";

import { acceptCompletion, autocompletion, closeBrackets, closeCompletion, closeBracketsKeymap, completionKeymap, completionStatus, startCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, insertNewlineAndIndent, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as cmPlaceholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

/** JupyterLab's CodeMirror colors (its --jp-mirror-editor-* variables). */
const jupyterHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: "var(--jp-mirror-editor-keyword-color)", fontWeight: "bold" },
  { tag: [t.bool, t.null, t.atom], color: "var(--jp-mirror-editor-atom-color)" },
  { tag: t.number, color: "var(--jp-mirror-editor-number-color)" },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: "var(--jp-mirror-editor-def-color)" },
  { tag: t.variableName, color: "var(--jp-mirror-editor-variable-color)" },
  { tag: [t.special(t.variableName), t.self], color: "var(--jp-mirror-editor-variable-2-color)" },
  { tag: [t.propertyName], color: "var(--jp-mirror-editor-property-color)" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--jp-mirror-editor-punctuation-color)" },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.updateOperator], color: "var(--jp-mirror-editor-operator-color)", fontWeight: "bold" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--jp-mirror-editor-comment-color)", fontStyle: "italic" },
  { tag: [t.string, t.special(t.string), t.docString], color: "var(--jp-mirror-editor-string-color)" },
  { tag: [t.meta, t.annotation], color: "var(--jp-mirror-editor-meta-color)" },
  { tag: [t.standard(t.variableName), t.function(t.variableName)], color: "var(--jp-mirror-editor-variable-color)" },
  { tag: t.className, color: "var(--jp-mirror-editor-variable-color)" },
  { tag: t.heading, color: "var(--jp-mirror-editor-header-color)", fontWeight: "bold" },
  { tag: t.quote, color: "var(--jp-mirror-editor-quote-color)" },
  { tag: [t.link, t.url], color: "var(--jp-mirror-editor-link-color)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, color: "var(--jp-mirror-editor-string-color)" },
  { tag: t.invalid, color: "#f00" },
]);

export type EditorLang = "python" | "markdown" | "text";

export type CompleteFn = (code: string, pos: number) => Promise<{ matches: string[]; from: number; to: number } | null>;
export type InspectFn = (code: string, pos: number, at: { x: number; y: number }) => void;

export type EditorKeys = {
  /** Shift+Enter, Ctrl+Enter, Alt+Enter (the notebook runs the cell). */
  run?: (how: "advance" | "stay" | "insert") => void;
  /** Escape: command mode. */
  escape?: () => void;
  /** Arrow up on the first line / down on the last: the previous / next cell. */
  edge?: (dir: -1 | 1) => boolean;
  /** Ctrl+Shift+-: split the cell at the cursor. */
  split?: (pos: number) => void;
  save?: () => void;
};

export type CellEditorHandle = { focus: (where?: "start" | "end" | number) => void; blur: () => void; cursor: () => { line: number; col: number; pos: number }; view: () => EditorView | null };

type Props = {
  value: string;
  lang: EditorLang;
  onChange: (v: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onCursor?: (line: number, col: number) => void;
  keys?: EditorKeys;
  complete?: CompleteFn;
  inspect?: InspectFn;
  lineNumbers?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  /** a whole-file editor (file tabs) rather than a cell */
  file?: boolean;
};

const langOf = (lang: EditorLang): Extension => (lang === "python" ? python() : lang === "markdown" ? markdown() : []);

export const CellEditor = forwardRef<CellEditorHandle, Props>(function CellEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const compartments = useRef({ lang: new Compartment(), gutter: new Compartment(), ro: new Compartment() });

  useEffect(() => {
    const p = latest.current;
    const c = compartments.current;
    // the kernel's answer to the Tab that opened the list (asked once, by tabKey)
    let pending: { doc: string; pos: number; r: Awaited<ReturnType<CompleteFn>> } | null = null;
    const completionSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
      const fn = latest.current.complete;
      if (!fn) return null;
      const doc = ctx.state.doc.toString();
      const r = pending && pending.doc === doc && pending.pos === ctx.pos ? pending.r : await fn(doc, ctx.pos);
      pending = null;
      if (!r || !r.matches.length) return null;
      return { from: r.from, to: r.to, options: r.matches.map((m) => ({ label: m, type: "variable" })), filter: false };
    };
    /** Tab: one match is inserted right away, several open the list (as JupyterLab does). */
    const completeAtCursor = (v: EditorView) => {
      const fn = latest.current.complete;
      if (!fn) return false;
      const doc = v.state.doc.toString();
      const pos = v.state.selection.main.head;
      void fn(doc, pos).then((r) => {
        if (!r || !r.matches.length || v.state.doc.toString() !== doc) return;
        if (r.matches.length === 1) v.dispatch({ changes: { from: r.from, to: r.to, insert: r.matches[0] }, selection: { anchor: r.from + r.matches[0].length } });
        else {
          pending = { doc, pos, r };
          startCompletion(v);
        }
      });
      return true;
    };
    const tabKey = (v: EditorView) => {
      const { state } = v;
      if (completionStatus(state) === "active") return acceptCompletion(v);
      const sel = state.selection.main;
      if (!sel.empty) return indentMore(v);
      const line = state.doc.lineAt(sel.head);
      const before = line.text.slice(0, sel.head - line.from);
      if (!before.trim() || latest.current.lang !== "python" || !latest.current.complete) return indentMore(v);
      return completeAtCursor(v);
    };
    const shiftTab = (v: EditorView) => {
      const sel = v.state.selection.main;
      if (!sel.empty || !latest.current.inspect) return indentLess(v);
      const coords = v.coordsAtPos(sel.head);
      latest.current.inspect(v.state.doc.toString(), sel.head, { x: coords?.left ?? 0, y: coords?.bottom ?? 0 });
      return true;
    };
    const notebookKeys = Prec.highest(
      keymap.of([
        { key: "Shift-Enter", run: () => (latest.current.keys?.run ? (latest.current.keys.run("advance"), true) : false) },
        { key: "Mod-Enter", run: () => (latest.current.keys?.run ? (latest.current.keys.run("stay"), true) : false) },
        { key: "Alt-Enter", run: () => (latest.current.keys?.run ? (latest.current.keys.run("insert"), true) : false) },
        {
          key: "Escape",
          run: (v) => {
            if (completionStatus(v.state)) return closeCompletion(v);
            if (!latest.current.keys?.escape) return false;
            v.contentDOM.blur();
            latest.current.keys.escape();
            return true;
          },
        },
        { key: "Ctrl-m", run: (v) => (latest.current.keys?.escape ? (v.contentDOM.blur(), latest.current.keys.escape(), true) : false) },
        { key: "Mod-s", run: () => (latest.current.keys?.save ? (latest.current.keys.save(), true) : false), preventDefault: true },
        {
          key: "Mod-Shift--",
          run: (v) => (latest.current.keys?.split ? (latest.current.keys.split(v.state.selection.main.head), true) : false),
        },
        {
          key: "ArrowUp",
          run: (v) => {
            const sel = v.state.selection.main;
            if (!sel.empty || v.state.doc.lineAt(sel.head).number !== 1) return false;
            return latest.current.keys?.edge?.(-1) ?? false;
          },
        },
        {
          key: "ArrowDown",
          run: (v) => {
            const sel = v.state.selection.main;
            if (!sel.empty || v.state.doc.lineAt(sel.head).number !== v.state.doc.lines) return false;
            return latest.current.keys?.edge?.(1) ?? false;
          },
        },
      ]),
    );
    const state = EditorState.create({
      doc: p.value,
      extensions: [
        notebookKeys,
        c.gutter.of(p.lineNumbers || p.file ? [lineNumbers(), highlightActiveLineGutter()] : []),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        autocompletion({ override: [completionSource], activateOnTyping: false, icons: false, defaultKeymap: true }),
        syntaxHighlighting(jupyterHighlight),
        c.lang.of(langOf(p.lang)),
        c.ro.of([EditorState.readOnly.of(!!p.readOnly), EditorView.editable.of(!p.readOnly)]),
        p.file ? highlightActiveLine() : [],
        p.placeholder ? cmPlaceholder(p.placeholder) : [],
        EditorView.lineWrapping,
        keymap.of([
          { key: "Tab", run: tabKey },
          { key: "Shift-Tab", run: shiftTab },
          { key: "Enter", run: insertNewlineAndIndent },
          { key: "Mod-z", run: undo },
          { key: "Mod-Shift-z", run: redo },
          { key: "Mod-y", run: redo },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          if (u.focusChanged) (u.view.hasFocus ? latest.current.onFocus : latest.current.onBlur)?.();
          if (u.selectionSet || u.focusChanged) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            latest.current.onCursor?.(line.number, head - line.from + 1);
          }
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, []);

  // the value changed from outside (undo of a cell operation, a reload): replace the document
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);
  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.lang.reconfigure(langOf(props.lang)) });
  }, [props.lang]);
  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.gutter.reconfigure(props.lineNumbers || props.file ? [lineNumbers(), highlightActiveLineGutter()] : []) });
  }, [props.lineNumbers, props.file]);
  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.ro.reconfigure([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]) });
  }, [props.readOnly]);

  useImperativeHandle(ref, () => ({
    focus: (where) => {
      const v = view.current;
      if (!v) return;
      v.focus();
      if (where !== undefined) {
        const pos = where === "start" ? 0 : where === "end" ? v.state.doc.length : Math.min(where, v.state.doc.length);
        v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      }
    },
    blur: () => view.current?.contentDOM.blur(),
    cursor: () => {
      const v = view.current;
      if (!v) return { line: 1, col: 1, pos: 0 };
      const head = v.state.selection.main.head;
      const line = v.state.doc.lineAt(head);
      return { line: line.number, col: head - line.from + 1, pos: head };
    },
    view: () => view.current,
  }));

  return <div ref={host} className={props.file ? "jp-FileEditor-cm" : "jp-CellEditor"} style={props.file ? { height: "100%" } : undefined} />;
});
