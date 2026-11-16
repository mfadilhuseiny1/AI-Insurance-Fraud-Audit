"""The AI assistant beside a JupyterLab (Docker) workspace: it writes, edits, runs and explains the open notebook's code
with DeepSeek (aip/models.py DEEPSEEK: an open model on Vertex AI, behind the platform's spend guard and audit log).

It follows Jupyter AI's Jupyternaut (github.com/jupyter-ai-contrib/jupyter-ai-jupyternaut, BSD-3-Clause): chat first,
notebook tools only when the user means the notebook, cells named by their nbformat id, a change run and checked (three
attempts at most) — and, asked for a complete notebook, builds it whole (create_notebook) and runs it through
(run_all_cells), after finding the real data files (list_files, read_file). The tools are those of jupyterlab-ai-commands
(github.com/jupyter-ai-contrib/jupyterlab-ai-commands, BSD-3-Clause), and like them they run in the browser, on
JupyterLab's live notebook: jupyterlab_bridge/bridge.js, which the relay (code_workspace_vscode.py) puts in JupyterLab's
pages with `with_bridge`. The difference: every change — adding, editing or deleting a cell, running one — waits for the
user's Apply in the platform's page; reading needs none. The model holds no key to the container, and nothing changes
behind the user's back.

    GET  /api/code-workspaces/<id>/assist          the model, whether it is enabled, the tools and which of them wait
    POST /api/code-workspaces/<id>/assist/turn     one model turn as server-sent events: "chunk" / "reset" as the answer
         is written, then "result": {text, tool_calls, message} — the tool calls for the page to run (or ask about) and
         the assistant turn to send back with their results — or {error}.
    GET  /api/code-workspaces/<id>/assist/inspect  inspect_data, run by the page: a data file's columns, rows and first
         rows, read by DuckDB here (the workspace's files are this machine's folder that JupyterLab serves).

The page keeps the conversation (the platform's neutral messages, pipeline_ai.chat_tools) and sends the notebook as the
bridge reads it with every turn; it goes with the user's latest message, so the model always sees the notebook as it is.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import queue
import re
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import auth
import code_workspaces as cw
import pipeline_ai
from aip import models as aip_models

router = APIRouter(prefix="/api/code-workspaces/{wid}", tags=["code-workspaces"])
log = logging.getLogger("code_workspace_assist")

MODEL = aip_models.DEEPSEEK
LABEL = aip_models.MODELS[MODEL]["label"]
TEMPERATURE = 0.2
MAX_TOKENS = 16000  # a complete notebook in one create_notebook call
CONTEXT_BUDGET = 60_000  # characters of the notebook the model reads with a turn
TOOL_RESULT_MAX = 40_000  # characters of one tool result sent back
REQUEST_MAX = 2_000_000  # bytes of one turn's conversation
BRIDGE = Path(__file__).resolve().parent / "jupyterlab_bridge" / "bridge.js"

SYSTEM = f"""You are the AI assistant beside JupyterLab in the user's Code Workspace, powered by {LABEL}. You help the user write, edit, run and understand the code of the notebook open in JupyterLab.

How to respond
- Chat first. Answer questions, explanations and examples in the chat: concisely, in markdown, code in fenced blocks with the language (```python). Use the notebook tools only when the user clearly wants their notebook changed or run: "add", "write it in the notebook", "edit", "fix this", "run", "this cell", "my notebook". When it is unclear, answer in the chat and offer to put it in the notebook.
- Explaining code: what it does step by step, its inputs and outputs, and anything surprising; refer to cells as "cell N" and to variables by name. No tools needed.
- Answer in the language the user writes in (Indonesian or English). The panel is narrow: short paragraphs and lists.
- If you do not know, say so. Never claim a result you have not seen in an output.

How much to build
- A small request (a cell, a fix, a plot): one or two cells, then ask whether to go on.
- A complete notebook (the user asks for a whole analysis or model, "lengkap", "complete", "from start to finish", "end to end"): build it whole with create_notebook, in this order — a title and the question it answers (markdown); setup and imports; loading the data; checking it (shape, types, missing values); exploring it; the method; the results with tables and plots; a conclusion that states what the outputs show. Before each code cell put a short markdown cell saying what it does and why. Then propose run_all_cells (unless the user already created and ran it) and fix what fails, cell by cell.
- Never guess a file or a column. Before code that reads data, find the real files with list_files and look inside each data file with inspect_data (Parquet, CSV, JSON: its columns and types, the number of rows and the first rows); read other text files with read_file. Write the code with the column names exactly as inspect_data shows them.
- Calling a tool again with the same arguments gives the same result: use the result you have and move on.

The notebook
- The user's latest message comes with the notebook as JupyterLab holds it now (unsaved edits included): each cell numbered, with its cell_id, its source and its outputs (long ones cut), the active cell (where the user's cursor is) and any text the user selected. "This cell" or "here" means the active cell; selected text is what the user asks about.
- Use cell ids exactly as shown. After you add or delete cells, call read_notebook before the next change.
- A new notebook with one empty cell: add_cell fills that cell.
- Keep the notebook's own libraries, names and style. The kernel runs in the workspace's Python environment: a requirements.txt in the workspace's root, when there is one, lists its packages (read_file). A library the code needs that is not installed gets a `%pip install -q <package>` line at the top of the setup cell, and you say so.

Changes wait for the user
- add_cell, edit_cell, delete_cell, run_cell, create_notebook and run_all_cells are shown to the user as proposals with a preview, and each happens only when the user presses Apply. The result tells you whether the user applied it, applied and ran it (with the outputs), or rejected it: after a rejection, adjust, do not propose the same again.
- After adding or editing code, propose run_cell for it unless the result says the user already ran it, and read the outputs. On an error, explain the cause in one sentence and propose the fix; after three failed attempts at the same error, stop and say what is wrong.
- Give add_cell, edit_cell and create_notebook each cell's whole source, raw: no ``` fences and no commentary in it. Change only what the request needs.
- Do not repeat cell sources or tool results back to the user. After a change, confirm in one short sentence (for example "✓ Added the import cell").

Formatting: markdown; code in fenced blocks with the language; math in LaTeX between \\( and \\)."""

_CELL_ID = {"type": "string", "description": "the cell's cell_id, exactly as the notebook shows it"}
TOOLS: list[dict[str, Any]] = [
    {"name": "read_notebook", "description": "Read the open notebook again as it is now: every cell with its cell_id, type, source and outputs (long ones cut), "
                                             "and the active cell. Use it after cells were added or deleted, before the next change.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "read_cell", "description": "Read one cell whole: its source and its outputs, longer than read_notebook shows them.",
     "parameters": {"type": "object", "properties": {"cell_id": _CELL_ID}, "required": ["cell_id"]}},
    {"name": "add_cell", "description": "Add a cell (the user sees it and approves it first). By default a code cell below the active cell.",
     "parameters": {"type": "object", "properties": {
         "content": {"type": "string", "description": "the cell's whole source, raw (no ``` fences)"},
         "cell_type": {"type": "string", "enum": ["code", "markdown"]},
         "reference_cell_id": {"type": "string", "description": "the cell_id of the cell the new one goes next to (default: the active cell)"},
         "position": {"type": "string", "enum": ["below", "above"], "description": "below (default) or above the reference cell"}},
         "required": ["content"]}},
    {"name": "edit_cell", "description": "Replace a cell's whole source (the user sees the diff and approves it first).",
     "parameters": {"type": "object", "properties": {"cell_id": _CELL_ID, "content": {"type": "string", "description": "the cell's whole new source, raw (no ``` fences)"}},
                    "required": ["cell_id", "content"]}},
    {"name": "delete_cell", "description": "Delete a cell (the user approves it first).",
     "parameters": {"type": "object", "properties": {"cell_id": _CELL_ID}, "required": ["cell_id"]}},
    {"name": "run_cell", "description": "Run a code cell in the notebook's kernel (the user approves it first) and get its outputs: the status (ok / error) "
                                        "and, for an error, its name, message and traceback.",
     "parameters": {"type": "object", "properties": {"cell_id": _CELL_ID}, "required": ["cell_id"]}},
    {"name": "run_all_cells", "description": "Run the notebook's code cells top to bottom in its kernel (the user approves it first), stopping at the first "
                                             "error: which cells ran, and the failing cell's error and outputs.",
     "parameters": {"type": "object", "properties": {"from_cell_id": {"type": "string", "description": "start at this cell instead of the first"}}}},
    {"name": "create_notebook", "description": "Create a new notebook with all its cells and open it in JupyterLab (the user sees the outline and approves it "
                                               "first). For a complete notebook in one go; the file name gets a number when it is taken.",
     "parameters": {"type": "object", "properties": {
         "name": {"type": "string", "description": "file name, e.g. analisis_klaim.ipynb"},
         "cells": {"type": "array", "description": "the cells in order", "items": {"type": "object", "properties": {
             "cell_type": {"type": "string", "enum": ["markdown", "code"]},
             "content": {"type": "string", "description": "the cell's whole source, raw (no ``` fences)"}}, "required": ["cell_type", "content"]}},
         "directory": {"type": "string", "description": "folder relative to the workspace's root (default: the open notebook's folder)"}},
         "required": ["name", "cells"]}},
    {"name": "list_files", "description": "List a folder of the workspace (names, types, sizes): the real paths of data files.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "folder relative to the workspace's root (default: the root)"}}}},
    {"name": "read_file", "description": "Read a text file of the workspace (.py, .md, .txt, .json, requirements.txt): the whole file when it is short, "
                                         "else 200 lines from `start` (the result says which lines it shows and where the rest begins). Binary files "
                                         "(Parquet, Excel, images) cannot be read here: inspect_data shows a data file's contents.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "file path relative to the workspace's root"},
                                                     "start": {"type": "integer", "description": "first line to show (1 = the top)"},
                                                     "lines": {"type": "integer", "description": "how many lines (at most 400)"}},
                    "required": ["path"]}},
    {"name": "inspect_data", "description": "Look inside a data file of the workspace without loading it: its columns with their types, the number of rows and "
                                            "the first 5 rows (Parquet, CSV, TSV, JSON). Use it before writing code that reads the file.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "file path relative to the workspace's root, e.g. data/klaim.parquet"}},
                    "required": ["path"]}},
]
# the tools that change the notebook or run code: the page runs them only after the user's Apply
CHANGES = {"add_cell", "edit_cell", "delete_cell", "run_cell", "run_all_cells", "create_notebook"}


# ------------------------------------------------------------------------------------------------
# the notebook as the model reads it
# ------------------------------------------------------------------------------------------------


def _outputs_text(outs: list[dict], whole: bool) -> str:
    parts = []
    for o in outs:
        kind = o.get("kind")
        if kind == "error":
            tb = str(o.get("traceback") or "") if whole else ""
            parts.append(f"Error: {o.get('ename')}: {o.get('evalue')}" + (f"\n{tb}" if tb else ""))
        elif not whole:
            continue
        elif kind == "stream":
            parts.append(f"[{o.get('name') or 'stdout'}] {o.get('text') or ''}".rstrip())
        else:
            shown = [m for m in o.get("media") or [] if m != "text/plain"]
            parts.append(f"{o.get('text') or ''}".rstrip() + (f"\n({', '.join(shown)} shown)" if shown else ""))
    parts = [p for p in parts if p.strip()]
    return ("Outputs:\n```text\n" + "\n".join(parts).replace("```", "'''") + "\n```") if parts else ""


def _cell_text(c: dict, lang: str, whole: bool) -> str:
    kind = c.get("type") or "code"
    count = c.get("execution_count")
    title = f"## Cell {c.get('n')} · {kind} · cell_id {c.get('cell_id')}" + (f" · [{count}]" if count else "")
    src = str(c.get("source") or "")
    if not whole:
        lines = src.splitlines()
        src = "\n".join(lines[:12]) + (f"\n… ({len(lines) - 12} more lines: read_cell)" if len(lines) > 12 else "")
    body = f"```{lang if kind == 'code' else kind}\n{src}\n```" if src.strip() else "(empty)"
    outs = _outputs_text(c.get("outputs") or [], whole)
    return "\n".join(x for x in (title, body, outs) if x)


def notebook_context(nb: Optional[dict], budget: int = CONTEXT_BUDGET) -> str:
    """The bridge's read of JupyterLab (bridge.js `snapshot`) as the model reads it: the notebook in front, cell by cell.
    Over the budget, the active cell, its neighbours and the cells with an error stay whole and the rest go in brief."""
    if not nb or nb.get("kind") != "notebook":
        seen = (nb or {}).get("title") or ""
        return ("# JupyterLab now\nNo notebook is open in front" + (f" (the user has {seen!r} open)" if seen else "")
                + ": the notebook tools have nothing to work on; answer in the chat, or ask the user to open the notebook.")
    cells = [c for c in nb.get("cells") or [] if isinstance(c, dict)]
    lang = str(nb.get("language") or "python")
    active = next((c for c in cells if c.get("cell_id") == nb.get("active_cell_id")), None)
    head = ["# The notebook open in JupyterLab now (unsaved edits included)",
            f"{nb.get('path')} · {len(cells)} cells · kernel {nb.get('kernel') or 'none'} ({nb.get('kernel_status') or 'not started'})"
            + (" · unsaved changes" if nb.get("dirty") else ""),
            f"Active cell (the user's cursor): cell {active.get('n')}, cell_id {active.get('cell_id')}" if active else "No active cell."]
    if nb.get("selection"):
        head.append(f"Text the user selected in the active cell:\n```{lang}\n{nb['selection']}\n```")
    blocks = [_cell_text(c, lang, True) for c in cells]
    if sum(map(len, blocks)) > budget:
        at = (int(active.get("n") or 1) - 1) if active else len(cells) - 1
        keep = set(range(at - 3, at + 4)) | {i for i, c in enumerate(cells) if any(o.get("kind") == "error" for o in c.get("outputs") or [])}
        blocks = [_cell_text(c, lang, i in keep) for i, c in enumerate(cells)]
        if sum(map(len, blocks)) > budget:
            # still too long: the cells away from the cursor as one line each
            blocks = [b if i in keep else f"## Cell {c.get('n')} · {c.get('type')} · cell_id {c.get('cell_id')} · "
                      f"{(str(c.get('source') or '').strip().splitlines() or ['(empty)'])[0][:120]} (read_cell for the rest)"
                      for i, (b, c) in enumerate(zip(blocks, cells))]
    return "\n".join(head) + "\n\n" + "\n\n".join(blocks)


# ------------------------------------------------------------------------------------------------
# the bridge in JupyterLab's pages
# ------------------------------------------------------------------------------------------------

_CONFIG = re.compile(r"""(<script[^>]*\bid=["']jupyter-config-data["'][^>]*>)(.*?)(</script>)""", re.S)
_bridge_js: dict[str, str] = {}


def with_bridge(html: str, origins: list[str]) -> str:
    """JupyterLab's page with the assistant's bridge: the app exposed to it (page config exposeAppInBrowser, read by
    JupyterLab's bootstrap as --LabApp.expose_app_in_browser sets it) and its script, which answers only `origins`.
    A page without JupyterLab's config is returned as it came."""
    m = _CONFIG.search(html)
    if not m:
        return html
    try:
        config = json.loads(m.group(2))
    except ValueError:
        return html
    config["exposeAppInBrowser"] = True
    data = json.dumps(config, ensure_ascii=False).replace("</", "<\\/")
    html = html[: m.start(2)] + data + html[m.end(2):]
    stamp = str(BRIDGE.stat().st_mtime_ns)  # read again when the file changes (no API restart for a bridge fix)
    if _bridge_js.get("stamp") != stamp:
        _bridge_js.update(js=BRIDGE.read_text("utf-8"), stamp=stamp)
    script = _bridge_js["js"].replace("__BLUESANDAI_ORIGINS__", json.dumps(origins))
    tag = f'<script id="bluesandai-assist-bridge">{script}</script>'
    end = html.rfind("</body>")
    return html[:end] + tag + html[end:] if end >= 0 else html + tag


# ------------------------------------------------------------------------------------------------
# a turn
# ------------------------------------------------------------------------------------------------

# DeepSeek sometimes leaves its call markup after the arguments ("…}</｜DSML｜parameter>", aip/adk_runtime/tools.py)
_MARKUP = re.compile(r"(?:\s*</?\s*｜DSML｜[^>]*>)+\s*$")


def _parse_args(raw: str) -> tuple[Optional[dict], str]:
    """A call's arguments from the provider's text: JSON, also with raw newlines in its strings (strict=False) or with
    call markup or other text after it (the leading object). (None, why) when there is no object to read."""
    s = _MARKUP.sub("", raw.strip())
    if not s:
        return {}, ""
    why = ""
    for read in (lambda: json.loads(s, strict=False), lambda: json.JSONDecoder(strict=False).raw_decode(s[s.find("{"):])[0]):
        try:
            v = read()
        except ValueError as e:
            why = why or str(e)
            continue
        if isinstance(v, dict):
            return v, ""
        why = why or "the arguments are not a JSON object"
    return None, why


def syntax_error(source: str) -> Optional[str]:
    """The SyntaxError a Python cell raises before it runs (IPython's %magics and !shell lines read as IPython reads
    them, top-level await allowed), or None. Cell magics (%%bash, …) hold another language: not checked."""
    import ast

    if source.lstrip().startswith("%%"):
        return None
    try:
        from IPython.core.inputtransformer2 import TransformerManager

        code = TransformerManager().transform_cell(source)
    except Exception:  # noqa: BLE001 - without IPython, magics and shell lines as no-ops
        code = "\n".join(line[: len(line) - len(line.lstrip())] + "pass" if line.lstrip().startswith(("%", "!")) else line for line in source.splitlines())
    try:
        compile(code, "<cell>", "exec", flags=ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except SyntaxError as e:
        return f"line {e.lineno}: {e.msg}" + (f": {e.text.strip()}" if e.text and e.text.strip() else "")
    return None


def _code_errors(name: str, args: dict, nb: Optional[dict]) -> Optional[str]:
    """The syntax errors of the code a change would put in a Python notebook (a deterministic gate: the user is shown
    no proposal that cannot even compile; the model gets it back to fix)."""
    if nb and nb.get("kind") == "notebook" and str(nb.get("language") or "python") != "python":
        return None
    if name == "add_cell" and args.get("cell_type") != "markdown" and isinstance(args.get("content"), str):
        return syntax_error(args["content"])
    if name == "edit_cell" and isinstance(args.get("content"), str):
        cell = next((c for c in (nb or {}).get("cells") or [] if isinstance(c, dict) and c.get("cell_id") == args.get("cell_id")), None)
        return syntax_error(args["content"]) if (cell or {}).get("type", "code") == "code" else None
    if name == "create_notebook" and isinstance(args.get("cells"), list):
        found = [f"cell {i}: {e}" for i, c in enumerate(args["cells"], 1)
                 if isinstance(c, dict) and c.get("cell_type") != "markdown" and isinstance(c.get("content"), str) and (e := syntax_error(c["content"]))]
        return "; ".join(found) or None
    return None


def _call(t: dict, nb: Optional[dict] = None) -> dict:
    """A tool call as the page runs it: arguments read leniently when the provider's text was not strict JSON, and no
    call markup left at the end of a source; `args_error` says why arguments could not be read, `syntax_error` which
    code it proposes does not compile."""
    args, why = t.get("args"), ""
    if args is None:
        args, why = _parse_args(str(t.get("raw_args") or ""))
        if args is None:
            raw = str(t.get("raw_args") or "")
            log.warning("unreadable %s arguments (%d chars, %s): %r … %r", t.get("name"), len(raw), why, raw[:200], raw[-200:])
    if isinstance(args, dict):
        args = {k: _MARKUP.sub("", v) if isinstance(v, str) else v for k, v in args.items()}
    out = {"id": t["id"], "name": t["name"], "args": args, "raw_args": t.get("raw_args") or "", "change": t["name"] in CHANGES}
    if args is None:
        out["args_error"] = why
    elif (bad := _code_errors(t["name"], args, nb)):
        out["syntax_error"] = bad
    return out


def _json_object(s: Any) -> bool:
    try:
        return isinstance(json.loads(s), dict) if isinstance(s, str) else isinstance(s, dict)
    except ValueError:
        return False


def _sendable(turn: dict) -> dict:
    """An assistant turn as it goes back to the model: a tool call whose arguments were not JSON goes back with {}
    (Vertex refuses the whole request otherwise: "Expected a valid JSON object", seen 2026-10-27); its result says why."""
    native = turn.get("native")
    if isinstance(native, dict) and isinstance(native.get("openai"), dict):
        oa = {**native["openai"], "tool_calls": [
            {**tc, "function": {**(tc.get("function") or {}), "arguments": (tc.get("function") or {}).get("arguments")
                                if _json_object((tc.get("function") or {}).get("arguments")) else "{}"}}
            for tc in native["openai"].get("tool_calls") or [] if isinstance(tc, dict)]}
        if not oa["tool_calls"]:
            oa.pop("tool_calls")
        turn = {**turn, "native": {**native, "openai": oa}}
    calls = [{**c, "raw_args": c.get("raw_args") if _json_object(c.get("raw_args") or "{}") else "{}"} for c in turn.get("tool_calls") or [] if isinstance(c, dict)]
    return {**turn, "tool_calls": calls}


def _messages(given: list[dict], context: str) -> list[dict]:
    """The page's conversation as chat_tools takes it, the notebook's context with the user's latest message."""
    out: list[dict] = []
    for m in given:
        role = m.get("role")
        if role == "user":
            out.append({"role": "user", "text": str(m.get("text") or "")})
        elif role == "assistant":
            turn = {"role": "assistant", "text": str(m.get("text") or ""), "tool_calls": m.get("tool_calls") or []}
            if isinstance(m.get("native"), dict):
                turn["native"] = m["native"]
            out.append(_sendable(turn))
        elif role == "tool":
            result = m.get("result")
            shown = json.dumps(result, ensure_ascii=False, default=str)
            if len(shown) > TOOL_RESULT_MAX:
                result = {"cut": True, "text": shown[: TOOL_RESULT_MAX - 2000] + " … " + shown[-1500:]}
            out.append({"role": "tool", "id": str(m.get("id") or ""), "name": str(m.get("name") or ""), "result": result,
                        **({"provider_id": m["provider_id"]} if m.get("provider_id") else {})})
    last = next((i for i in range(len(out) - 1, -1, -1) if out[i]["role"] == "user"), None)
    if last is None:
        raise HTTPException(400, "the conversation has no message from the user")
    out[last] = {**out[last], "text": f"{out[last]['text']}\n\n---\n{context}"}
    return out


def _workspace(wid: str) -> dict:
    rec = cw._get(wid, "editor")
    if rec.get("kind") != "jupyterlab":
        raise HTTPException(400, "The AI assistant works in JupyterLab (Docker) workspaces")
    return rec


READERS = {".parquet": "read_parquet", ".csv": "read_csv_auto", ".tsv": "read_csv_auto", ".txt": "read_csv_auto", ".json": "read_json_auto",
           ".jsonl": "read_json_auto", ".ndjson": "read_json_auto"}
SAMPLE_ROWS = 5
COUNT_MAX_BYTES = 300_000_000  # a text file larger than this is not scanned to count its rows (Parquet counts from its footer)


def inspect(path: Path, shown_as: str) -> dict:
    """A data file's columns and types, its number of rows and its first rows, read by DuckDB without loading the file
    (the workspace's own files, the folder JupyterLab serves)."""
    import duckdb

    if not path.is_file():
        raise HTTPException(404, f"{shown_as} is not a file of the workspace: list_files shows what is there")
    reader = READERS.get(path.suffix.lower())
    if reader is None:
        raise HTTPException(400, f"{shown_as}: inspect_data reads Parquet, CSV, TSV and JSON files; look into others with a code cell")
    con = duckdb.connect()
    try:
        con.execute("SET threads = 2")
        con.execute("SET memory_limit = '512MB'")
        src = f"{reader}('{path.as_posix().replace(chr(39), chr(39) * 2)}')"
        columns = [{"name": r[0], "type": r[1]} for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()]
        rows = con.execute(f"SELECT count(*) FROM {src}").fetchone()[0] if reader == "read_parquet" or path.stat().st_size <= COUNT_MAX_BYTES else None
        cur = con.execute(f"SELECT * FROM {src} LIMIT {SAMPLE_ROWS}")
        names = [d[0] for d in cur.description]
        sample = [{n: (None if v is None else str(v)[:60]) for n, v in zip(names, r)} for r in cur.fetchall()]
    except duckdb.Error as e:
        raise HTTPException(400, f"{shown_as} could not be read: {str(e)[:300]}") from e
    finally:
        con.close()
    return {"path": shown_as, "bytes": path.stat().st_size, "rows": rows, "columns": columns, "first_rows": sample}


class TurnIn(BaseModel):
    messages: list[dict] = Field(..., max_length=400)
    notebook: Optional[dict] = None
    # the page saw the model repeat a call it had already made (and answered it with the earlier result): this turn
    # gets a nudge and more temperature, which is what takes a model out of a repetition loop
    nudge: bool = False


NUDGE = ("\n\nYou just repeated a call you had already made: its result was given to you again. Do not repeat calls. "
         "You have what you read so far: take the next step of the user's request now (for a notebook, create_notebook or "
         "add_cell), or answer.")
NUDGE_TEMPERATURE = 0.7


@router.get("/assist")
async def info(wid: str) -> dict:
    await asyncio.to_thread(_workspace, wid)
    me = auth.current() or {}
    who = await asyncio.to_thread(auth.user_label, me.get("id")) if me.get("id") else None
    return {"model": MODEL, "label": LABEL, "ready": aip_models.ready(MODEL), "user": (who or {}).get("display_name") or me.get("username") or "",
            "tools": [t["name"] for t in TOOLS], "changes": sorted(CHANGES)}


@router.get("/assist/inspect")
async def inspect_route(wid: str, path: str) -> dict:
    """inspect_data, which the page runs for the model: a data file of the workspace looked into without loading it."""
    import code_workspace_lab as lab

    await asyncio.to_thread(_workspace, wid)
    shown = path.strip().strip("/")
    return await asyncio.to_thread(inspect, lab._resolve(wid, shown), shown)


@router.post("/assist/turn")
async def turn(wid: str, req: TurnIn, request: Request) -> StreamingResponse:
    await asyncio.to_thread(_workspace, wid)
    if len(json.dumps(req.messages, ensure_ascii=False, default=str)) > REQUEST_MAX:
        raise HTTPException(413, "the conversation is too long: start a new one")
    messages = _messages(req.messages, notebook_context(req.notebook))
    q: queue.Queue = queue.Queue()
    cancel = threading.Event()
    sent = [""]

    def so_far(text: str) -> None:
        # the answer so far, after each piece ("" when a failed attempt starts again)
        if not text.startswith(sent[0]):
            q.put(("reset", {}))
            sent[0] = ""
        if len(text) > len(sent[0]):
            q.put(("chunk", text[len(sent[0]):]))
            sent[0] = text

    def work() -> None:
        try:
            out = pipeline_ai.chat_tools(MODEL, SYSTEM + (NUDGE if req.nudge else ""), messages, TOOLS, NUDGE_TEMPERATURE if req.nudge else TEMPERATURE,
                                         MAX_TOKENS, "auto", on_text=so_far, cancel=cancel)
            q.put(("result", {"text": out["text"], "tool_calls": [_call(t, req.notebook) for t in out["tool_calls"]], "message": out["message"], "model": LABEL}))
        except pipeline_ai.StreamCancelled:
            q.put(("result", {"cancelled": True}))
        except Exception as e:  # noqa: BLE001 - the page shows it, the conversation goes on
            log.warning("assistant turn in %s failed: %s", wid, e)
            q.put(("result", {"error": f"{LABEL} did not answer: {str(e)[:400]}"}))

    # the request's context (the signed-in user, its audit record) goes along to the worker thread
    threading.Thread(target=contextvars.copy_context().run, args=(work,), daemon=True, name=f"assist-{wid}").start()

    async def events() -> Any:
        try:
            while True:
                try:
                    kind, payload = q.get_nowait()
                except queue.Empty:
                    if await request.is_disconnected():
                        return
                    await asyncio.sleep(0.05)
                    continue
                # one line per event: JavaScript's "." does not match U+2028 / U+2029, which JSON leaves unescaped
                data = json.dumps(payload, ensure_ascii=False, default=str).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
                yield f"event: {kind}\ndata: {data}\n\n"
                if kind == "result":
                    return
        finally:
            # the page stopped or went away: the model stops writing
            cancel.set()

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
