"""Model Studio (palantir.com/docs/foundry/model-studio): no-code training jobs that produce models.

A model studio has a trainer (regression, classification, time series forecasting), an output model (a model resource
trained here, model_assets.py, created with the studio) and configuration versions (inputs: training dataset, column
mapping, ignored columns, filters, an optional test dataset; trainer parameters; compute resources; a name and
changelog). A training run is a job in its own process (`python model_studio.py job.json`, trainers in
bluesandai_model_studio.py) running the latest configuration; it publishes a new version of the output model with an
experiment (parameters, validation metrics, the leaderboard of the candidate models). Runs are listed with their
configuration version, status and logs.

The trainers are numpy implementations (ridge / softmax regression, k-nearest neighbours, gradient-boosted trees;
naive / seasonal / drift / Holt forecasters), not AutoGluon. Resources are recorded; a run's memory is not limited.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
router = APIRouter(prefix="/api/model-studio", tags=["model-studio"])
DIR = Path("data/model-studio")
_lock = threading.RLock()
TRAINERS = {
    "regression": {"name": "Regression", "description": "Predicts a continuous numeric value from the input features.",
                   "metrics": ["root_mean_squared_error", "mean_absolute_error", "r2"], "models": ["LR", "KNN", "GBM"]},
    "classification": {"name": "Classification", "description": "Assigns each row one of the classes seen in the target column.",
                       "metrics": ["accuracy", "balanced_accuracy", "f1", "roc_auc", "log_loss"], "models": ["LR", "KNN", "GBM"]},
    "time_series": {"name": "Time series forecasting", "description": "Predicts the next values of each series from its history.",
                    "metrics": ["mean_absolute_error"], "models": ["naive", "seasonal_naive", "drift", "holt"]},
}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "model-studio"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    import auth

    return (auth.current() or {}).get("id") or "system"


def _path(sid: str) -> Path:
    if not re.fullmatch(r"ms-[0-9a-f]{12}", sid):
        raise HTTPException(404, "model studio not found")
    return DIR / f"{sid}.json"


def _read(sid: str) -> dict:
    p = _path(sid)
    if not p.exists():
        raise HTTPException(404, "model studio not found")
    return json.loads(p.read_text("utf-8"))


def _write(rec: dict) -> dict:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = _path(rec["id"]).with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(rec, indent=1, default=str), "utf-8")
    os.replace(tmp, _path(rec["id"]))
    return rec


def _get(sid: str, need: str = "viewer") -> dict:
    """A studio, when the caller has `need` on its output model (which governs it)."""
    import model_assets

    rec = _read(sid)
    model_assets._get(rec["model_id"], need=need)
    return rec


# ------------------------------------------------------------------------------------------------
# studios and configurations
# ------------------------------------------------------------------------------------------------


class StudioIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    trainer: Literal["regression", "classification", "time_series"]
    folder_id: str
    model_name: str = Field(min_length=1, max_length=120)


class FilterIn(BaseModel):
    column: str
    op: Literal["==", "!=", ">", ">=", "<", "<=", "is_null", "not_null", "in"]
    value: Any = None


class ConfigIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    changelog: str = Field(default="", max_length=2000)
    training_dataset_id: str
    test_dataset_id: Optional[str] = None
    target: str = Field(min_length=1)
    # tabular trainers: the feature columns (default: every other column not ignored)
    features: list[str] = Field(default_factory=list)
    ignored: list[str] = Field(default_factory=list)
    # time series: the timestamp and the series id columns
    timestamp: Optional[str] = None
    item_id: Optional[str] = None
    filters: list[FilterIn] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)
    cpu: float = Field(2, gt=0, le=8)
    memory_gb: float = Field(4, gt=0, le=64)


def create_python_model(folder_id: str, name: str, source: dict) -> dict:
    """A new model resource trained here: a Files item (type Model) in the folder and its record."""
    import drive
    import model_assets

    folder = drive._item(folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "choose a Project or a folder for the model")
    name = drive._clean_name(name.strip())
    import db

    if any(c["name"] == name and not c.get("trashed_at") for c in db.drive_list(folder_id)):
        raise HTTPException(409, f"{name} already exists in that folder")
    hexid = uuid.uuid4().hex[:12]
    body = json.dumps({"model_id": f"mdl-{hexid}"}).encode()
    item = drive._store(folder_id, name, io.BytesIO(body), len(body), model_assets.MODEL_TYPE)
    rec = {"id": f"mdl-{hexid}", "rid": model_assets.MODEL_RID + hexid, "name": name, "description": "", "kind": "python", "item_id": item["id"],
           "created_at": _now(), "created_by": _me(), "versions": [], "source": source}
    with model_assets._lock:
        model_assets._write(rec)
    return rec


@router.get("/trainers")
def trainers() -> dict:
    """The trainers, each tabular one with its algorithm templates (ml_algorithms.py: settings with defaults and ranges)."""
    import ml_algorithms

    return {k: {**t, **({"algorithms": ml_algorithms.catalog(k)} if k in ("regression", "classification") else {})} for k, t in TRAINERS.items()}


@router.get("")
def list_studios() -> list[dict]:
    out = []
    for p in sorted(DIR.glob("ms-*.json")):
        try:
            rec = _get(p.stem)
        except HTTPException:
            continue
        last = (rec.get("runs") or [None])[0]
        out.append({k: rec[k] for k in ("id", "name", "trainer", "model_id", "created_at")} | {"configs": len(rec.get("configs") or []),
                    "last_run": last and {k: last.get(k) for k in ("status", "started_at", "version")}})
    return sorted(out, key=lambda r: r["created_at"], reverse=True)


@router.post("")
def create_studio(req: StudioIn) -> dict:
    sid = f"ms-{uuid.uuid4().hex[:12]}"
    model = create_python_model(req.folder_id, req.model_name, {"kind": "model_studio", "studio_id": sid, "studio": req.name.strip()})
    rec = {"id": sid, "name": req.name.strip(), "trainer": req.trainer, "model_id": model["id"], "created_at": _now(), "created_by": _me(),
           "configs": [], "runs": []}
    with _lock:
        _write(rec)
    return get_studio(sid)


@router.get("/{sid}")
def get_studio(sid: str) -> dict:
    import model_assets

    rec = _get(sid)
    m, _ = model_assets._get(rec["model_id"])
    stale = False
    if rec.get("runs") and rec["configs"]:
        # the training data changed since the last successful run: the model is out of date
        import db

        ok = next((r for r in rec["runs"] if r["status"] == "succeeded"), None)
        item = db.drive_get(rec["configs"][-1]["training_dataset_id"])
        stale = bool(ok and item and str(item.get("updated_at")) > (ok.get("data_updated_at") or ""))
    return {**rec, "model": {"id": m["id"], "rid": m["rid"], "name": m["name"], "path": model_assets._item_path(m), "versions": len(m.get("versions") or []),
                             "latest": (m.get("versions") or [{}])[-1].get("version")}, "out_of_date": stale}


@router.delete("/{sid}")
def delete_studio(sid: str) -> dict:
    """The studio's record; its model stays in Files."""
    rec = _get(sid, need="editor")
    with _lock:
        _path(rec["id"]).unlink(missing_ok=True)
    return {"deleted": sid}


def _columns(item_id: str) -> list[str]:
    import pyarrow.parquet as pq

    import db
    import drive

    item = db.drive_get(item_id)
    if not item or item.get("trashed_at") or not item["name"].endswith(".parquet"):
        raise HTTPException(400, "choose a dataset")
    drive._item(item_id)
    return [f.name for f in pq.ParquetFile(io.BytesIO(drive.read_bytes(item))).schema_arrow]


@router.put("/{sid}/config")
def save_config(sid: str, req: ConfigIn) -> dict:
    """A new configuration version (training runs always use the latest)."""
    rec = _get(sid, need="editor")
    cols = _columns(req.training_dataset_id)
    if req.test_dataset_id:
        _columns(req.test_dataset_id)
    missing = [c for c in [req.target, *req.features, *(f.column for f in req.filters), req.timestamp, req.item_id] if c and c not in cols]
    if missing:
        raise HTTPException(400, f"not columns of the training dataset: {', '.join(dict.fromkeys(missing))}")
    if rec["trainer"] == "time_series" and not req.timestamp:
        raise HTTPException(400, "the time series trainer needs a timestamp column")
    features = req.features or [c for c in cols if c not in {req.target, req.timestamp, req.item_id, *req.ignored}]
    if rec["trainer"] != "time_series" and not features:
        raise HTTPException(400, "map at least one feature column")
    metric = req.params.get("eval_metric")
    if metric and metric not in TRAINERS[rec["trainer"]]["metrics"]:
        raise HTTPException(400, f"eval_metric is one of {', '.join(TRAINERS[rec['trainer']]['metrics'])}")
    algos = req.params.get("algorithms")
    if algos:
        import ml_algorithms

        if rec["trainer"] == "time_series" or not isinstance(algos, list) or len(algos) > 12:
            raise HTTPException(400, "algorithms: up to 12 candidates, for regression or classification")
        for i, a in enumerate(algos):
            try:
                ml_algorithms.settings(rec["trainer"], (a or {}).get("algorithm"), (a or {}).get("params"))
            except ValueError as e:
                raise HTTPException(400, f"candidate {i + 1}: {e}") from None
    with _lock:
        rec = _read(sid)
        cfg = {**req.model_dump(), "features": [] if rec["trainer"] == "time_series" else features, "version": len(rec["configs"]) + 1,
               "created_at": _now(), "created_by": _me()}
        rec["configs"].append(cfg)
        _write(rec)
    return get_studio(sid)


# ------------------------------------------------------------------------------------------------
# training runs
# ------------------------------------------------------------------------------------------------


def _note_run(sid: str, run_id: str, **changes: Any) -> None:
    with _lock:
        rec = _read(sid)
        for r in rec["runs"]:
            if r["id"] == run_id:
                r.update(changes)
        _write(rec)


# Filter pushdown. A run does not copy the whole training / test dataset to the job: it scans it lazily with polars
# (pl.scan_parquet on the local file or the S3 object), with the configuration's filters as the scan predicate (row
# groups whose statistics cannot match are skipped) and only the columns the trainer needs (target, features,
# timestamp, series id, filter columns). Each pushed predicate keeps at least every row _apply_filters keeps, and the
# job still runs _apply_filters on what was read, so the training rows are row for row the ones of a full read;
# filters that cannot be translated are applied only there. The job also gets back the pandas dtypes a full read gives
# (an integer column with nulls somewhere in the dataset reads as float64, a boolean one as object).
PUSHDOWN = True  # False: copy the whole dataset to the job (the behaviour before pushdown)
# An S3 object up to this size is fetched in one GET and scanned on local disk: scanning it on S3 costs four or five
# round trips (size, footer, the polars footer and the row groups), more than one GET of a small object.
PUSHDOWN_FETCH_BYTES = 32 * 1024 * 1024
PUSHDOWN_HEAD_ROWS = 50_000  # the first rows looked at for a timestamp column's text format, before the whole column
_CMP = {"==": lambda a, b: a == b, "!=": lambda a, b: a != b, ">": lambda a, b: a > b, ">=": lambda a, b: a >= b,
        "<": lambda a, b: a < b, "<=": lambda a, b: a <= b}
_polars_lock = threading.Lock()


def _polars():
    """polars, imported on a thread that never exits. On Windows (polars 2.0), when the thread that first imported
    polars has exited, a later scan_parquet called from another short-lived thread (a run's thread) crashes the
    process with an access violation, about once in a hundred scans; a live importing thread avoids it."""
    if "polars" not in sys.modules:
        with _polars_lock:
            if "polars" not in sys.modules:
                done, failed = threading.Event(), []

                def keep() -> None:
                    try:
                        import polars  # noqa: F401
                    except BaseException as e:  # noqa: BLE001
                        failed.append(e)
                        done.set()
                        return
                    done.set()
                    threading.Event().wait()  # stay alive for the life of the process

                threading.Thread(target=keep, name="polars-import-keeper", daemon=True).start()
                done.wait()
                if failed:
                    raise failed[0]
    import polars

    return polars


def _filter_label(f: dict) -> str:
    return f"{f['column']} {f['op']}" + (f" {f.get('value')}" if f["op"] not in ("is_null", "not_null") else "")


def _any_of(exprs: list):
    """exprs joined by OR: unlike is_in on numbers and dates, equalities joined by OR let the scan skip row groups."""
    pl = _polars()

    out = pl.lit(False)
    for i, e in enumerate(exprs):
        out = e if i == 0 else out | e
    return out


_OR_MAX = 32  # more values than this in an "in" filter: one is_in (rows are still filtered, row groups not skipped)


def _text_need(f: dict) -> int:
    """What the outcome of f on a timestamp column needs to know of the whole column, pandas comparing its text:
    "YYYY-MM-DD" when every value is a midnight, else "YYYY-MM-DD HH:MM:SS" plus the fraction digits the finest value
    needs (years 1000-9999). 0: nothing (the first characters decide, e.g. >= / < a date); 1: whether every value is a
    midnight; 2: the fraction digits too."""
    def eq(n: int) -> int:  # the texts are 10 characters, or 19 and more
        return 0 if n < 10 or 10 < n < 19 else 1 if n == 10 else 2

    op, v = f["op"], f.get("value")
    if op == "in":
        return max((eq(len(str(x))) for x in (v if isinstance(v, list) else str(v).split(","))), default=0)
    n = len(str(v))
    if op in ("==", "!="):
        return eq(n)
    if op in (">=", "<"):  # a text starting with the value is >= it, whatever follows
        return 0 if n <= 10 else 1 if n <= 19 else 2
    return 0 if n < 10 else 1 if n < 19 else 2


def _filter_expr(f: dict, dtype: Any):
    """A polars predicate keeping a superset of the rows _apply_filters keeps for f (pandas semantics: numeric columns
    compare as float, NaN only passes !=; other columns compare as str(value), a null being the string "None" / "nan"),
    or None when f cannot be translated for this column type."""
    import math

    pl = _polars()

    col, op, v = pl.col(f["column"]), f["op"], f.get("value")
    kind = ("int" if dtype.is_integer() else "float" if dtype == pl.Float64 else "float32" if dtype == pl.Float32
            else "str" if dtype == pl.String else "date" if dtype == pl.Date
            else "datetime" if isinstance(dtype, pl.Datetime) and dtype.time_zone is None else None)
    ns = kind == "datetime" and dtype.time_unit == "ns"
    if kind == "int":  # the column type's range: a literal of the column's own type keeps Parquet statistics usable
        bits = {pl.Int8: 8, pl.Int16: 16, pl.Int32: 32, pl.Int64: 64, pl.UInt8: 8, pl.UInt16: 16, pl.UInt32: 32, pl.UInt64: 64}.get(dtype)
        if bits is None:
            return None if op not in ("is_null", "not_null") else col.is_null() if op == "is_null" else col.is_not_null()
        low, high = (0, 2 ** bits - 1) if dtype.is_unsigned_integer() else (-(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
    if op == "is_null":
        return col.is_null() | col.is_nan() if kind in ("float", "float32") else col.is_null()
    if op == "not_null":
        return col.is_not_null()
    if op == "in":
        vals = [str(x) for x in (v if isinstance(v, list) else str(v).split(","))]
        if kind == "str":
            return col.is_in(vals) | col.is_null()
        if kind == "int":  # pandas compares str(int) ("5"), or str(float) ("5.0") when the column has nulls
            ints = []
            for x in vals:
                if re.fullmatch(r"[+-]?\d+", x):
                    n = int(x)
                else:
                    try:
                        fx = float(x)
                    except ValueError:
                        continue
                    if fx != fx or fx in (float("inf"), float("-inf")) or fx != int(fx):
                        continue
                    if abs(fx) >= 2 ** 53:  # str(float) of a big integer no longer names one integer
                        return None
                    n = int(fx)
                if low <= n <= high:  # no other integer is in the column
                    ints.append(n)
            ints = sorted(set(ints))
            if len(ints) <= _OR_MAX:
                return _any_of([col == pl.lit(n, dtype=dtype) for n in ints]) | col.is_null()
            return col.is_in(pl.Series(values=ints, dtype=dtype).implode()) | col.is_null()
        if kind == "float":  # str(np.float64) round-trips: a row matches only a value with the same float
            floats = set()
            for x in vals:
                try:
                    floats.add(float(x))
                except ValueError:
                    pass
            nan = any(x != x for x in floats)  # "nan": the text of a NaN and of a null
            floats = sorted(x for x in floats if x == x)
            e = _any_of([col == pl.lit(x) for x in floats]) if len(floats) <= _OR_MAX else col.is_in(floats)
            return e | col.is_null() | col.is_nan() if nan else e
        if kind in ("date", "datetime"):
            return _date_expr(col, op, vals, kind, ns)
        return None
    if kind in ("date", "datetime"):
        return _date_expr(col, op, str(v), kind, ns)
    if kind in ("int", "float"):
        try:
            val = float(v)
        except (TypeError, ValueError):
            return None  # the job fails on it, as before
        if kind == "int" and abs(val) < 2 ** 53:
            # pandas compares float(x) with val, and for a bound this small that is x against the integers around
            # it; an integer literal of the column's type keeps the comparison on the column (a float one casts the
            # column, and Parquet statistics then skip nothing)
            lo, whole = math.floor(val), val == math.floor(val)

            def lit(n: int):  # of the column's type when n fits it
                return pl.lit(n, dtype=dtype) if low <= n <= high else pl.lit(n)

            if op in ("==", "!="):
                if whole:
                    e = _CMP[op](col, lit(lo))
                    return e | col.is_null() if op == "!=" else e
            else:
                n = {">": lo + 1, ">=": lo if whole else lo + 1, "<": lo - 1 if whole else lo, "<=": lo}[op]
                return (col >= lit(n)) if op in (">", ">=") else (col <= lit(n))
        if kind == "float" and op in (">", ">="):
            # polars orders NaN above every number (pandas: NaN passes no comparison): a plain > keeps NaN rows and
            # skips no row group; is_between with an infinite upper bound leaves NaN out and uses the statistics
            return col.is_between(pl.lit(val), pl.lit(float("inf")), closed="right" if op == ">" else "both")
        e = _CMP[op](col, pl.lit(val))
        if op == "!=":  # pandas: a null or NaN row differs from every value, NaN included (polars has NaN == NaN)
            e = e | col.is_null()
            if kind == "float":
                e = e | col.is_nan()
        return e
    if kind == "str":
        return _CMP[op](col, pl.lit(str(v))) | col.is_null()
    return None  # bool, float32, decimals, zoned timestamps…: pandas compares them in ways not worth mirroring


def _date_expr(col: Any, op: str, v: Any, kind: str, ns: bool = False):
    """The predicate for a date / naive timestamp column. pandas compares str(value): "YYYY-MM-DD" for a date, and for
    a timestamp the date followed by nothing, " HH:MM:SS" or " HH:MM:SS.fff…" depending on the whole column. Whatever
    follows, a row passing x op v has a date part d (10 characters for years 1000-9999, which sort like the dates) with
    d >= v[:10] for > / >=, d <= v[:10] for < / <=, d == v[:10] for == and d in {w[:10]} for in. When v[:10] is a
    date the bound is put on the column itself (Parquet statistics skip row groups), else on its formatted date part.
    Rows outside years 1000-9999 and nulls ("None" / "NaT") are always kept; != keeps every row (not pushed)."""
    import datetime as dt

    pl = _polars()

    def day(s: str):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
            return None
        try:
            d = dt.date.fromisoformat(s)
        except ValueError:
            return None
        return d if (1678 <= d.year <= 2261 if ns else d.year >= 1000) else None  # the literal fits the column

    def at(d):  # the first instant of day d, as a literal of the column's type
        return pl.lit(d) if kind == "date" else pl.lit(dt.datetime(d.year, d.month, d.day))

    keep = col.is_null()
    if not ns:  # a nanosecond timestamp only holds years 1677-2262
        keep = keep | (col < at(dt.date(1000, 1, 1))) | (col > (pl.lit(dt.date(9999, 12, 31)) if kind == "date" else pl.lit(dt.datetime.max)))
    part = col.dt.strftime("%Y-%m-%d")
    if op == "in":
        keys = {w[:10] for w in v if len(w) >= 10}
        days = [day(k) for k in keys]
        if all(days) and len(days) <= _OR_MAX:
            return _any_of([col == at(d) if kind == "date" else (col >= at(d)) & (col < at(d + dt.timedelta(days=1))) if d < dt.date(9999, 12, 31) else col >= at(d)
                            for d in sorted(days)]) | keep
        if all(days):
            return (col.is_in(days) if kind == "date" else col.dt.date().is_in(days)) | keep
        return part.is_in(sorted(keys)) | keep
    if op == "!=":
        return None
    w = v[:10]
    if op == "==" and len(v) < 10:
        return keep  # no date part can equal it
    d = day(w)
    if d is None:
        e = part == w if op == "==" else part >= w if op in (">", ">=") else part <= w
        return e | keep
    nxt = d + dt.timedelta(days=1) if d < dt.date(9999, 12, 31) else None
    if op in (">", ">="):
        return (col >= at(d)) | keep
    if op in ("<", "<="):
        return ((col < at(nxt)) if nxt else pl.lit(True)) | keep
    return ((col >= at(d)) & (col < at(nxt)) if nxt else col >= at(d)) | keep


class _S3Range(io.RawIOBase):
    """A seekable read-only view of an S3 object by ranged GETs (pyarrow reads only the Parquet footer through it)."""

    def __init__(self, key: str) -> None:
        import storage

        self.key, self.pos = key, 0
        self.size = storage._s3().head_object(Bucket=storage._bucket(), Key=key)["ContentLength"]

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        self.pos = {0: 0, 1: self.pos, 2: self.size}[whence] + offset
        return self.pos

    def readinto(self, b) -> int:
        import storage

        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        data = storage._s3().get_object(Bucket=storage._bucket(), Key=self.key, Range=f"bytes={self.pos}-{self.pos + n - 1}")["Body"].read()
        b[:len(data)] = data
        self.pos += len(data)
        return len(data)


def _read_pushdown(item: dict, cfg: dict, dest: Path) -> Optional[dict]:
    """Write the needed columns of the rows of a drive Parquet item that can pass the filters to dest (the source's
    Arrow types and pandas metadata, no index); None when this dataset has to be copied whole (dest may then already
    hold the whole copy)."""
    import pyarrow.parquet as pq

    import auth
    import drive
    import storage

    auth.check_item(item)
    fetched = None
    if item.get("stored_in") == "s3" and int(item.get("size_bytes") or 0) <= PUSHDOWN_FETCH_BYTES:
        fetched = dest.with_suffix(".source.parquet")
        fetched.write_bytes(drive.read_bytes(item))
    if fetched is not None:
        src, opts, how = str(fetched), None, "whole object fetched, scanned locally"
        pf = pq.ParquetFile(src)
    elif item.get("stored_in") == "s3":
        src, opts = f"s3://{storage._bucket()}/drive/{item['id']}", {"aws_access_key_id": storage._settings["AWS_ACCESS_KEY_ID"],
                                                                     "aws_secret_access_key": storage._settings["AWS_SECRET_ACCESS_KEY"],
                                                                     "aws_region": storage._settings["AWS_REGION"]}
        how = "scanned on S3"
        pf = pq.ParquetFile(_S3Range(f"drive/{item['id']}"))
    else:
        src, opts, how = str((drive.LOCAL_DIR / item["id"]).resolve()), None, "scanned on local disk"
        pf = pq.ParquetFile(src)
    try:
        info = _scan_pushdown(pf, src, opts, cfg, dest)
        if info is None and fetched is not None:
            pf.close()
            fetched.replace(dest)  # the whole copy the job needs is already here
        elif info is not None:
            info.update(bytes_total=int(item.get("size_bytes") or 0), source=how)
        return info
    finally:
        pf.close()
        if fetched is not None:
            fetched.unlink(missing_ok=True)


def _years_1000_9999(pf: Any, name: str) -> bool:
    """Every value of a timestamp column is in the years 1000-9999 (its text then starts with a 10-character date),
    by the row groups' statistics; False when they do not say."""
    try:
        for i in range(pf.metadata.num_row_groups):
            rg = pf.metadata.row_group(i)
            st = next((rg.column(j).statistics for j in range(rg.num_columns) if rg.column(j).path_in_schema == name), None)
            if st is None or not st.has_min_max:
                if st is not None and st.has_null_count and st.null_count == rg.num_rows:
                    continue  # a row group of nulls
                return False
            if not (1000 <= st.min.year and st.max.year <= 9999):
                return False
        return True
    except Exception:  # noqa: BLE001  (statistics outside what Python dates hold)
        return False


def _scan_pushdown(pf: Any, src: str, opts: Optional[dict], cfg: dict, dest: Path) -> Optional[dict]:
    import numpy as np
    pl = _polars()
    import pyarrow as pa
    import pyarrow.parquet as pq

    schema, filters = pf.schema_arrow, cfg.get("filters") or []
    wanted = {c for c in [cfg["target"], *(cfg.get("features") or []), cfg.get("timestamp"), cfg.get("item_id"), *(f["column"] for f in filters)] if c}
    names = schema.names
    if len(set(names)) != len(names) or wanted - set(names):
        return None  # a missing column: the job reports it as before
    needed = [n for n in names if n in wanted]
    md = schema.pandas_metadata
    if md:
        index_cols = {x for x in md.get("index_columns") or [] if isinstance(x, str)}
        if index_cols & wanted or any(c.get("field_name") in wanted and c.get("name") != c.get("field_name") for c in md.get("columns") or []):
            return None  # an index or a non-string column name pandas would restore
        md = {**md, "index_columns": [], "columns": [c for c in md.get("columns") or [] if c.get("field_name") in wanted]}
    if any(pa.types.is_dictionary(schema.field(n).type) for n in needed):
        return None  # categoricals: their categories depend on the rows read
    meta = dict(schema.metadata or {})
    if md:
        meta[b"pandas"] = json.dumps(md).encode()
    target = pa.schema([schema.field(n) for n in needed], metadata=meta or None)
    # the dtypes of a full read: an integer column with a null anywhere reads as float64, a boolean one as object
    empty = target.empty_table().to_pandas()
    promote, unknown, nulls = {}, [], {}
    for n in needed:
        dt = empty[n].dtype
        if isinstance(dt, np.dtype) and dt.kind in "iub":
            count = 0
            for i in range(pf.metadata.num_row_groups):
                rg = pf.metadata.row_group(i)
                chunk = next((rg.column(j) for j in range(rg.num_columns) if rg.column(j).path_in_schema == n), None)
                st = chunk.statistics if chunk is not None else None
                if st is None or not st.has_null_count:
                    count = None
                    break
                count += st.null_count
            if count is None:
                unknown.append(n)
            else:
                nulls[n] = count
    lf = pl.scan_parquet(src, storage_options=opts) if opts else pl.scan_parquet(src)
    if unknown:
        nulls.update(lf.select([pl.col(n).null_count() for n in unknown]).collect().row(0, named=True))
    for n, count in nulls.items():
        if count:
            promote[n] = "object" if empty[n].dtype.kind == "b" else "float64"
    pl_schema = lf.collect_schema()
    # pandas writes a naive timestamp / a duration column as text in one format for all the rows it holds (date only
    # when every value is a midnight, else with the time, with as many fraction digits as the finest value needs), and
    # the filters other than is_null / not_null compare that text, each on the rows the filters before it kept. Where
    # the outcome of a filter depends on that format (_text_need), reading fewer rows could change it:
    # - as the first filter on a timestamp column, it is pushed and the job gets one value of the dataset (witness)
    #   that makes pandas write the rows read the way it writes the whole column: looked for in the first rows, then
    #   in the whole column (that column only);
    # - anywhere else (and on a duration column), neither it nor the filters after it are pushed: the scan then
    #   returns every row the filters before it keep, which is what it is applied to in a whole read.
    pushed, kept = [], []
    pred, witness, stop = None, None, False
    for i, f in enumerate(filters):
        n, tp = f["column"], empty[f["column"]].dtype
        need = 0
        if f["op"] not in ("is_null", "not_null") and not stop:
            if getattr(tp, "kind", "") == "m":
                need = 3
            elif getattr(tp, "kind", "") == "M" and getattr(tp, "tz", None) is None and isinstance(pl_schema[n], pl.Datetime):
                need = _text_need(f) if _years_1000_9999(pf, n) else 2
        if need and (i or need == 3):
            stop = True
        elif need:
            unit = pl_schema[n].time_unit
            ph, per = pl.col(n).to_physical(), {"ms": 10 ** 3, "us": 10 ** 6, "ns": 10 ** 9}[unit]
            cls = (ph % (86400 * per) != 0).cast(pl.Int8) + (ph % per != 0).cast(pl.Int8)  # 0 midnight, 1 whole second
            for sub in (10 ** 3, 10 ** 6):  # 2 milliseconds, 3 microseconds, 4 nanoseconds
                if per >= sub * 10 ** 3:
                    cls = cls + (ph % (per // sub) != 0).cast(pl.Int8)
            enough = 1 if need == 1 else {"ms": 2, "us": 3, "ns": 4}[unit]
            for part in (lf.select(n).head(PUSHDOWN_HEAD_ROWS), lf):
                got = part.select(ph.filter(cls == cls.max()).first().alias("value"), cls.max().alias("class")).collect().row(0, named=True)
                if got["value"] is not None and (part is lf or got["class"] >= enough):
                    witness = [got["value"], unit]
                    break
        e = None if stop else _filter_expr(f, pl_schema[n])
        (pushed if e is not None else kept).append(_filter_label(f))
        if e is not None:
            pred = e if pred is None else pred & e
    scan = (lf.filter(pred) if pred is not None else lf).select(needed)
    raw = dest.with_suffix(".scan.parquet")
    scan.sink_parquet(raw)
    rows = 0
    with pq.ParquetWriter(dest, target) as w:
        got = pq.ParquetFile(raw)
        for batch in got.iter_batches(batch_size=65536):
            t = pa.Table.from_batches([batch]).cast(target)
            rows += t.num_rows
            w.write_table(t)
        got.close()
    raw.unlink(missing_ok=True)
    # the compressed bytes of the needed columns in the file: at most this much column data is read (less when the
    # pushed filters let the scan skip row groups)
    cols = 0
    for i in range(pf.metadata.num_row_groups):
        rg = pf.metadata.row_group(i)
        cols += sum(rg.column(j).total_compressed_size for j in range(rg.num_columns) if rg.column(j).path_in_schema in wanted)
    return {"rows_total": pf.metadata.num_rows, "rows_read": rows, "columns_read": needed, "columns_total": len(names),
            "bytes_columns": int(cols), "filters_pushed": pushed, "filters_after_read": kept, "promote": promote, "witness": witness}


def _run(sid: str, run_id: str) -> None:
    import db
    import drive
    import model_assets

    rec = _read(sid)
    cfg = rec["configs"][-1]
    started = time.monotonic()
    tmp = Path(tempfile.mkdtemp(prefix="model-studio-"))
    files, reads, notes, sizes = {}, {}, [], {}
    try:
        for key in ("training_dataset_id", "test_dataset_id"):
            if cfg.get(key):
                item = db.drive_get(cfg[key])
                if not item or item.get("trashed_at"):
                    raise ValueError(f"the {key.split('_')[0]} dataset no longer exists")
                dest, what = tmp / f"{key}.parquet", key.split("_")[0]
                info = None
                if PUSHDOWN:
                    try:
                        info = _read_pushdown(item, cfg, dest)
                    except HTTPException:
                        raise
                    except Exception as e:  # noqa: BLE001
                        notes.append(f"{what} dataset: filter pushdown unavailable ({type(e).__name__}: {str(e)[:200]}), read whole")
                        dest.unlink(missing_ok=True)
                if info:
                    reads[key] = info
                    notes.append(f"{what} dataset ({info['source']}): read {info['rows_read']} of {info['rows_total']} rows, {len(info['columns_read'])} of "
                                 f"{info['columns_total']} columns; filters pushed to the scan: {', '.join(info['filters_pushed']) or 'none'}"
                                 + (f"; applied after the read: {', '.join(info['filters_after_read'])}" if info["filters_after_read"] else ""))
                elif not dest.exists():
                    dest.write_bytes(drive.read_bytes(item))
                files[key], sizes[key] = str(dest), int(item.get("size_bytes") or 0)
        train_item = db.drive_get(cfg["training_dataset_id"])
        job = {"trainer": rec["trainer"], "config": cfg, "files": files, "stage": str(tmp / "stage"), "studio": rec["name"], "run_id": run_id,
               "promote": {k: v["promote"] for k, v in reads.items()}, "witness": {k: v["witness"] for k, v in reads.items() if v["witness"]}}
        (tmp / "job.json").write_text(json.dumps(job, default=str), "utf-8")
        env = {k: v for k, v in os.environ.items() if not re.search(r"KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL", k)}
        env["PYTHONUTF8"] = "1"
        p = subprocess.run([sys.executable, str(HERE / "model_studio.py"), str(tmp / "job.json")], cwd=str(HERE), capture_output=True, timeout=3600, env=env)
        out = tmp / "result.json"
        res = json.loads(out.read_text("utf-8")) if out.exists() else {"ok": False, "error": (p.stderr or p.stdout).decode(errors="replace")[-3000:]}
        if not res.get("ok"):
            raise ValueError(res.get("error") or "the training job failed")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted((tmp / "stage").rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(tmp / "stage").as_posix())
        code = None
        if (tmp / "code_manifest.json").exists():
            import code_provenance

            code = code_provenance.summary(code_provenance.store(run_id, json.loads((tmp / "code_manifest.json").read_bytes())))
        m, _ = model_assets._get(rec["model_id"])
        names = {cfg["training_dataset_id"]: train_item["name"]}
        if cfg.get("test_dataset_id"):
            names[cfg["test_dataset_id"]] = (db.drive_get(cfg["test_dataset_id"]) or {}).get("name", "")
        v = model_assets.add_version(m, buf.getvalue(), "master",
                                     {"kind": "model_studio", "studio_id": sid, "repo": rec["name"], "transform": f"training run · configuration {cfg['version']} ({cfg['name']})",
                                      "build": run_id, "branch": "master"},
                                     [{"item_id": k, "name": n} for k, n in names.items()], code=code)
        # what the run read of each dataset and what the filters kept (the job counts its frames before / after them)
        data_read = {}
        for key in files:
            got = (res.get("rows") or {}).get(key) or {}
            if key in reads:
                d = {x: y for x, y in reads[key].items() if x not in ("promote", "witness")}
            elif got:
                d = {"rows_total": got["read"], "rows_read": got["read"], "columns_read": got["columns"], "columns_total": len(got["columns"]), "filters_pushed": [],
                     "filters_after_read": [_filter_label(f) for f in cfg.get("filters") or []], "bytes_total": sizes.get(key, 0), "source": "copied whole"}
            else:
                continue
            if got:
                d["rows_kept"] = got["kept"]
            data_read[key.split("_")[0]] = d
        _note_run(sid, run_id, status="succeeded", version=v["version"], version_id=v["id"], experiment_id=v.get("experiment_id"),
                  logs="\n".join([*notes, res.get("logs", "")]), metrics=res.get("metrics"), best_model=res.get("best"),
                  data_updated_at=str(train_item.get("updated_at")), data_read=data_read, ms=int((time.monotonic() - started) * 1000), code=code)
    except Exception as e:  # noqa: BLE001
        # a failed run still records the scans it made (no rows kept: the job did not report them)
        failed_read = {k.split("_")[0]: {x: y for x, y in r.items() if x not in ("promote", "witness")} for k, r in reads.items()}
        _note_run(sid, run_id, status="failed", error=str(getattr(e, "detail", None) or e)[:3000], ms=int((time.monotonic() - started) * 1000),
                  **({"logs": "\n".join(notes)} if notes else {}), **({"data_read": failed_read} if failed_read else {}))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@router.post("/{sid}/runs")
def start_run(sid: str, wait: bool = False) -> dict:
    """Start a training run with the latest configuration."""
    _get(sid, need="editor")
    return _start(sid, wait, "manual")


def _start(sid: str, wait: bool, trigger: str) -> dict:
    rec = _read(sid)
    if not rec["configs"]:
        raise HTTPException(400, "configure the model studio first")
    if any(r["status"] == "running" for r in rec["runs"]):
        raise HTTPException(409, "a training run is already running")
    cfg = rec["configs"][-1]
    run = {"id": f"run-{uuid.uuid4().hex[:10]}", "status": "running", "started_at": _now(), "started_by": _me(), "config_version": cfg["version"],
           "config_name": cfg["name"], "resources": {"cpu": cfg["cpu"], "memory_gb": cfg["memory_gb"]}, "trigger": trigger}
    with _lock:
        rec = _read(sid)
        rec["runs"] = [run, *rec["runs"]][:100]
        _write(rec)
    if wait:
        _run(sid, run["id"])
    else:
        threading.Thread(target=_run, args=(sid, run["id"]), daemon=True).start()
    return get_studio(sid)


class ScheduleIn(BaseModel):
    retrain_on_update: bool


@router.put("/{sid}/schedule")
def set_schedule(sid: str, req: ScheduleIn) -> dict:
    """Retrain whenever the training dataset gets a new transaction."""
    _get(sid, need="editor")
    with _lock:
        rec = _read(sid)
        rec["retrain_on_update"] = req.retrain_on_update
        _write(rec)
    return get_studio(sid)


def on_dataset_transaction(item_id: str) -> None:
    """dataset_versions: a dataset was written. Studios training on it with retraining on start a run."""
    for p in DIR.glob("ms-*.json"):
        try:
            rec = json.loads(p.read_text("utf-8"))
        except ValueError:
            continue
        cfg = (rec.get("configs") or [None])[-1]
        if rec.get("retrain_on_update") and cfg and cfg["training_dataset_id"] == item_id and not any(r["status"] == "running" for r in rec["runs"]):
            try:
                _start(rec["id"], False, "training data updated")
            except HTTPException:
                pass


# ------------------------------------------------------------------------------------------------
# the job (its own process)
# ------------------------------------------------------------------------------------------------


def _apply_filters(df, filters: list[dict], witness: Optional[list] = None):
    """The rows passing every filter, each applied to the rows the ones before it kept. witness (a pushed-down read
    whose first filter compares a timestamp column as text): one value of that column in the whole dataset, [integer,
    unit], that makes pandas write the rows read as text the way it writes the whole column."""
    import numpy as np
    import pandas as pd

    def text(s, first: bool):
        if not (first and witness) or getattr(s.dtype, "kind", "") != "M":
            return s.astype(str)
        x = pd.Series(np.array([witness[0]], dtype=f"datetime64[{witness[1]}]")).astype(s.dtype)
        out = pd.concat([s, x], ignore_index=True).astype(str).iloc[:-1]
        out.index = s.index
        return out

    for i, f in enumerate(filters):
        c, op, v = f["column"], f["op"], f.get("value")
        s = df[c]
        if op == "is_null":
            df = df[s.isna()]
        elif op == "not_null":
            df = df[s.notna()]
        elif op == "in":
            df = df[text(s, i == 0).isin([str(x) for x in (v if isinstance(v, list) else str(v).split(","))])]
        else:
            num = pd.api.types.is_numeric_dtype(s)
            val = float(v) if num else str(v)
            col = s if num else text(s, i == 0)
            df = df[{"==": col == val, "!=": col != val, ">": col > val, ">=": col >= val, "<": col < val, "<=": col <= val}[op]]
    return df.reset_index(drop=True)


def job(path: str) -> None:
    out_path = Path(path).with_name("result.json")
    logs: list[str] = []
    res: dict = {"ok": False}
    try:
        sys.path.insert(0, str(HERE))
        import code_models

        code_models.install()
        import pandas as pd

        import bluesandai_model_studio as ms
        import eval_report
        import model_lib

        spec = json.loads(Path(path).read_text("utf-8"))
        cfg, params = spec["config"], dict(spec["config"].get("params") or {})
        counts: dict = {}

        def read(key: str):
            # a pushed-down read holds the needed columns of the rows that can pass the filters; give its columns the
            # dtypes of a full read, then filter exactly as on a full read
            d = pd.read_parquet(spec["files"][key])
            for c, dt in ((spec.get("promote") or {}).get(key) or {}).items():
                if str(d[c].dtype) != dt:
                    d[c] = d[c].astype(dt)
            kept = _apply_filters(d, cfg.get("filters") or [], (spec.get("witness") or {}).get(key))
            counts[key] = {"read": len(d), "kept": len(kept), "columns": [str(c) for c in d.columns]}
            return kept

        df = read("training_dataset_id")
        logs.append(f"training rows after filters: {len(df)}")
        test = read("test_dataset_id") if spec["files"].get("test_dataset_id") else None
        if spec["trainer"] == "time_series":
            model, config, report = ms.train_time_series(df, cfg["target"], cfg["timestamp"], cfg.get("item_id"), params, logs.append)
        else:
            model, config, report = ms.train_tabular(spec["trainer"], df, cfg["target"], cfg["features"], params, test, logs.append)
        exp = model_lib.Experiment(f"{spec['studio']} · {cfg['name']}")
        exp.log_params({k: v for k, v in {"trainer": spec["trainer"], "configuration": cfg["version"], "best_model": report["best"],
                                          "eval_metric": config.get("eval_metric") or "mean_absolute_error", "training_rows": len(df), "target": cfg["target"],
                                          **{k: v for k, v in params.items() if isinstance(v, (int, float, str, bool))}}.items()})
        best = report["leaderboard"][0]
        metric = best["eval_metric"]
        exp.log_metric(f"validation/{metric}", abs(best["score_val"]) if metric in ("root_mean_squared_error", "mean_absolute_error", "log_loss") else best["score_val"])
        for i, r in enumerate(report["leaderboard"]):
            exp.log_metric("leaderboard/score_val", r["score_val"], step=i)
        exp.log_table("leaderboard", pd.DataFrame(report["leaderboard"]), "Candidate models, best first (score_val: higher is better)")
        # the validation predictions of the best candidate, drawn by the app (confusion matrix, ROC… or predicted vs
        # actual): the same structured evaluation a training run in a repository logs
        val = report.get("validation")
        if val:
            # every candidate on the same validation rows (the benchmark of the algorithms), the best first and marked
            by_model = val.get("by_model") or {report["best"]: val["out"]}
            for label in sorted(by_model, key=lambda k: k != report["best"]):
                ev = eval_report.for_studio(config["task"], val["y"], by_model[label], config.get("classes"))
                if ev:
                    exp.evaluations[f"{label} ★" if label == report["best"] else label] = ev
        # published as an MLflow model (StudioModel, with this module as its code), into the stage folder
        stage = Path(spec["stage"])
        model_lib.begin(stage.parent, "build", None)
        cols = ([config["item_id"]] if config.get("item_id") else []) + [config["timestamp"], config["target"]] if config["task"] == "time_series" else config["features"]
        output = model_lib.WritableModel(stage.name, model_lib.ModelOutput(spec["studio"]))
        output.publish(ms.StudioModel(model, config), experiment=exp, input_example=df[cols].head(20 if config["task"] != "time_series" else 200))
        res = {"ok": True, "best": report["best"], "metrics": {metric: best["score_val"]}, "leaderboard": report["leaderboard"], "rows": counts}
        # the code that trained it (every source file this process loaded, hashed, with its git state) for its audit
        try:
            import code_provenance

            code_provenance.write(code_provenance.capture(f"python model_studio.py job.json  (trainer={spec['trainer']})", params={"trainer": spec["trainer"], **params},
                                                          data={k.removesuffix("_id"): v for k, v in spec["files"].items()}, seed=params.get("seed", 0)),
                                  out_path.with_name("code_manifest.json"))
        except Exception as e:  # noqa: BLE001 - never fails the run
            logs.append(f"training code not recorded: {type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001
        import traceback

        res = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc(limit=6)}
    res["logs"] = "\n".join(logs)
    out_path.write_text(json.dumps(res, default=str), "utf-8")


if __name__ == "__main__":
    job(sys.argv[1])
