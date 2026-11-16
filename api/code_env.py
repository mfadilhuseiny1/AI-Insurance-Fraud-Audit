"""The Python environment of Code Repositories transforms (palantir.com/docs/foundry/transforms-python/environment-overview).

A repository declares its packages in conda_recipe/meta.yaml (requirements: build, run, pip, test.requires).
Resolving it checks each requested package (and version pin) against the API's Python environment and the Python
library repositories of Code Repositories (a tagged version whose checks passed). A package the API's environment
lacks, or has in another version, and a pin to another supported Python (3.10 / 3.11) are planned for a dedicated
repository environment (`dedicated`: {python, requirements} as pip requirements) that code_envs.py builds with uv;
uv's solver then reports what cannot be installed. Checks fail with Mamba-style messages for unsupported version
syntax (ranges for python, `>=`, a space after an operator), when the build and run Python versions differ, for
Python versions this platform does not support and for library versions nobody published. Library versions are
locked: `locked` keeps the version a meta.yaml was first resolved to. Also: the Task Runner's install / uninstall /
whoneeds / formatCode, and the Python version support table.
"""

from __future__ import annotations

import re
import sys
from datetime import date
from importlib import metadata
from typing import Any, Optional

META_PATHS = ("conda_recipe/meta.yaml", "transforms-python/conda_recipe/meta.yaml")

# Foundry's Python version support: (version, supported, end of life starts, support discontinued)
PY_SUPPORT = [
    ("3.6", False, "2023-07-16", "2024-01-31"), ("3.7", False, "2023-07-16", "2024-01-31"), ("3.8", False, "2024-09-04", "2025-01-31"),
    ("3.9", False, "2025-10-01", "2026-01-31"), ("3.10", True, "2026-04-30", "2026-10-31"), ("3.11", True, "2027-04-30", "2027-10-31"),
    ("3.12", True, "2028-04-30", "2028-10-31"), ("3.13", False, "2029-04-30", "2029-10-31"), ("3.14", False, "2030-04-30", "2030-10-31"),
]

# packages of the transforms runtime itself (provided here by code_pyapi.py / code_media.py / code_expectations.py)
BUILTIN = {"python", "setuptools", "pip", "transforms", "transforms-sidecar", "transforms-expectations", "transforms-verbs", "transforms-media", "transforms-tables",
           "transforms-lightweight", "pytest-transforms", "foundry-transforms-lib-python", "geospatial-tools"}

# conda package names whose PyPI distribution is named differently
CONDA_TO_PIP = {"pytorch": "torch", "py-opencv": "opencv-python", "opencv": "opencv-python", "pyyaml": "pyyaml", "pillow": "pillow",
                "python-dateutil": "python-dateutil", "pyspark-src": "pyspark", "cudf-polars": "cudf-polars-cu12", "msgpack-python": "msgpack"}


def runtime_python() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}"


def support_table(today: Optional[date] = None) -> list[dict]:
    today = today or date.today()
    out = []
    for v, supported, eol, gone in PY_SUPPORT:
        status = "supported" if supported else "unsupported"
        if supported and today >= date.fromisoformat(eol):
            status = "end of life"
        if today >= date.fromisoformat(gone):
            status = "unsupported"
        if not supported and today < date.fromisoformat(eol):
            status = "coming soon" if v == "3.13" else "in planning"
        out.append({"version": v, "status": status, "eol_start": eol, "discontinued": gone, "runtime": v == runtime_python()})
    return out


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name.strip().lower())


def _installed() -> dict[str, metadata.Distribution]:
    out = {}
    for d in metadata.distributions():
        n = d.metadata.get("Name")
        if n:
            out.setdefault(_norm(n), d)
    return out


def meta_path(files: dict[str, str]) -> Optional[str]:
    for p in META_PATHS:
        if p in files:
            return p
    return next((p for p in sorted(files) if p.endswith("conda_recipe/meta.yaml")), None)


def parse_meta(text: str) -> dict:
    """{build, run, pip, test, errors} of a meta.yaml (Jinja placeholders are ignored)."""
    import yaml

    clean = re.sub(r"\{\{.*?\}\}", "", text)
    clean = re.sub(r"\{%.*?%\}", "", clean)
    try:
        doc = yaml.safe_load(clean) or {}
    except yaml.YAMLError as e:
        return {"build": [], "run": [], "pip": [], "test": [], "errors": [f"meta.yaml is not valid YAML: {e}"]}
    req = doc.get("requirements") or {}
    test = doc.get("test") or {}

    def items(v) -> list[str]:
        return [str(x).strip() for x in (v or []) if x is not None and str(x).strip()]

    return {"build": items(req.get("build")), "run": items(req.get("run")), "pip": items(req.get("pip")),
            "test": items(test.get("requires")), "errors": [], "name": ((doc.get("package") or {}).get("name"))}


SPEC = re.compile(r"^([A-Za-z0-9_.\-]+)(?:\s+(\S+))?(?:\s+(\S+))?$")


def parse_conda_spec(spec: str) -> tuple[str, Optional[str], Optional[str]]:
    """(name, operator or None, version or None); ValueError for syntax Foundry's checks reject."""
    s = spec.strip()
    m = re.match(r"^([A-Za-z0-9_.\-]+)\s*(.*)$", s)
    if not m:
        raise ValueError(f"{spec!r} is not a package spec")
    name, rest = m.group(1), m.group(2).strip()
    if not rest:
        return name, None, None
    if re.match(r"^(<=|>=|==|!=|<|>|=)\s+", rest):
        raise ValueError(f"{spec!r}: no space is allowed after the operator (write {name} {rest.split()[0]}{rest.split()[1] if len(rest.split()) > 1 else ''})")
    if name == "python" and ("," in rest or re.match(r"^(>=|>|<=|<|!=)", rest)):
        raise ValueError(f"{spec!r}: ranges such as python >=3.9 or python >3.9,<=3.10.11 are not supported for Python versions")
    if "," in rest:
        raise ValueError(f"{spec!r}: version ranges are not supported (pin one version, or use <=)")
    m2 = re.match(r"^(<=|>=|==|!=|<|>|=)?([0-9A-Za-z.*+_\-!]+)(?:\s+\S+)?$", rest)
    if not m2:
        raise ValueError(f"{spec!r} has an unsupported version")
    op, ver = m2.group(1), m2.group(2)
    if op == ">=" or op == ">":
        if name == "python":
            raise ValueError(f"{spec!r}: ranges such as python >=3.9 are not supported for Python versions")
        raise ValueError(f"{spec!r}: the operator {op} for versions is not yet supported (pin a version, or use <=)")
    return name, op or None, ver


def _version_ok(installed: str, op: Optional[str], want: Optional[str]) -> bool:
    from packaging.version import InvalidVersion, Version

    if want is None:
        return True
    if "*" in want:
        prefix = want.split("*", 1)[0].rstrip(".")
        return not prefix or installed == prefix or installed.startswith(prefix + ".")
    try:
        a, b = Version(installed), Version(want)
    except InvalidVersion:
        return installed == want if op in (None, "=", "==") else False
    return {None: a == b or installed.startswith(want + "."), "=": a == b or installed.startswith(want + "."), "==": a == b, "!=": a != b,
            "<": a < b, "<=": a <= b}.get(op, False)


def pip_requirement(name: str, op: Optional[str], ver: Optional[str]) -> str:
    """A conda spec as a pip requirement: `numpy 1.26` / `numpy =1.26` → numpy==1.26.* (conda matches the prefix),
    `==`, `<=`, `<`, `!=` as they are, `1.2.*` as a prefix."""
    pip = CONDA_TO_PIP.get(_norm(name), name)
    if not ver:
        return pip
    if op in (None, "="):
        return f"{pip}=={ver if ver.endswith('*') else ver + '.*'}"
    return f"{pip}{op}{ver}"


DEDICATED_PYTHONS = ("3.10", "3.11", "3.12")


def resolve(text: str, libraries: dict[str, list[dict]], locked: Optional[dict[str, str]] = None, denied: Optional[dict[str, str]] = None) -> dict:
    """Resolve a meta.yaml: {python, packages: [{name, requested, section, ok, source, version, error, pip}],
    libraries (published library versions to put on sys.path: {name, version, repo_id, commit}), dedicated (the
    repository environment to build, or None), errors, warnings}. `locked`: {library: version} kept when still
    published and matching. `denied`: {library: repository name} of libraries the caller may not read."""
    meta = parse_meta(text)
    errors: list[str] = list(meta["errors"])
    warnings: list[str] = []
    installed = _installed()
    packages: list[dict] = []
    chosen_libs: dict[str, dict] = {}
    py = runtime_python()
    wanted: dict[str, Optional[str]] = {"python": None}

    py_pins = {sec: [s for s in meta[sec] if re.match(r"^python(\s|$)", s)] for sec in ("build", "run")}
    if py_pins["build"] != py_pins["run"] and py_pins["build"] and py_pins["run"]:
        errors.append(f"The Python dependencies of the build and run sections must be identical (build: {', '.join(py_pins['build'])}; run: {', '.join(py_pins['run'])})")

    table = {r["version"]: r for r in support_table()}

    def check_python(spec: str, section: str) -> dict:
        entry = {"name": "python", "requested": spec, "section": section, "ok": True, "source": "runtime", "version": sys.version.split()[0], "error": None}
        try:
            _, op, ver = parse_conda_spec(spec)
        except ValueError as e:
            entry.update(ok=False, error=str(e))
            return entry
        if ver:
            mm = ".".join(ver.replace("*", "").strip(".").split(".")[:2])
            row = table.get(mm)
            if row and row["status"] == "unsupported":
                entry.update(ok=False, error=f"python {ver} is no longer supported (support discontinued {row['discontinued']}): migrate to Python {py}")
            elif not _version_ok(sys.version.split()[0], op, ver):
                if mm in DEDICATED_PYTHONS and row and row["status"] in ("supported", "end of life"):
                    # another supported Python: the repository gets its own environment with that interpreter
                    wanted["python"] = mm
                    entry.update(source="dedicated", version=f"{mm} (repository environment)")
                    if row["status"] == "end of life":
                        warnings.append(f"Python {mm} reached end of life in Foundry on {row['eol_start']}; support is discontinued on {row['discontinued']}")
                else:
                    entry.update(ok=False, error=f"python {ver} is not available: this platform runs Python {', '.join(DEDICATED_PYTHONS)} (pin one of them or leave python unpinned)")
            elif row and row["status"] == "end of life":
                warnings.append(f"Python {mm} reached end of life in Foundry on {row['eol_start']}; support is discontinued on {row['discontinued']}")
        return entry

    def check(spec: str, section: str) -> dict:
        if re.match(r"^python(\s|$)", spec):
            return check_python(spec, section)
        entry: dict[str, Any] = {"requested": spec, "section": section, "ok": False, "source": None, "version": None, "error": None}
        try:
            if section == "pip":
                from packaging.requirements import InvalidRequirement, Requirement

                try:
                    r = Requirement(spec)
                except InvalidRequirement as e:
                    raise ValueError(f"{spec!r} is not a valid pip requirement: {e}") from None
                name, pip_spec = r.name, r.specifier
                op = ver = None
                entry["pip"] = spec.strip()
            else:
                name, op, ver = parse_conda_spec(spec)
                pip_spec = None
                entry["pip"] = pip_requirement(name, op, ver)
        except ValueError as e:
            entry.update(name=spec.split()[0], error=str(e))
            return entry
        entry["name"] = name
        n = _norm(name)
        if n in BUILTIN:
            entry.update(ok=True, source="runtime", version="built in")
            entry.pop("pip", None)
            return entry
        if n in (denied or {}):
            # a library repository the caller cannot see (Foundry: Viewer on the library's repository)
            entry.pop("pip", None)
            entry["error"] = (f"CondaService:ReadRepositoryPermissionDenied: {name} is published by the repository {denied[n]}, which you cannot "
                              "access (ask for its markings)")
            return entry
        if n in libraries:
            entry.pop("pip", None)
            versions = libraries[n]
            keep = (locked or {}).get(n)
            # a locked version stays while it is still published and matches the spec
            pick = next((v for v in versions if keep and v["version"] == keep and v["ok"] and _version_ok(v["version"], op, ver)), None) or \
                next((v for v in versions if v["ok"] and _version_ok(v["version"], op, ver)), None)
            if pick:
                entry.update(ok=True, source="library", version=pick["version"], repo_id=pick["repo_id"], repo_name=pick["repo_name"])
                chosen_libs[n] = pick
            else:
                have = ", ".join(v["version"] for v in versions if v["ok"]) or "none published yet"
                entry["error"] = f"{spec} is uninstallable: the library {name} has no published version matching it (published: {have})"
            return entry
        dist = installed.get(_norm(CONDA_TO_PIP.get(n, n))) or installed.get(n)
        if not dist:
            # installed into the repository's environment (uv reports a package that does not exist)
            entry.update(ok=True, source="install", version=None)
            return entry
        v = dist.version
        if pip_spec is not None:
            ok = pip_spec.contains(v, prereleases=True) if str(pip_spec) else True
        else:
            ok = _version_ok(v, op, ver)
        entry.update(ok=True, source="environment" if ok else "install", version=v if ok else None)
        return entry

    for section in ("build", "run", "pip", "test"):
        for spec in meta[section]:
            e = check(spec, section)
            packages.append(e)
            if not e["ok"]:
                errors.append(e["error"])
    # another Python: every package goes into its environment; the same Python: only what the API's lacks
    if wanted["python"]:
        reqs = [e["pip"] for e in packages if e.get("pip") and e["ok"]]
    else:
        reqs = [e["pip"] for e in packages if e.get("source") == "install"]
    dedicated = {"python": wanted["python"], "requirements": list(dict.fromkeys(reqs))} if (wanted["python"] or reqs) and not errors else None
    return {"python": f"{wanted['python']} (repository environment)" if wanted["python"] else sys.version.split()[0], "packages": packages,
            "libraries": list(chosen_libs.values()), "dedicated": dedicated, "errors": errors, "warnings": warnings, "support": support_table()}


# ------------------------------------------------------------------------------------------------
# Task Runner edits of meta.yaml
# ------------------------------------------------------------------------------------------------


def _run_block(lines: list[str]) -> tuple[int, int, str]:
    """(index of the `run:` line under requirements, index after its last item, item indent)."""
    in_req = False
    req_indent = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if re.match(r"^requirements\s*:", stripped) and indent == 0:
            in_req, req_indent = True, indent
            continue
        if in_req and stripped and indent <= req_indent and not stripped.startswith("#"):
            in_req = False
        if in_req and re.match(r"^run\s*:", stripped):
            end = i + 1
            item_indent = " " * (indent + 2)
            for j in range(i + 1, len(lines)):
                s, ind = lines[j].strip(), len(lines[j]) - len(lines[j].lstrip())
                if s.startswith("- "):
                    end = j + 1
                    item_indent = " " * ind
                elif s and not s.startswith("#") and ind <= indent:
                    break
            return i, end, item_indent
    raise ValueError("meta.yaml has no requirements: run: section")


def add_packages(text: str, specs: list[str]) -> tuple[str, list[str]]:
    lines = text.splitlines()
    _, end, indent = _run_block(lines)
    current = {_norm(x.split()[0]) for x in parse_meta(text)["run"]}
    added = []
    for s in specs:
        name, _, _ = parse_conda_spec(s)
        if _norm(name) in current:
            continue
        lines.insert(end, f"{indent}- {s}")
        end += 1
        added.append(s)
        current.add(_norm(name))
    return "\n".join(lines) + "\n", added


def pin_package(text: str, name: str, version: Optional[str]) -> tuple[str, str]:
    """Pin a run requirement to one version (`name version`), or unpin it (`name`, the newest): the Libraries panel's
    settings button. Adds the package when meta.yaml does not list it yet. Returns (text, the new spec)."""
    if version is not None and not re.fullmatch(r"[0-9A-Za-z.*+_\-!]+", version):
        raise ValueError(f"{version!r} is not a version")
    lines = text.splitlines()
    start, end, indent = _run_block(lines)
    spec = f"{name} {version}" if version else name
    for i in range(start + 1, end):
        m = re.match(r"^(\s*)-\s+([A-Za-z0-9_.\-]+)", lines[i])
        if m and _norm(m.group(2)) == _norm(name):
            lines[i] = f"{m.group(1)}- {spec}"
            return "\n".join(lines) + "\n", spec
    lines.insert(end, f"{indent}- {spec}")
    return "\n".join(lines) + "\n", spec


def remove_packages(text: str, names: list[str]) -> tuple[str, list[str]]:
    lines = text.splitlines()
    start, end, _ = _run_block(lines)
    targets = {_norm(n.split()[0]) for n in names}
    out, removed = [], []
    for i, line in enumerate(lines):
        m = re.match(r"^\s*-\s+([A-Za-z0-9_.\-]+)", line)
        if start < i < end and m and _norm(m.group(1)) in targets:
            removed.append(line.strip()[2:].strip())
            continue
        out.append(line)
    return "\n".join(out) + "\n", removed


def whoneeds(package: str) -> dict:
    """The installed packages that require `package`, as a tree (three levels)."""
    installed = _installed()
    target = _norm(CONDA_TO_PIP.get(_norm(package), package))
    if target not in installed:
        raise ValueError(f"{package} is not installed in this environment")
    rdeps: dict[str, set[str]] = {}
    for n, d in installed.items():
        for r in d.requires or []:
            if "extra ==" in r:
                continue
            m = re.match(r"^([A-Za-z0-9_.\-]+)", r)
            if m:
                rdeps.setdefault(_norm(m.group(1)), set()).add(n)

    def tree(n: str, depth: int, seen: set[str]) -> list[dict]:
        if depth == 0:
            return []
        return [{"name": p, "version": installed[p].version, "needed_by": tree(p, depth - 1, seen | {p})} for p in sorted(rdeps.get(n, ())) if p not in seen]

    return {"name": target, "version": installed[target].version, "needed_by": tree(target, 3, {target})}


def format_code(files: dict[str, str]) -> tuple[dict[str, str], list[str], list[str]]:
    """Black over every .py file (pyproject.toml [tool.black] configures it): (changed files, names, errors)."""
    import black

    cfg: dict[str, Any] = {}
    py = next((files[p] for p in ("pyproject.toml", "transforms-python/pyproject.toml", "src/pyproject.toml") if p in files), None)
    if py:
        try:
            import tomllib

            cfg = (tomllib.loads(py).get("tool") or {}).get("black") or {}
        except Exception:  # noqa: BLE001
            cfg = {}
    mode = black.Mode(line_length=int(cfg.get("line-length", cfg.get("line_length", 88))),
                      string_normalization=not cfg.get("skip-string-normalization", cfg.get("skip_string_normalization", False)),
                      magic_trailing_comma=not cfg.get("skip-magic-trailing-comma", False))
    changed, names, errors = {}, [], []
    for path, content in sorted(files.items()):
        if not path.endswith(".py"):
            continue
        try:
            new = black.format_str(content, mode=mode)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{path}: {e}")
            continue
        if new != content:
            changed[path] = new
            names.append(path)
    return changed, names, errors


# ------------------------------------------------------------------------------------------------
# Python libraries (shared code)
# ------------------------------------------------------------------------------------------------

def conda_package(name: str, version: str, sources: dict[str, str], depends: list[str]) -> tuple[str, bytes, dict]:
    """A published library version as a conda noarch: python package (.tar.bz2): its sources under site-packages/,
    info/index.json, files, paths.json and link.json. Deterministic (fixed times), so its checksums stay the same.
    Returns (file name, bytes, its repodata.json entry)."""
    import hashlib
    import io as _io
    import json
    import tarfile

    build = "py_0"
    payload = {"site-packages/" + p.split("/", 1)[1]: c.encode("utf-8") for p, c in sorted(sources.items())}
    index = {"name": name, "version": version, "build": build, "build_number": 0, "depends": depends, "noarch": "python",
             "subdir": "noarch", "platform": None, "arch": None, "license": "", "timestamp": 0}
    meta = {
        "info/index.json": json.dumps(index, indent=2, sort_keys=True).encode(),
        "info/files": ("\n".join(payload) + "\n").encode(),
        "info/paths.json": json.dumps({"paths": [{"_path": p, "path_type": "hardlink", "sha256": hashlib.sha256(b).hexdigest(), "size_in_bytes": len(b)}
                                                 for p, b in payload.items()], "paths_version": 1}, indent=2).encode(),
        "info/link.json": json.dumps({"noarch": {"type": "python"}, "package_metadata_version": 1}).encode(),
    }
    buf = _io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        for path, data in [*meta.items(), *payload.items()]:
            ti = tarfile.TarInfo(path)
            ti.size, ti.mtime, ti.mode = len(data), 0, 0o644
            tar.addfile(ti, _io.BytesIO(data))
    data = buf.getvalue()
    entry = {k: index[k] for k in ("name", "version", "build", "build_number", "depends", "noarch", "subdir", "license", "timestamp")}
    entry.update(md5=hashlib.md5(data).hexdigest(), sha256=hashlib.sha256(data).hexdigest(), size=len(data))  # noqa: S324 - conda's checksum
    return f"{name}-{version}-{build}.tar.bz2", data, entry


MAVEN_COORD = re.compile(r"^[A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-]+:[A-Za-z0-9_.+\-]+$")


def spark_jars(files: dict[str, str], test: bool = False) -> tuple[list[str], list[str]]:
    """(Maven coordinates, problems) of the JARs a Python repository's build.gradle adds to Spark: `condaJars
    '<group>:<name>:<version>'` for builds and previews, plus `sparkJars` for unit tests (graphframes, spark-nlp)."""
    out: list[str] = []
    problems: list[str] = []
    kinds = ("condaJars", "sparkJars") if test else ("condaJars",)
    for path, text in sorted(files.items()):
        if not path.endswith("build.gradle"):
            continue
        for kind, coord in re.findall(r"^\s*(condaJars|sparkJars)\s*\(?\s*['\"]([^'\"]+)['\"]", text, re.M):
            if kind not in kinds:
                continue
            if not MAVEN_COORD.match(coord.strip()):
                problems.append(f"{path}: {kind} {coord!r} is not a Maven coordinate (<group>:<name>:<version>)")
            elif coord.strip() not in out:
                out.append(coord.strip())
    return out, problems


SLS_VERSION = re.compile(r"^\d+\.\d+\.\d+(-rc\d+)?(-\d+-g[0-9a-f]+)?$")


def library_package_name(files: dict[str, str], repo_name: str) -> Optional[str]:
    """The conda package a Python library repository publishes (gradle.properties condaPackageName), or None
    when the repository is not a library."""
    props = files.get("gradle.properties") or ""
    m = re.search(r"^\s*condaPackageName\s*=\s*(.+?)\s*$", props, re.M)
    gradle = files.get("build.gradle") or ""
    if not m and "python-library" not in gradle:
        return None
    raw = m.group(1) if m else repo_name
    return re.sub(r"[^a-z0-9-]+", "-", raw.lower())


def library_sources(files: dict[str, str]) -> dict[str, str]:
    """The files a library ships: its packages (folders with __init__.py) under src/, without tests."""
    pkgs = {p.rsplit("/", 1)[0] for p in files if p.startswith("src/") and p.endswith("/__init__.py")}
    tops = {p for p in pkgs if p.count("/") == 1 and p.split("/")[1] not in ("test", "tests")}
    return {p: c for p, c in files.items() if any(p.startswith(t + "/") for t in tops)}
