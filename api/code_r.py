"""R transforms for Code Repositories.

The local runner follows the documented .transforms YAML shape and uses an Rscript executable. A small
Foundry-style bridge package exposes the documented datasets.read_table(), datasets.write_table() and
 datasets.upload_files() calls against this app's Files datasets. Structured data crosses the process
boundary as CSV; output tables are converted back to Parquet for the normal build/lineage pipeline.

R comes from BLUESANDAI_RSCRIPT, the PATH, or the portable R installed in the project's `.r/` folder (R's Windows
installer with /CURRENTUSER /DIR=.r). Packages: CRAN through Posit Package Manager and Bioconductor through its
mirror (palantir.com/docs/foundry/transforms-r: Artifacts mirrors of Posit Package Manager and Bioconductor), installed
once into a shared library (data/code-envs/r-library/<R version>) that every R transform sees; renv (`renv.lock`,
`renv::restore()` in .Rprofile or the script) uses that mirror and a shared renv cache, and is installed on first use.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import yaml

ALIAS_OK = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,127}$")
# the project's portable R (see the module docstring)
LOCAL_R = Path(__file__).resolve().parent.parent / ".r"
CRAN_MIRROR = "https://packagemanager.posit.co/cran/latest"
BIOC_MIRROR = "https://packagemanager.posit.co/bioconductor"
_VERSION: dict[str, str | None] = {}


def executable() -> str | None:
    """Configured Rscript executable, one discoverable on PATH, or the project's portable R."""
    configured = os.environ.get("BLUESANDAI_RSCRIPT", "").strip()
    if configured:
        p = Path(configured).expanduser()
        if p.is_file():
            return str(p)
        return shutil.which(configured)
    found = shutil.which("Rscript.exe") or shutil.which("Rscript")
    if found:
        return found
    for local in (LOCAL_R / "bin" / "Rscript.exe", LOCAL_R / "bin" / "Rscript"):
        if local.is_file():
            return str(local)
    return None


def version() -> str | None:
    """The R version of executable() ("4.6.1"), or None without R."""
    exe = executable()
    if not exe:
        return None
    if exe not in _VERSION:
        try:
            p = subprocess.run([exe, "--vanilla", "-e", "cat(paste(R.version$major, R.version$minor, sep = '.'))"], capture_output=True, text=True, timeout=30)
            _VERSION[exe] = p.stdout.strip() or None
        except (OSError, subprocess.TimeoutExpired):
            _VERSION[exe] = None
    return _VERSION[exe]


def _uses_renv(repo: Path) -> bool:
    if (repo / "renv.lock").is_file():
        return True
    for p in [repo / ".Rprofile", *repo.rglob("*.R"), *repo.rglob("*.r")]:
        try:
            if p.is_file() and re.search(r"\brenv::", p.read_text("utf-8", "replace")):
                return True
        except OSError:
            continue
    return False


def runtime_issue() -> str:
    configured = os.environ.get("BLUESANDAI_RSCRIPT", "").strip()
    if configured:
        return f'Rscript was not found at BLUESANDAI_RSCRIPT="{configured}". Set it to the Rscript executable or add R to PATH, then restart the API.'
    return "R transforms need Rscript. Install R and add Rscript to PATH, or set BLUESANDAI_RSCRIPT, then restart the API."


def template_files(name: str, repo_settings: str, sample_input: str) -> dict[str, str]:
    """Starter repository matching the documented .transforms/rscript layout."""
    spec = {
        "inputs": [
            {"alias": "happiness_2019", "properties": {"type": "dataset", "dataset": {"rid": sample_input}}},
        ],
        "outputs": [
            {"alias": "top_10_happiest_countries", "properties": {"type": "dataset", "dataset": {"rid": "top_10_happiest_countries"}}},
        ],
        "runtime": {"type": "rscript", "rscript": {"identifier": "R.4.1.x", "filePath": "project/src/top_10.R"}},
    }
    readme = f"""# {name}\n\nR transforms are declared in `.transforms/*.yml`; each spec points to an R script and maps input/output aliases to datasets.\n\n- The input `dataset.rid` accepts a Files dataset path or item ID in this local app.\n- Output aliases become dataset names under `My Project/Code Repositories/{name}` (or the branch-specific `_branches` folder).\n- `Rscript` must be installed and available on PATH, or configured with `BLUESANDAI_RSCRIPT`.\n- The local `foundry` bridge provides `datasets.read_table()`, `datasets.write_table()` and `datasets.upload_files()`. Tables are exchanged as CSV and stored as Parquet.\n- Use `.Rprofile` and `renv.lock` to manage project packages; for example, activate `renv` and call `renv::restore()` when appropriate.\n\nR transforms run on one local R process; they do not use Spark.\n"""
    rprofile = """# Optional project package management with renv.\nif (file.exists(\"renv/activate.R\")) source(\"renv/activate.R\")\n"""
    r_script = """# A single-node R transform. Add package dependencies with renv as needed.\nlibrary(foundry)\n\nhappiness_2019 <- datasets.read_table(\"happiness_2019\")\nif (!(\"Overall_rank\" %in% names(happiness_2019))) {\n  stop(\"The input dataset must contain Overall_rank\")\n}\ntop_10 <- happiness_2019[happiness_2019$Overall_rank <= 10, , drop = FALSE]\ndatasets.write_table(top_10, \"top_10_happiest_countries\")\n"""
    return {
        "repoSettings.json": repo_settings,
        "README.md": readme,
        ".Rprofile": rprofile,
        ".transforms/happiness_ranking.yml": yaml.safe_dump(spec, sort_keys=False, allow_unicode=True),
        "project/src/top_10.R": r_script,
    }


def _safe_repo_file(repo: Path, value: Any, spec_rel: str) -> tuple[Path, str]:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{spec_rel}: runtime.rscript.filePath must be a repository-relative path")
    rel = value.strip().replace("\\", "/")
    p = (repo / rel).resolve()
    root = repo.resolve()
    if not p.is_relative_to(root):
        raise ValueError(f"{spec_rel}: runtime.rscript.filePath must stay inside the repository")
    if p.suffix.lower() != ".r":
        raise ValueError(f"{spec_rel}: runtime.rscript.filePath must point to an .R file")
    if not p.is_file():
        raise ValueError(f"{spec_rel}: R script not found: {rel}")
    return p, p.relative_to(root).as_posix()


def _dataset_bindings(raw: Any, section: str, spec_rel: str) -> dict[str, str]:
    if section == "inputs" and (raw is None or raw == []):
        return {}
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"{spec_rel}: {section} must be a non-empty list of dataset aliases")
    out: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError(f"{spec_rel}: each {section} entry must be a mapping")
        alias = item.get("alias")
        if not isinstance(alias, str) or not ALIAS_OK.fullmatch(alias):
            raise ValueError(f"{spec_rel}: invalid {section} alias {alias!r}; use a letter or _ followed by letters, digits, _, . or -")
        if alias in out:
            raise ValueError(f"{spec_rel}: duplicate {section} alias {alias!r}")
        props = item.get("properties") or {}
        if not isinstance(props, dict) or props.get("type") != "dataset":
            raise ValueError(f"{spec_rel}: {section} {alias!r} must have properties.type: dataset")
        dataset = props.get("dataset") or {}
        rid = dataset.get("rid") if isinstance(dataset, dict) else None
        if not isinstance(rid, str) or not rid.strip():
            raise ValueError(f"{spec_rel}: {section} {alias!r} needs properties.dataset.rid")
        out[alias] = rid.strip()
    return out


def load_transforms(repo: Path) -> tuple[list[dict], list[dict]]:
    """Return buildable R transform entries and per-spec diagnostics for the runner registry."""
    entries: list[dict] = []
    errors: list[dict] = []
    root = repo.resolve()
    specs = [p for p in repo.rglob("*.yml") if ".transforms" in p.relative_to(repo).parts]
    specs += [p for p in repo.rglob("*.yaml") if ".transforms" in p.relative_to(repo).parts]
    for path in sorted(set(specs)):
        rel = path.relative_to(root).as_posix()
        try:
            doc = yaml.safe_load(path.read_text("utf-8"))
            if not isinstance(doc, dict):
                raise ValueError("transform spec must be a YAML mapping")
            runtime = doc.get("runtime") or {}
            if not isinstance(runtime, dict) or runtime.get("type") != "rscript":
                raise ValueError("runtime.type must be rscript")
            r_spec = runtime.get("rscript") or {}
            if not isinstance(r_spec, dict):
                raise ValueError("runtime.rscript must be a YAML mapping")
            script, script_rel = _safe_repo_file(repo, r_spec.get("filePath"), rel)
            inputs = _dataset_bindings(doc.get("inputs"), "inputs", rel)
            output_refs = _dataset_bindings(doc.get("outputs"), "outputs", rel)
            outputs = {alias: {"name": alias, "folder": None} for alias in output_refs}
            first_output = next(iter(outputs))
            title = str(doc.get("name") or Path(script_rel).stem)
            identifier = str(r_spec.get("identifier") or "Rscript")
            entry = {
                "key": rel,
                "file": script_rel,
                "function": title,
                "line": 1,
                "kind": "r",
                "language": "r",
                "output": outputs[first_output],
                "output_param": first_output,
                "outputs": outputs,
                "inputs": inputs,
                "media_inputs": {},
                "media_outputs": {},
                "runtime": {"type": "rscript", "identifier": identifier, "filePath": script_rel},
                "doc": str(doc.get("description") or f"R transform ({identifier})"),
            }
            entries.append(entry)
            if not executable():
                errors.append({"file": rel, "error": runtime_issue(), "warning": True})
        except (OSError, ValueError, yaml.YAMLError) as e:
            errors.append({"file": rel, "error": str(e)})
    return entries, errors


def _r_string(value: str) -> str:
    """Quote a string as an R string literal."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t")
    return f'"{escaped}"'


def _named_vector(values: dict[str, str]) -> str:
    if not values:
        return "stats::setNames(character(0), character(0))"
    vals = ", ".join(_r_string(v) for v in values.values())
    names = ", ".join(_r_string(k) for k in values)
    return f"stats::setNames(c({vals}), c({names}))"


def _write_bridge(package: Path) -> None:
    (package / "R").mkdir(parents=True, exist_ok=True)
    (package / "DESCRIPTION").write_text(
        "Package: foundry\nVersion: 0.0.1\nTitle: BluesandAI Local Dataset Bridge\n"
        "Description: Local bridge for the documented Code Repositories R dataset calls.\n"
        "License: MIT + file LICENSE\nEncoding: UTF-8\nLazyData: false\n",
        "utf-8",
    )
    (package / "LICENSE").write_text("YEAR: 2026\nCOPYRIGHT HOLDER: BluesandAI\n", "utf-8")
    (package / "NAMESPACE").write_text(
        "export(datasets.read_table)\nexport(datasets.write_table)\nexport(datasets.upload_files)\n",
        "utf-8",
    )
    (package / "R" / "datasets.R").write_text(
        '''.bsa_context <- function() {
  p <- Sys.getenv("BLUESANDAI_R_CONTEXT", "")
  if (!nzchar(p) || !file.exists(p)) stop("BluesandAI R dataset context is missing")
  e <- new.env(parent = baseenv())
  sys.source(p, envir = e)
  e$.bluesandai_context
}
datasets.read_table <- function(alias) {
  ctx <- .bsa_context(); p <- ctx$inputs[[as.character(alias)]]
  if (is.null(p)) stop(paste0("Unknown input dataset alias: ", alias))
  utils::read.csv(p, check.names = FALSE, stringsAsFactors = FALSE, na.strings = "", fileEncoding = "UTF-8")
}
datasets.write_table <- function(data, alias) {
  ctx <- .bsa_context(); p <- ctx$outputs[[as.character(alias)]]
  if (is.null(p)) stop(paste0("Unknown output dataset alias: ", alias))
  utils::write.csv(as.data.frame(data), p, row.names = FALSE, na = "", fileEncoding = "UTF-8")
  invisible(p)
}
datasets.upload_files <- function(paths, alias) {
  ctx <- .bsa_context(); dest <- ctx$file_outputs[[as.character(alias)]]
  if (is.null(dest)) stop(paste0("Unknown file output alias: ", alias))
  paths <- as.character(paths)
  for (i in seq_along(paths)) {
    src <- paths[[i]]
    if (!file.exists(src) || dir.exists(src)) stop(paste0("Not a file: ", src))
    name <- basename(src); target <- file.path(dest, name)
    if (file.exists(target)) target <- file.path(dest, paste0(i, "_", name))
    if (!file.copy(src, target, overwrite = TRUE)) stop(paste0("Could not copy file: ", src))
  }
  invisible(dest)
}
''',
        "utf-8",
    )


def run_transform(t: dict, spec: dict, frames: dict, logs, out_dir: Path) -> tuple[Any, dict[str, dict]]:
    """Execute one R script, returning its primary DataFrame and standard multi-output payloads."""
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    exe = executable()
    if not exe:
        raise RuntimeError(runtime_issue())
    repo = Path(spec["repo"]).resolve()
    runtime_dir = out_dir / "r-runtime"
    input_dir = runtime_dir / "inputs"
    table_dir = runtime_dir / "tables"
    file_dir = runtime_dir / "files"
    lib_dir = runtime_dir / "library"
    package_dir = runtime_dir / "foundry-package"
    for d in (input_dir, table_dir, file_dir, lib_dir):
        d.mkdir(parents=True, exist_ok=True)

    input_paths: dict[str, str] = {}
    for i, (alias, frame) in enumerate(frames.items()):
        csv_path = input_dir / f"input-{i}.csv"
        safe_frame = frame.copy()
        for column in safe_frame.columns:
            if safe_frame[column].dtype == object:
                safe_frame[column] = safe_frame[column].map(lambda v: json.dumps(v, ensure_ascii=False, default=str) if isinstance(v, (dict, list, tuple)) else v)
        safe_frame.to_csv(csv_path, index=False, encoding="utf-8", na_rep="")
        input_paths[alias] = csv_path.resolve().as_posix()

    table_paths: dict[str, Path] = {}
    file_paths: dict[str, Path] = {}
    for i, alias in enumerate(t["outputs"]):
        table_paths[alias] = table_dir / f"output-{i}.csv"
        folder = file_dir / f"output-{i}"
        folder.mkdir(parents=True, exist_ok=True)
        file_paths[alias] = folder

    context_path = runtime_dir / "context.R"
    context_path.write_text(
        ".bluesandai_context <- list(\n"
        f"  inputs = {_named_vector(input_paths)},\n"
        f"  outputs = {_named_vector({k: v.resolve().as_posix() for k, v in table_paths.items()})},\n"
        f"  file_outputs = {_named_vector({k: v.resolve().as_posix() for k, v in file_paths.items()})}\n"
        ")\n",
        "utf-8",
    )
    _write_bridge(package_dir)
    r_env = os.environ.copy()
    r_env["BLUESANDAI_R_CONTEXT"] = str(context_path.resolve())
    # packages installed once into a shared library (per R version) that every R transform sees
    shared_lib = Path(spec["r_library"]) / (version() or "unknown") if spec.get("r_library") else None
    if shared_lib is not None:
        shared_lib.mkdir(parents=True, exist_ok=True)
    prior_lib = r_env.get("R_LIBS_USER", "")
    # the shared library first: install.packages() / renv::install() write there and it persists between runs
    r_env["R_LIBS_USER"] = os.pathsep.join(x for x in (str(shared_lib.resolve()) if shared_lib else "", str(lib_dir.resolve()), prior_lib) if x)
    # renv: the same mirror and a shared cache
    r_env["RENV_CONFIG_REPOS_OVERRIDE"] = CRAN_MIRROR
    if spec.get("renv_root"):
        r_env["RENV_PATHS_ROOT"] = str(Path(spec["renv_root"]).resolve())
    identifier = (t.get("runtime") or {}).get("identifier") or ""
    m = re.match(r"^R\.(\d+)\.(\d+)", identifier)
    if m and version() and not version().startswith(f"{m.group(1)}.{m.group(2)}."):
        logs.write(f"runtime {identifier}: this server runs R {version()}\n")

    installer = runtime_dir / "install_bridge.R"
    installer.write_text(
        f"utils::install.packages({_r_string(str(package_dir.resolve()))}, repos = NULL, type = \"source\", "
        f"lib = {_r_string(str(lib_dir.resolve()))}, quiet = TRUE)\n",
        "utf-8",
    )
    try:
        # from the runtime folder: R's package installer starts child R processes that would load the repository's .Rprofile
        installed = subprocess.run([exe, "--vanilla", str(installer)], cwd=str(runtime_dir), env=r_env, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("Timed out installing the local R dataset bridge") from e
    install_output = "\n".join(x for x in (installed.stdout, installed.stderr) if x).strip()
    if install_output:
        logs.write(install_output[-5000:] + "\n")
    if installed.returncode:
        raise RuntimeError("Could not install the local R dataset bridge: " + (install_output[-1500:] or f"Rscript exit code {installed.returncode}"))

    libs = ([str(shared_lib.resolve())] if shared_lib else []) + [str(lib_dir.resolve())]
    lib_vector = "c(" + ", ".join(_r_string(x) for x in libs) + ")"
    repos = f"options(repos = c(CRAN = {_r_string(CRAN_MIRROR)}), BioC_mirror = {_r_string(BIOC_MIRROR)})\n"
    if shared_lib is not None and _uses_renv(repo):
        # renv on first use, into the shared library
        prepare = runtime_dir / "prepare.R"
        prepare.write_text(
            repos + f".libPaths(unique(c({lib_vector}, .libPaths())))\n"
            f"if (!requireNamespace(\"renv\", quietly = TRUE)) utils::install.packages(\"renv\", lib = {_r_string(str(shared_lib.resolve()))}, quiet = TRUE)\n",
            "utf-8",
        )
        try:
            prep = subprocess.run([exe, "--vanilla", str(prepare)], cwd=str(runtime_dir), env=r_env, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired as e:
            raise RuntimeError("Timed out installing renv") from e
        if prep.returncode:
            raise RuntimeError("Could not install renv: " + ((prep.stderr or prep.stdout)[-1500:]))
    # the mirrors and libraries come from a site profile, which R loads before the repository's .Rprofile (so
    # install.packages() / renv::restore() there have a mirror)
    site = runtime_dir / "site.R"
    site.write_text(repos + f".libPaths(unique(c({lib_vector}, .libPaths())))\n", "utf-8")
    r_env["R_PROFILE"] = str(site.resolve())
    script_path = repo / t["runtime"]["filePath"]
    run_script = runtime_dir / "run.R"
    run_script.write_text(
        repos + f".libPaths(unique(c({lib_vector}, .libPaths())))\n"
        f"source({_r_string(str(script_path.resolve()))}, local = .GlobalEnv, chdir = FALSE)\n",
        "utf-8",
    )
    try:
        completed = subprocess.run(
            [exe, "--no-environ", "--no-restore", "--no-save", str(run_script)],
            cwd=str(repo), env=r_env, capture_output=True, text=True,
        )
    except OSError as e:
        raise RuntimeError(f"Could not start Rscript: {e}") from e
    output = "\n".join(x for x in (completed.stdout, completed.stderr) if x).strip()
    if output:
        logs.write(output[-16000:] + "\n")
    if completed.returncode:
        raise RuntimeError(f"R transform failed (exit code {completed.returncode}): {output[-1800:] or 'see build logs'}")

    multi: dict[str, dict] = {}
    primary = None
    for index, (alias, output_spec) in enumerate(t["outputs"].items()):
        table = table_paths[alias]
        folder = file_paths[alias]
        files = []
        for p in sorted(folder.rglob("*")):
            if p.is_symlink():
                raise RuntimeError(f"R file output {alias!r} contains a symbolic link")
            if p.is_file():
                rel = p.relative_to(folder).as_posix()
                files.append({"path": rel, "file": str(p), "size": p.stat().st_size})
        if table.is_file() and files:
            raise RuntimeError(f"Output {alias!r} wrote both a table and files; use one output kind per alias")
        if table.is_file():
            try:
                df = pd.read_csv(table, encoding="utf-8-sig", keep_default_na=False, na_values=[""])
                parquet = out_dir / f"r-out-{index}.parquet"
                pq.write_table(pa.Table.from_pandas(df, preserve_index=False), parquet)
            except Exception as e:  # noqa: BLE001
                raise RuntimeError(f"Could not convert R table output {alias!r} to Parquet: {e}") from e
            columns = [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]
            multi[alias] = {"kind": "dataframe", "mode": "SNAPSHOT", "parquet": str(parquet), "rows": int(len(df)), "written": int(len(df)), "columns": columns}
            if alias == t.get("output_param") or primary is None:
                primary = df
        elif files:
            multi[alias] = {"kind": "files", "mode": "SNAPSHOT", "files": files}
            logs.write(f"R output {alias}: uploaded {len(files)} file(s)\n")
        else:
            logs.write(f"R output {alias}: no table or files were written\n")
    if not multi:
        raise RuntimeError("The R script completed without writing any declared output. Use datasets.write_table() or datasets.upload_files().")
    return primary, multi


def check_sources(repo: Path, only_file: str | None = None) -> list[dict]:
    """Parse R source files without executing them; tests are skipped clearly if Rscript is unavailable."""
    sources = sorted(p for p in repo.rglob("*") if p.is_file() and p.suffix.lower() == ".r")
    if only_file:
        try:
            selected = (repo / only_file).resolve()
            sources = [p for p in sources if p.resolve() == selected]
        except OSError:
            sources = []
    exe = executable()
    out: list[dict] = []
    for path in sources:
        rel = path.relative_to(repo).as_posix()
        if not exe:
            out.append({"file": rel, "name": "R syntax", "line": 1, "ok": True, "error": runtime_issue(), "skipped": True})
            continue
        checker = path.parent / f".bsa-parse-{path.stem}.R"
        checker.write_text(f"parse(file = {_r_string(str(path.resolve()))}, keep.source = FALSE)\n", "utf-8")
        try:
            result = subprocess.run([exe, "--vanilla", str(checker)], cwd=str(repo), capture_output=True, text=True, timeout=30)
            message = "\n".join(x for x in (result.stderr, result.stdout) if x).strip()
            out.append({"file": rel, "name": "R syntax", "line": 1, "ok": result.returncode == 0,
                        "error": None if result.returncode == 0 else message[-2000:] or f"Rscript exit code {result.returncode}",
                        "ms": 0, "output": message[-2000:]})
        except (OSError, subprocess.TimeoutExpired) as e:
            out.append({"file": rel, "name": "R syntax", "line": 1, "ok": False, "error": str(e), "ms": 0, "output": ""})
        finally:
            checker.unlink(missing_ok=True)
    return out
