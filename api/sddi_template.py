"""The files of a HyperAuto V1 (SDDI / Bellhop) automatic pipeline generator repository.

The repository is an ordinary Python transforms repository: `transforms-bellhop/src/config/SourceConfig.yaml` and
`PipelineConfig.yaml` describe the source and its tables, and `software_defined_integrations/transforms/
pipeline_builder.py` generates the transforms from them when the repository loads:

  metadata   objects / fields / links / diffs from the data dictionary datasets (dd_tables, dd_columns,
             dd_relations) the Cockpit's Sync data step writes
  cleaned    per table: batch union components unioned, cleaning libraries applied, change mode deletes,
             deduplication on the primary key (max of the comparison columns)
  enriched   CUSTOMIZATION tables joined on the relations from the metadata (one row per key, language key)
  final      the source-prefixed primary key and foreign keys (sourceName_|_value…)
  renamed    columns named from the metadata descriptions; the dataset named "displayName (TABLE)"
  BUILD      depends on every last-stage dataset (schedule it with upstream to build everything)

Used by sddi.py (Software Defined Data Integration Cockpit).
"""

from __future__ import annotations

import yaml

GRADLE = """apply plugin: 'bluesandai.python'
apply plugin: 'bluesandai.python-defaults'
"""

META = """package:
  name: "{{ PACKAGE_NAME }}"
  version: "{{ PACKAGE_VERSION }}"

requirements:
  run:
    - python 3.12.*
    - transforms {{ PYTHON_TRANSFORMS_VERSION }}
    - pandas
    - pyyaml
"""

SETUP = '''#!/usr/bin/env python
"""Software Defined Data Integration (HyperAuto V1) pipeline generator."""

import os
from setuptools import find_packages, setup

setup(
    name=os.environ.get("PKG_NAME", "sddi"),
    version=os.environ.get("PKG_VERSION", "0.0.0"),
    description="SDDI automatic pipeline generator",
    packages=find_packages(exclude=["contrib", "docs", "test"]),
    entry_points={"transforms.pipelines": ["root = software_defined_integrations.pipeline:my_pipeline"]},
)
'''

PIPELINE = '''from transforms.api import Pipeline

from software_defined_integrations import transforms

my_pipeline = Pipeline()
my_pipeline.discover_transforms(transforms)
'''

CONFIG = '''"""Reads transforms-bellhop/src/config/*.yaml."""

from pathlib import Path

import yaml

CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"


def load(name):
    p = CONFIG_DIR / name
    return yaml.safe_load(p.read_text("utf-8")) if p.is_file() else {}


def pipeline_config():
    return load("PipelineConfig.yaml") or {}


def source_configs():
    pc = pipeline_config()
    return [load(n) or {} for n in pc.get("sourceConfigFileNames") or ["SourceConfig.yaml"]]
'''

LIBRARIES = '''"""Cleaning libraries: SourceConfig.yaml's cleaningLibraries (every table) and tableCleaningLibraries (one table)
name functions of this module. A function takes and returns a pandas DataFrame; add your own here (and increment
deploymentSemanticVersion when the list of functions applied changes)."""

import pandas as pd


def convert_all_columns_to_clean_types(df):
    """Trim strings, empty strings to null, numeric text columns to numbers."""
    df = df.copy()
    for c in df.columns:
        if df[c].dtype == object:
            s = df[c].map(lambda v: v.strip() if isinstance(v, str) else v)
            s = s.map(lambda v: None if isinstance(v, str) and v == "" else v)
            nonnull = s.dropna()
            if len(nonnull) and nonnull.map(lambda v: isinstance(v, str)).all():
                num = pd.to_numeric(nonnull, errors="coerce")
                if num.notna().all() and not nonnull.str.match(r"^0\\d").any():
                    s = pd.to_numeric(s, errors="coerce")
            df[c] = s
    return df


def trim_whitespace(df):
    df = df.copy()
    for c in df.columns:
        if df[c].dtype == object:
            df[c] = df[c].map(lambda v: v.strip() if isinstance(v, str) else v)
    return df


def parse_timestamp_column(df):
    """Columns named like dates or timestamps (date, time, _ts, …) parsed to timestamps."""
    df = df.copy()
    for c in df.columns:
        n = str(c).lower()
        if df[c].dtype == object and any(k in n for k in ("date", "time", "_ts", "timestamp", "datum")):
            parsed = pd.to_datetime(df[c], errors="coerce")
            if parsed.notna().sum() >= max(1, int(df[c].notna().sum() * 0.9)):
                df[c] = parsed
    return df


def drop_empty_columns(df):
    return df.dropna(axis=1, how="all")
'''

BUILDER = r'''"""Generates the SDDI pipeline from config/SourceConfig.yaml and config/PipelineConfig.yaml.

Preview any generated transform from this file (Preview), as on Foundry. Edit the YAML files (or use the Cockpit)
rather than this file."""

import pandas as pd
from transforms.api import Input, Output, transform_pandas

from software_defined_integrations import config
from software_defined_integrations.transforms.cleaned import function_libraries

SEP = "_|_"
LANGUAGE_COLUMNS = ("spras", "langu", "language", "lang", "language_code", "locale")
GENERATED = []


def _path(folder, name):
    return folder.rstrip("/") + "/" + name


def _ident(name):
    out = "".join(ch if ch.isalnum() else "_" for ch in str(name))
    return out if out[:1].isalpha() else "t_" + out


def _split(v):
    return [x for x in str(v or "").split(",") if x]


def _align_timezones(parts):
    """Union components may mix time zone aware (syncs read timestamps as UTC) and naive timestamps: naive ones
    are taken as UTC."""
    aware = {c for p in parts for c in p.columns if isinstance(p[c].dtype, pd.DatetimeTZDtype)}
    out = []
    for p in parts:
        p = p.copy()
        for c in aware & set(p.columns):
            if not isinstance(p[c].dtype, pd.DatetimeTZDtype):
                p[c] = pd.to_datetime(p[c], errors="coerce").dt.tz_localize("UTC")
        out.append(p)
    return out


def _make(name, output, inputs, fn):
    fn.__name__ = fn.__qualname__ = name
    t = transform_pandas(Output(output), **{k: Input(v) for k, v in inputs.items()})(fn)
    GENERATED.append(t)
    return t


def _pk(objects, table):
    rows = objects[objects["table_name"] == table]
    if not len(rows):
        raise AssertionError(f"0 instances of {table} found in 'objects' metadata table: rerun the metadata datasets "
                             "(objects, links, fields, diffs) after new tables are ingested")
    return _split(rows.iloc[0]["primary_key"])


def _key_values(df, cols, source):
    if not cols or any(c not in df.columns for c in cols):
        return None
    parts = [df[c].astype("string").fillna("") for c in cols]
    joined = parts[0]
    for p in parts[1:]:
        joined = joined + SEP + p
    return source + SEP + joined


pc = config.pipeline_config()
PIPELINE_TABLES = pc.get("tables") or {}
OUT = (pc.get("outputFolder") or "/SDDI/output").rstrip("/")
DISABLE_FK = bool(pc.get("disableForeignKeyGeneration"))
DISABLE_ENRICHED = bool(pc.get("disableEnrichedStage"))
DISABLE_RENAMED = bool(pc.get("disableRenamedStage"))
TABLE_TYPES = {t: [str(x).upper() for x in (v or {}).get("types") or ["OBJECT"]] for t, v in PIPELINE_TABLES.items()}

for sc in config.source_configs():
    if not sc:
        continue
    SOURCE = str(sc.get("sourceName") or pc.get("sourceName") or "SOURCE")
    folders = sc.get("rawFolderStructure") or {}
    RAW = (folders.get("raw") or "").rstrip("/")
    DICT = (folders.get("dataDictionary") or RAW).rstrip("/")
    GLOBAL_LIBS = list(sc.get("cleaningLibraries") or [])
    DEDUP = sc.get("deduplicationConfig") or {}
    LANGUAGE = str(sc.get("languageKey") or "E")
    tables = [t for t in sc.get("tables") or [] if t.get("tableName")]
    names = [t["tableName"] for t in tables]
    customization = [n for n in names if "CUSTOMIZATION" in TABLE_TYPES.get(n, [])]
    META = _path(OUT, "metadata")
    prefix = _ident(SOURCE).lower()

    def _objects(dd_tables, _names=tuple(names), _pt=PIPELINE_TABLES):
        df = dd_tables[dd_tables["table_name"].isin(_names)].copy()
        df["display_name"] = [(_pt.get(n) or {}).get("displayName") or n for n in df["table_name"]]
        df["types"] = [",".join(TABLE_TYPES.get(n, ["OBJECT"])) for n in df["table_name"]]
        return df.reset_index(drop=True)

    def _fields(dd_columns, _names=tuple(names)):
        return dd_columns[dd_columns["table_name"].isin(_names)].reset_index(drop=True)

    def _links(dd_relations, _names=tuple(names)):
        return dd_relations[dd_relations["table_name"].isin(_names) & dd_relations["ref_table"].isin(_names)].reset_index(drop=True)

    _make(f"{prefix}_objects", _path(META, "objects"), {"dd_tables": _path(DICT, "dd_tables")}, _objects)
    _make(f"{prefix}_fields", _path(META, "fields"), {"dd_columns": _path(DICT, "dd_columns")}, _fields)
    _make(f"{prefix}_links", _path(META, "links"), {"dd_relations": _path(DICT, "dd_relations")}, _links)

    raw_inputs = {f"raw_{i}": _path(RAW, (t.get("datasetTransformsConfig") or {}).get("datasetName") or t["tableName"]) for i, t in enumerate(tables)}

    def _diffs(dd_columns, _names=tuple(names), **raws):
        rows = []
        for i, n in enumerate(_names):
            have = set(raws[f"raw_{i}"].columns)
            meta = set(dd_columns[dd_columns["table_name"] == n]["column_name"])
            rows += [{"table_name": n, "column_name": c, "change": "missing_in_raw"} for c in sorted(meta - have)]
            rows += [{"table_name": n, "column_name": c, "change": "not_in_metadata"} for c in sorted(have - meta)]
        return pd.DataFrame(rows, columns=["table_name", "column_name", "change"])

    _make(f"{prefix}_diffs", _path(META, "diffs"), {"dd_columns": _path(DICT, "dd_columns"), **raw_inputs}, _diffs)

    last_stage = {}
    for t in tables:
        name = t["tableName"]
        tc = t.get("datasetTransformsConfig") or {}
        dataset = tc.get("datasetName") or name
        unions = list(tc.get("batchUnionComponents") or [])
        libs = GLOBAL_LIBS + list(tc.get("tableCleaningLibraries") or [])
        missing = [lib for lib in libs if not hasattr(function_libraries, lib)]
        if missing:
            raise ValueError(f"{name}: unknown cleaning libraries {', '.join(missing)} (define them in function_libraries.py)")
        comparison = list(DEDUP.get("comparisonColumns") or []) + list(tc.get("deduplicationComparisonColumns") or [])
        change_mode = tc.get("changeModeColumn") or DEDUP.get("changeModeColumn")
        unique = bool(tc.get("enforceUniquePrimaryKeys"))
        ident = _ident(name).lower()
        sources = {"raw": _path(RAW, unions[0] if unions else dataset)}
        sources.update({f"union_{i}": _path(RAW, u) for i, u in enumerate(unions[1:])})

        def _cleaned(objects, _name=name, _libs=tuple(libs), _cmp=tuple(comparison), _cm=change_mode, _unique=unique, **dfs):
            parts = _align_timezones([dfs["raw"]] + [dfs[k] for k in sorted(dfs) if k.startswith("union_")])
            df = pd.concat(parts, ignore_index=True) if len(parts) > 1 else parts[0]
            for lib in _libs:
                df = getattr(function_libraries, lib)(df)
            pk = [c for c in _pk(objects, _name) if c in df.columns]
            cmp = [c for c in _cmp if c in df.columns]
            if pk and cmp:
                df = df.sort_values(cmp, kind="stable", na_position="first").drop_duplicates(pk, keep="last")
            elif pk and _unique:
                df = df.drop_duplicates(pk, keep="last")
            if _cm and _cm in df.columns:
                df = df[df[_cm].astype("string").fillna("") != "D"]
            return df.reset_index(drop=True)

        cleaned = _path(_path(OUT, "cleaned"), name)
        _make(f"cleaned_{ident}", cleaned, {"objects": _path(META, "objects"), **sources}, _cleaned)
        last_stage[name] = cleaned

    for name in names:
        types = TABLE_TYPES.get(name, ["OBJECT"])
        if types == ["METADATA"]:
            continue
        ident = _ident(name).lower()
        current = last_stage[name]
        joins = [c for c in customization if c != name]
        if not DISABLE_ENRICHED and joins and "CUSTOMIZATION" not in types:
            def _enriched(df, links, objects, fields, _name=name, _joins=tuple(joins), _lang=LANGUAGE, **cust):
                out = df
                for i, c in enumerate(_joins):
                    for _, lk in links[(links["table_name"] == _name) & (links["ref_table"] == c)].iterrows():
                        left, right = _split(lk["columns"]), _split(lk["ref_columns"])
                        other = cust[f"c_{i}"]
                        if any(x not in out.columns for x in left) or any(x not in other.columns for x in right):
                            continue
                        lang = next((x for x in other.columns if str(x).lower() in LANGUAGE_COLUMNS), None)
                        if lang:
                            other = other[other[lang].astype("string") == _lang]
                        other = other.drop_duplicates(right)
                        keep = [x for x in other.columns if x not in right and x != lang]
                        other = other[right + keep].rename(columns={x: f"{c}{SEP}{x}" for x in keep})
                        out = out.merge(other, how="left", left_on=left, right_on=right, suffixes=("", "_dup"))
                        out = out.drop(columns=[x for x in right if x not in left and x in out.columns] + [x for x in out.columns if x.endswith("_dup")])
                return out.reset_index(drop=True)

            enriched = _path(_path(OUT, "enriched"), name)
            _make(f"enriched_{ident}", enriched, {"df": current, "links": _path(META, "links"), "objects": _path(META, "objects"),
                                                  "fields": _path(META, "fields"), **{f"c_{i}": last_stage[c] for i, c in enumerate(joins)}}, _enriched)
            current = enriched

        def _final(df, objects, links, _name=name, _source=SOURCE):
            out = df.copy()
            pk = _pk(objects, _name)
            key = _key_values(out, pk, _source)
            if key is not None:
                out.insert(0, "primary_key", key)
            if not DISABLE_FK:
                for _, lk in links[links["table_name"] == _name].iterrows():
                    ref = lk["ref_table"]
                    if "OBJECT" not in TABLE_TYPES.get(ref, ["OBJECT"]) or ref == _name:
                        continue
                    fk = _key_values(out, _split(lk["columns"]), _source)
                    if fk is not None:
                        out[f"{ref}{SEP}foreign_key"] = fk
            return out.reset_index(drop=True)

        final = _path(_path(OUT, "final"), name)
        _make(f"final_{ident}", final, {"df": current, "objects": _path(META, "objects"), "links": _path(META, "links")}, _final)
        current = final

        if not DISABLE_RENAMED:
            display = (PIPELINE_TABLES.get(name) or {}).get("displayName") or name

            def _renamed(df, fields, _name=name):
                rows = fields[fields["table_name"] == _name]
                names = {}
                for _, f in rows.iterrows():
                    desc = str(f.get("description") or "").strip()
                    if desc and f["column_name"] in df.columns:
                        names[f["column_name"]] = desc
                taken, out = set(df.columns) - set(names), {}
                for col, desc in names.items():
                    new = desc if desc not in taken else f"{desc}{SEP}{col}"
                    out[col] = new
                    taken.add(new)
                return df.rename(columns=out)

            renamed = _path(OUT, f"{display} ({name})")
            _make(f"renamed_{ident}", renamed, {"df": current, "fields": _path(META, "fields")}, _renamed)
            current = renamed
        last_stage[name] = current

    finals = {f"t_{i}": last_stage[n] for i, n in enumerate(names) if TABLE_TYPES.get(n, ["OBJECT"]) != ["METADATA"]}
    if finals:
        def _build(_names=tuple(n for n in names if TABLE_TYPES.get(n, ["OBJECT"]) != ["METADATA"]), **dfs):
            return pd.DataFrame([{"table_name": n, "rows": len(dfs[f"t_{i}"])} for i, n in enumerate(_names)])

        _make(f"{prefix}_BUILD", _path(OUT, "BUILD"), finals, _build)
'''

README = """# {name}

Software Defined Data Integration (HyperAuto V1) automatic pipeline generator for the source **{source}**.

- `transforms-bellhop/src/config/SourceConfig.yaml`: the source, its raw and data dictionary folders, cleaning
  libraries, deduplication and the tables to process.
- `transforms-bellhop/src/config/PipelineConfig.yaml`: the output folder, table display names and types (OBJECT,
  METADATA, CUSTOMIZATION) and the stage switches (disableForeignKeyGeneration, disableEnrichedStage,
  disableRenamedStage).
- `software_defined_integrations/transforms/pipeline_builder.py` generates the transforms; preview them from there.
- Custom cleaning functions go in `software_defined_integrations/transforms/cleaned/function_libraries.py`.

The SDDI Cockpit opens pull requests here when you sync tables or change the pipeline configuration, unless the
repository was severed from its template.
"""


def source_config(name: str, source_rid: str, raw: str, dictionary: str, tables: list[dict], extra: dict | None = None) -> dict:
    return {"sourceName": name, "sourceRid": source_rid, **(extra or {}),
            "rawFolderStructure": {"raw": raw, "dataDictionary": dictionary},
            "cleaningLibraries": ["convert_all_columns_to_clean_types"], "deploymentSemanticVersion": 0, "languageKey": "E",
            "tables": tables}


def pipeline_config(name: str, source_type: str, output: str, tables: dict) -> dict:
    return {"sourceName": name, "sourceType": source_type, "sourceConfigFileNames": ["SourceConfig.yaml"], "outputFolder": output,
            "workflows": {}, "tables": tables, "disableForeignKeyGeneration": False, "disableEnrichedStage": False, "disableRenamedStage": False}


def dump(doc: dict) -> str:
    return yaml.safe_dump(doc, sort_keys=False, allow_unicode=True)


BASE = "transforms-bellhop"
SOURCE_CONFIG = f"{BASE}/src/config/SourceConfig.yaml"
PIPELINE_CONFIG = f"{BASE}/src/config/PipelineConfig.yaml"


def files(name: str, source: str, settings: str, source_cfg: dict, pipeline_cfg: dict) -> dict[str, str]:
    pkg = f"{BASE}/src/software_defined_integrations"
    return {
        "README.md": README.format(name=name, source=source),
        "repoSettings.json": settings,
        f"{BASE}/build.gradle": GRADLE,
        f"{BASE}/conda_recipe/meta.yaml": META,
        f"{BASE}/src/setup.py": SETUP,
        SOURCE_CONFIG: dump(source_cfg),
        PIPELINE_CONFIG: dump(pipeline_cfg),
        f"{pkg}/__init__.py": "",
        f"{pkg}/config.py": CONFIG,
        f"{pkg}/pipeline.py": PIPELINE,
        f"{pkg}/transforms/__init__.py": "",
        f"{pkg}/transforms/pipeline_builder.py": BUILDER,
        f"{pkg}/transforms/cleaned/__init__.py": "",
        f"{pkg}/transforms/cleaned/function_libraries.py": LIBRARIES,
    }
