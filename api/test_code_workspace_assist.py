"""The JupyterLab assistant's pieces that need no model: the bridge put in JupyterLab's page, the notebook as the model
reads it, tool calls repaired, the conversation as chat_tools takes it."""

import json

import pytest
from fastapi import HTTPException

import code_workspace_assist as A

PAGE = """<!doctype html><html><head><title>JupyterLab</title>
<script id="jupyter-config-data" type="application/json">{"baseUrl": "/api/code-workspaces/w1/jupyterlab/", "appName": "JupyterLab", "note": "a </script-free value"}</script>
</head><body><script src="static/main.js"></script></body></html>"""


def test_bridge_goes_into_the_page_with_the_app_exposed():
    out = A.with_bridge(PAGE, ["http://localhost:8888", "http://*:8888"])
    config = json.loads(A._CONFIG.search(out).group(2))
    assert config["exposeAppInBrowser"] is True and config["baseUrl"] == "/api/code-workspaces/w1/jupyterlab/"
    assert out.index('id="bluesandai-assist-bridge"') < out.index("</body>")
    assert 'var ORIGINS = ["http://localhost:8888", "http://*:8888"];' in out
    # the script cannot end its own tag early
    assert A.BRIDGE.read_text("utf-8").count("</script") == 0


def test_a_page_without_jupyterlab_config_is_left_alone():
    page = "<html><body>not JupyterLab</body></html>"
    assert A.with_bridge(page, ["http://localhost:8888"]) == page


def _nb(cells, active="c1", **kw):
    return {"kind": "notebook", "path": "x.ipynb", "language": "python", "kernel": "Python 3", "kernel_status": "idle", "active_cell_id": active, "cells": cells, **kw}


def test_notebook_context_lists_cells_with_ids_outputs_and_errors():
    text = A.notebook_context(_nb([
        {"cell_id": "c1", "n": 1, "type": "markdown", "source": "# Judul", "outputs": []},
        {"cell_id": "c2", "n": 2, "type": "code", "source": "1/0", "execution_count": 4,
         "outputs": [{"kind": "stream", "name": "stdout", "text": "hai"}, {"kind": "error", "ename": "ZeroDivisionError", "evalue": "division by zero", "traceback": "tb"}]},
    ], selection="1/0", dirty=True))
    assert "x.ipynb · 2 cells · kernel Python 3 (idle) · unsaved changes" in text
    assert "Active cell (the user's cursor): cell 1, cell_id c1" in text
    assert "## Cell 2 · code · cell_id c2 · [4]" in text and "[stdout] hai" in text and "Error: ZeroDivisionError: division by zero\ntb" in text
    assert "Text the user selected in the active cell:\n```python\n1/0\n```" in text


def test_a_long_notebook_keeps_the_cursor_and_errors_whole():
    cells = [{"cell_id": f"c{i}", "n": i, "type": "code", "source": "\n".join(f"x{i}_{k} = {k}" for k in range(200)),
              "outputs": [{"kind": "result", "text": "y" * 500}]} for i in range(1, 31)]
    cells[2]["outputs"].append({"kind": "error", "ename": "KeyError", "evalue": "'a'", "traceback": "tb3"})
    text = A.notebook_context(_nb(cells, active="c20"), budget=60_000)
    assert len(text) < 80_000
    assert "x20_199 = 199" in text and "x3_199 = 199" in text  # the active cell and the failing one, whole
    assert "x10_199" not in text and "Error: KeyError: 'a'" in text  # far cells in brief


def test_nothing_open_says_so():
    assert "No notebook is open in front (the user has 'README.md' open)" in A.notebook_context({"kind": "other", "title": "README.md"})


def test_tool_calls_are_repaired():
    raw = A._call({"id": "1", "name": "edit_cell", "args": None, "raw_args": '{"cell_id": "c2", "content": "x = 1"}</｜DSML｜parameter>'})
    assert raw["args"] == {"cell_id": "c2", "content": "x = 1"} and raw["change"] is True
    tail = A._call({"id": "2", "name": "add_cell", "args": {"content": "print(1)</｜DSML｜parameter>"}, "raw_args": ""})
    assert tail["args"]["content"] == "print(1)"
    assert A._call({"id": "3", "name": "read_notebook", "args": {}, "raw_args": ""})["change"] is False
    bad = A._call({"id": "4", "name": "edit_cell", "args": None, "raw_args": "{not json"})
    assert bad["args"] is None and bad["args_error"]
    # raw newlines in a string (not strict JSON) and two markup tags after the object
    loose = A._call({"id": "5", "name": "create_notebook", "args": None,
                     "raw_args": '{"name": "a.ipynb", "cells": [{"cell_type": "code", "content": "x = 1\ny = 2"}]}</｜DSML｜parameter></｜DSML｜invoke>'})
    assert loose["args"]["cells"][0]["content"] == "x = 1\ny = 2"


def test_a_call_with_unreadable_arguments_goes_back_as_valid_json():
    turn = {"role": "assistant", "text": "", "tool_calls": [{"id": "t1", "name": "create_notebook", "raw_args": '{"name": "a", "cells": [', "args": None}],
            "native": {"openai": {"role": "assistant", "content": None, "tool_calls": [
                {"id": "t1", "type": "function", "function": {"name": "create_notebook", "arguments": '{"name": "a", "cells": ['}},
                {"id": "t2", "type": "function", "function": {"name": "read_notebook", "arguments": "{}"}}]}}}
    sent = A._sendable(turn)
    args = [tc["function"]["arguments"] for tc in sent["native"]["openai"]["tool_calls"]]
    assert args == ["{}", "{}"] and sent["tool_calls"][0]["raw_args"] == "{}"
    assert turn["native"]["openai"]["tool_calls"][0]["function"]["arguments"].endswith("[")  # the page's copy is untouched


def test_the_notebook_goes_with_the_latest_user_message():
    msgs = A._messages([
        {"role": "user", "text": "first"},
        {"role": "assistant", "text": "", "tool_calls": [{"id": "t1", "name": "read_notebook"}], "native": {"openai": {"role": "assistant"}}},
        {"role": "tool", "id": "t1", "name": "read_notebook", "result": {"cells": ["z" * 50_000]}},
        {"role": "user", "text": "second"},
    ], "CONTEXT")
    assert msgs[0]["text"] == "first" and msgs[-1]["text"] == "second\n\n---\nCONTEXT"
    assert msgs[1]["native"] == {"openai": {"role": "assistant"}}
    assert msgs[2]["result"]["cut"] is True and len(json.dumps(msgs[2]["result"])) < A.TOOL_RESULT_MAX + 500
    with pytest.raises(HTTPException):
        A._messages([{"role": "assistant", "text": "hi"}], "CONTEXT")


def test_every_change_tool_waits_and_reads_do_not():
    names = {t["name"] for t in A.TOOLS}
    assert A.CHANGES <= names
    assert names - A.CHANGES == {"read_notebook", "read_cell", "list_files", "read_file", "inspect_data"}


def test_inspect_data_reads_columns_rows_and_first_rows(tmp_path):
    import duckdb

    f = tmp_path / "klaim.parquet"
    duckdb.sql("SELECT range AS id, 'RS ' || range AS faskes, range * 1.5 AS biaya FROM range(12)").write_parquet(str(f))
    out = A.inspect(f, "data/klaim.parquet")
    assert out["rows"] == 12 and [c["name"] for c in out["columns"]] == ["id", "faskes", "biaya"]
    assert len(out["first_rows"]) == A.SAMPLE_ROWS and out["first_rows"][1] == {"id": "1", "faskes": "RS 1", "biaya": "1.5"}
    with pytest.raises(HTTPException):
        A.inspect(tmp_path / "missing.parquet", "data/missing.parquet")
    (tmp_path / "x.xlsx").write_bytes(b"PK")
    with pytest.raises(HTTPException):
        A.inspect(tmp_path / "x.xlsx", "x.xlsx")


def test_code_that_cannot_compile_is_sent_back():
    # the mistake DeepSeek made on 2026-10-27: a SQL comment after the Python line that closes the query
    bad = 'df = con.execute(f"""\n    SELECT 1  -- one\n""").df()   -- the result\ndf'
    assert A.syntax_error(bad).startswith("line 3")
    assert A.syntax_error('%pip install -q matplotlib\n!ls data\nimport duckdb\nawait asyncio.sleep(0)\nx = 1  # ok') is None
    assert A.syntax_error("%%bash\necho $((1 +") is None  # another language
    nb = {"kind": "notebook", "language": "python", "cells": [{"cell_id": "c1", "type": "code"}, {"cell_id": "m1", "type": "markdown"}]}
    assert A._call({"id": "1", "name": "edit_cell", "args": {"cell_id": "c1", "content": bad}, "raw_args": ""}, nb)["syntax_error"].startswith("line 3")
    assert "syntax_error" not in A._call({"id": "2", "name": "edit_cell", "args": {"cell_id": "m1", "content": "# Judul (("}, "raw_args": ""}, nb)
    created = A._call({"id": "3", "name": "create_notebook", "args": {"name": "x", "cells": [
        {"cell_type": "markdown", "content": "# ok"}, {"cell_type": "code", "content": "x = 1"}, {"cell_type": "code", "content": "def f(:\n  pass"}]}, "raw_args": ""}, nb)
    assert created["syntax_error"].startswith("cell 3: line 1")
    assert "syntax_error" not in A._call({"id": "4", "name": "add_cell", "args": {"content": "y = (1 +"}, "raw_args": ""}, {**nb, "language": "r"})
