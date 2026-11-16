"""Direct runner harness for Python transforms: run(files, spec, inputs={name: DataFrame}, folders={name: {file: bytes}}) -> result dict.

Example: run({"src/myproject/t.py": code}, {"mode": "preview", "transform": "src/myproject/t.py::compute"}, {"src": df})
mode is list | test | preview | build (see api/code_runner.py for the spec fields)."""
import json, subprocess, sys, tempfile
from pathlib import Path

API = Path(__file__).resolve().parents[2] / "api"
# run this with the project venv (.venv/Scripts/python.exe on Windows): the runner uses the same interpreter
PY = sys.executable


def run(files, spec, inputs=None, folders=None, keep=False):
    tmp = Path(tempfile.mkdtemp(prefix="rt-"))
    for p, c in files.items():
        f = tmp / "repo" / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(c, "utf-8")
    ins = {}
    for k, df in (inputs or {}).items():
        d = tmp / "inputs"
        d.mkdir(exist_ok=True)
        df.to_parquet(d / f"{k}.parquet", index=False)
        ins[k] = str(d / f"{k}.parquet")
    media = {}
    for k, items in (folders or {}).items():
        d = tmp / "media" / k
        d.mkdir(parents=True)
        lst = []
        for i, (name, data) in enumerate(items.items()):
            (d / str(i)).write_bytes(data)
            lst.append({"id": f"{i:016x}", "path": name, "file": str(d / str(i)), "size": len(data), "content_type": None, "updated_at": "1", "folder_id": "f" * 16})
        media[k] = {"items": lst}
    spec = {"repo": str(tmp / "repo"), "inputs": ins, "media_inputs": media, "out": str(tmp / "out.parquet"), "media_out": str(tmp / "media-out"), **spec}
    (tmp / "spec.json").write_text(json.dumps(spec), "utf-8")
    p = subprocess.run([PY, str(API / "code_runner.py"), str(tmp / "spec.json")], capture_output=True, text=True, cwd=str(tmp), encoding="utf-8", errors="replace")
    res = json.loads((tmp / "result.json").read_text("utf-8")) if (tmp / "result.json").exists() else {"ok": False, "error": p.stderr[-3000:]}
    res["_dir"] = str(tmp)
    return res
