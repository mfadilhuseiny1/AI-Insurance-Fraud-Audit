"""Java transforms and Java UDFs for Code Repositories (Palantir's "Java" transforms docs), on real Spark.

Toolchain: a JDK 17 (BLUESANDAI_JAVA_HOME, JAVA_HOME, or the portable one in .java/jdk-*) and the Spark jars that
ship with pyspark (Spark local mode on this server). The Foundry API — com.palantir.transforms.lang.java.api
(@Compute / @Input / @Output, FoundryInput / FoundryOutput, ReadRange / WriteMode / modification types, file systems,
Pipeline / PipelineDefiner, High/LowLevelTransform builders, TransformContext, @MaxAllowedDuration,
@UseIncrementalOptions), the testing helpers and the UDF API — is the Java source in api/java_api, compiled once
into .java/cache. The JVM side is api/java_api/.../internal/Main.java (transforms) and UdfMain.java (UDFs).

A Java project is any folder with src/main/java (Foundry's transforms-java/ subproject): its sources and
src/main/resources (META-INF/services names the PipelineDefiner) are compiled with -parameters; src/test/java holds
JUnit 5 (or 4) tests with AssertJ and Mockito. Rows travel between Python and the JVM as JSON with their column types,
so Spark never reads or writes files itself (no Hadoop file system on Windows).

Incremental: each build records every input's row count and content hash (files: name and version) and the outputs
it wrote. The next build tells each input how it changed — APPENDED (rows only added), UNCHANGED, UPDATED (rewritten)
or NEW_VIEW (first build, a snapshot build, the output changed outside builds, or a schema change) — and readForRange
gives the rows added since (UNPROCESSED), the rows processed before (PROCESSED) or all (ENTIRE_VIEW). Writing with
WriteMode.UPDATE appends to the output as last built; SNAPSHOT (the default) replaces it.

UDFs: definitions in src/main/resources/udfs/definitions/*.yml generate typed classes (configuration, input /
output rows, structs, the UDF / factory interfaces and adapters) in com.palantir.foundry.<name>; the implementation
is a factory class plus the UDF class. Examples (examples.registry) run as tests and show in Pipeline Builder.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

ROOT = Path(os.environ.get("BLUESANDAI_JAVA_DIR") or Path(__file__).resolve().parent.parent / ".java")
API_SRC = Path(__file__).resolve().parent / "java_api"
NO_JDK = "Java transforms need a JDK 17 and Spark (pyspark) on the API server"
TIMEOUT = 600
MAIN = "com.palantir.transforms.lang.java.api.internal.Main"
UDF_MAIN = "com.palantir.transforms.lang.java.api.internal.UdfMain"
TEST_JARS = ["junit-platform-console-standalone.jar", "junit-4.jar", "hamcrest-core.jar", "assertj-core.jar", "mockito-core.jar",
             "byte-buddy.jar", "byte-buddy-agent.jar", "objenesis.jar"]
JVM_FLAGS = ["-Xmx2g", "-XX:+UseSerialGC"] + [f"--add-opens=java.base/{p}=ALL-UNNAMED" for p in (
    "java.lang", "java.lang.invoke", "java.lang.reflect", "java.io", "java.net", "java.nio", "java.util", "java.util.concurrent",
    "java.util.concurrent.atomic", "sun.nio.ch", "sun.nio.cs", "sun.security.action", "sun.util.calendar")]
LOG4J = """status = error
appender.console.type = Console
appender.console.name = console
appender.console.target = SYSTEM_ERR
appender.console.layout.type = PatternLayout
appender.console.layout.pattern = %d{HH:mm:ss} %p %c{1}: %m%n
rootLogger.level = info
rootLogger.appenderRef.stderr.ref = console
"""
# Spark, Hadoop and their libraries only speak up for errors; the project's own loggers log at INFO
for _quiet in ("org", "io", "com.google", "com.fasterxml", "akka", "scala", "net", "javax"):
    LOG4J += f"logger.{_quiet.replace('.', '_')}.name = {_quiet}\nlogger.{_quiet.replace('.', '_')}.level = error\n"

_lock = threading.Lock()

# Shared code between repositories (Palantir's "Share code across repositories"): a Java repository's compiled code is
# published as a jar per commit; another repository depends on it with a Maven coordinate in its subproject's
# build.gradle — compile '<SHARED_REPO_RID>:<GRADLE_SUBPROJECT>:<VERSION>'. code_repos resolves the coordinates
# (the repository must be added in Settings → Artifacts) and hands the jars over: {coordinate: jar path}, plus why a
# coordinate could not be resolved.
DEPENDENCIES: dict[str, str] = {}
DEPENDENCY_ERRORS: dict[str, str] = {}
_DEP_LINE = re.compile(r"""^\s*(compile|implementation|api|runtimeOnly|compileOnly)\s*\(?\s*['"]([^'"\s]+:[^'"\s]+:[^'"\s]+)['"]""", re.M)


# ------------------------------------------------------------------------------------------------
# toolchain
# ------------------------------------------------------------------------------------------------


def java_home() -> Optional[Path]:
    for env in ("BLUESANDAI_JAVA_HOME", "JAVA_HOME"):
        v = os.environ.get(env)
        if v and (Path(v) / "bin").is_dir():
            return Path(v)
    local = sorted(ROOT.glob("jdk-*"), reverse=True)
    if local:
        return local[0]
    javac = shutil.which("javac")
    return Path(javac).resolve().parent.parent if javac else None


def _bin(name: str) -> Optional[str]:
    home = java_home()
    if not home:
        return None
    for cand in (home / "bin" / f"{name}.exe", home / "bin" / name):
        if cand.exists():
            return str(cand)
    return None


def spark_jars() -> Optional[Path]:
    import importlib.util

    spec = importlib.util.find_spec("pyspark")
    if not spec or not spec.origin:
        return None
    jars = Path(spec.origin).parent / "jars"
    return jars if jars.is_dir() else None


def available() -> bool:
    return bool(_bin("javac") and _bin("java") and spark_jars())


def version() -> Optional[str]:
    if not available():
        return None
    try:
        p = subprocess.run([_bin("javac"), "-version"], capture_output=True, text=True, timeout=30)
        spark = next(iter(sorted(spark_jars().glob("spark-core_*.jar"))), None)
        return ((p.stdout or p.stderr).strip().splitlines()[-1] + (f" · Spark {spark.stem.rsplit('-', 1)[-1]}" if spark else "")).strip()
    except Exception:  # noqa: BLE001
        return None


def _test_jars() -> list[Path]:
    return [ROOT / j for j in TEST_JARS if (ROOT / j).exists()]


def _cp(*parts: Any) -> str:
    out: list[str] = []
    for p in parts:
        if p is None:
            continue
        if isinstance(p, (list, tuple)):
            out += [str(x) for x in p]
        else:
            out.append(str(p))
    return os.pathsep.join(out)


def _hash_files(paths: list[Path], base: Path) -> str:
    h = hashlib.sha1()
    for p in sorted(paths):
        h.update(p.relative_to(base).as_posix().encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def _clean(text: str, *roots: Path) -> str:
    for r in roots:
        text = text.replace(str(r) + os.sep, "").replace(str(r).replace("\\", "/") + "/", "")
    return "\n".join(line for line in text.splitlines() if not line.startswith("Picked up JAVA_TOOL_OPTIONS")).strip()


def _javac(sources: list[Path], out: Path, classpath: str, base: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    argfile = out.parent / f"{out.name}-sources.txt"
    argfile.write_text("\n".join(f'"{str(s)}"'.replace("\\", "/") for s in sources), "utf-8")
    p = subprocess.run([_bin("javac"), "-encoding", "UTF-8", "-parameters", "-nowarn", "-proc:none", "-d", str(out), "-cp", classpath, f"@{argfile}"],
                       capture_output=True, text=True, timeout=TIMEOUT, encoding="utf-8", errors="replace")
    if p.returncode:
        raise ValueError("javac failed:\n" + _clean(p.stderr, base)[-6000:])


def api_classes() -> Path:
    """The Foundry API layer (api/java_api), compiled once per version of its sources."""
    if not available():
        raise RuntimeError(NO_JDK)
    sources = sorted(API_SRC.rglob("*.java"))
    target = ROOT / "cache" / f"api-{_hash_files(sources, API_SRC)}"
    if (target / "ok").exists():
        return target / "classes"
    with _lock:
        if not (target / "ok").exists():
            tmp = target.with_name(target.name + f".tmp{uuid.uuid4().hex[:6]}")
            _javac(sources, tmp / "classes", _cp(spark_jars() / "*", _test_jars()), API_SRC)
            (tmp / "log4j2.properties").write_text(LOG4J, "utf-8")
            (tmp / "ok").write_text("ok", "utf-8")
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            tmp.rename(target)
    return target / "classes"


# Palantir's transforms-excel-parser (Microsoft Excel docs): our com.palantir.transforms.excel API (api/java_excel) on
# Apache POI 5.2.3. POI's own dependencies (commons-io / compress / codec / collections4 / math3, log4j-api) ship with
# Spark; these six jars are fetched from Maven Central once (setup-java.ps1, or on first use) and checked against the
# SHA-1 Maven publishes. A build.gradle line `compile 'com.palantir.transforms.excel-parser:transforms-excel-parser:<v>'`
# puts the parser and POI on the classpath (the repository needs transforms-excel-parser-bundle in Settings → Artifacts).
EXCEL_SRC = Path(__file__).resolve().parent / "java_excel"
EXCEL_GROUP, EXCEL_ARTIFACT = "com.palantir.transforms.excel-parser", "transforms-excel-parser"
EXCEL_BUNDLE = "transforms-excel-parser-bundle"
EXCEL_VERSION = "1.155.0"  # the javadoc version the docs ship; any version resolves to this implementation
_CENTRAL = "https://repo1.maven.org/maven2"
POI_JARS = {
    "poi-5.2.3.jar": "org/apache/poi/poi/5.2.3/poi-5.2.3.jar",
    "poi-ooxml-5.2.3.jar": "org/apache/poi/poi-ooxml/5.2.3/poi-ooxml-5.2.3.jar",
    "poi-ooxml-lite-5.2.3.jar": "org/apache/poi/poi-ooxml-lite/5.2.3/poi-ooxml-lite-5.2.3.jar",
    "xmlbeans-5.1.1.jar": "org/apache/xmlbeans/xmlbeans/5.1.1/xmlbeans-5.1.1.jar",
    "SparseBitSet-1.2.jar": "com/zaxxer/SparseBitSet/1.2/SparseBitSet-1.2.jar",
    "curvesapi-1.07.jar": "com/github/virtuald/curvesapi/1.07/curvesapi-1.07.jar",
}


def is_excel_parser(coord: str) -> bool:
    group, _, rest = coord.partition(":")
    return group == EXCEL_GROUP and rest.split(":", 1)[0] == EXCEL_ARTIFACT


def _fetch(url: str, attempts: int = 4) -> bytes:
    import urllib.request

    last: Exception | None = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310 - a fixed https Maven Central URL
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            # Maven Central answers bursts with 429: back off longer
            time.sleep((15 if "429" in str(e) else 2) * 2 ** i)
    raise RuntimeError(f"could not download {url}: {last}")


def poi_jars(download: bool = True) -> list[Path]:
    """Apache POI's jars in .java/poi, downloaded (and SHA-1 checked) when missing."""
    folder = ROOT / "poi"
    missing = [n for n in POI_JARS if not (folder / n).is_file()]
    if missing and not download:
        raise RuntimeError("Apache POI is not installed: run setup-java.ps1 (or let the API download it from Maven Central)")
    with _lock:
        for name in missing:
            if (folder / name).is_file():
                continue
            url = f"{_CENTRAL}/{POI_JARS[name]}"
            data = _fetch(url)
            want = _fetch(url + ".sha1").decode("ascii", "replace").strip().split()[0].lower()
            if hashlib.sha1(data).hexdigest() != want:
                raise RuntimeError(f"checksum mismatch for {name}")
            folder.mkdir(parents=True, exist_ok=True)
            tmp = folder / f"{name}.part"
            tmp.write_bytes(data)
            os.replace(tmp, folder / name)
    return [folder / n for n in POI_JARS]


# Iceberg tables in Spark transforms (code_tables.py): the Iceberg Spark runtime for Spark 3.5 / Scala 2.12, fetched
# from Maven Central once (setup-java.ps1, or on first use) and checked against the SHA-1 Maven publishes.
ICEBERG_VERSION = "1.9.2"
ICEBERG_SPARK_JAR = f"iceberg-spark-runtime-3.5_2.12-{ICEBERG_VERSION}.jar"
ICEBERG_SPARK_PATH = f"org/apache/iceberg/iceberg-spark-runtime-3.5_2.12/{ICEBERG_VERSION}/{ICEBERG_SPARK_JAR}"


def iceberg_spark_jar(download: bool = True) -> Path:
    """The Iceberg Spark runtime in .java/iceberg, downloaded (and SHA-1 checked) when missing."""
    path = ROOT / "iceberg" / ICEBERG_SPARK_JAR
    if path.is_file():
        return path
    if not download:
        raise RuntimeError("the Iceberg Spark runtime is not installed: run setup-java.ps1 (or let the API download it from Maven Central)")
    with _lock:
        if not path.is_file():
            url = f"{_CENTRAL}/{ICEBERG_SPARK_PATH}"
            data = _fetch(url)
            want = _fetch(url + ".sha1").decode("ascii", "replace").strip().split()[0].lower()
            if hashlib.sha1(data).hexdigest() != want:
                raise RuntimeError(f"checksum mismatch for {ICEBERG_SPARK_JAR}")
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            tmp.write_bytes(data)
            os.replace(tmp, path)
    return path


def excel_parser_jars() -> list[Path]:
    """The transforms-excel-parser jar (compiled once per version of api/java_excel) followed by Apache POI's jars."""
    poi = poi_jars()
    api = api_classes()
    sources = sorted(EXCEL_SRC.rglob("*.java"))
    target = ROOT / "cache" / f"excel-{_hash_files(sources, EXCEL_SRC)}-{api.parent.name[4:12]}"
    jar = target / f"{EXCEL_ARTIFACT}-{EXCEL_VERSION}.jar"
    if not jar.is_file():
        with _lock:
            if not jar.is_file():
                tmp = target.with_name(target.name + f".tmp{uuid.uuid4().hex[:6]}")
                _javac(sources, tmp / "classes", _cp(poi, api, spark_jars() / "*"), EXCEL_SRC)
                package_jar({"classes": tmp / "classes"}, tmp / jar.name, EXCEL_ARTIFACT, EXCEL_VERSION)
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
                tmp.rename(target)
    return [jar, *poi]


def _log_config() -> Path:
    return api_classes().parent / "log4j2.properties"


# ------------------------------------------------------------------------------------------------
# a repository's Java project
# ------------------------------------------------------------------------------------------------


def _under(p: Path, base: Path, marker: str) -> bool:
    return f"/{marker}/" in "/" + p.relative_to(base).as_posix()


def java_files(repo: Path) -> tuple[list[Path], list[Path]]:
    """(main sources, test sources): src/test/java holds tests; every other .java file is project code."""
    main, tests = [], []
    for p in sorted(repo.rglob("*.java")):
        (tests if _under(p, repo, "src/test/java") else main).append(p)
    return main, tests


def _resources(repo: Path, kind: str) -> list[tuple[Path, str]]:
    out = []
    for d in repo.rglob(f"src/{kind}/resources"):
        if d.is_dir():
            out += [(f, f.relative_to(d).as_posix()) for f in sorted(d.rglob("*")) if f.is_file()]
    return out


def has_java(repo: Path) -> bool:
    return any(repo.rglob("*.java")) or bool(udf_definition_files(repo))


PACKAGE = re.compile(r"^\s*package\s+([\w.]+)\s*;", re.M)


def _class_of(path: Path) -> Optional[str]:
    m = PACKAGE.search(_strip_comments(path.read_text("utf-8", errors="replace")))
    return f"{m.group(1)}.{path.stem}" if m else path.stem


def _strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def _class_names(classes: Path) -> list[str]:
    return sorted(p.relative_to(classes).with_suffix("").as_posix().replace("/", ".") for p in classes.rglob("*.class") if "$" not in p.name)


def _strip_block(text: str, name: str) -> str:
    """The gradle text without a `name { ... }` block (buildscript's classpath dependencies are the build's own)."""
    out, i = [], 0
    for m in re.finditer(rf"\b{name}\s*\{{", text):
        if m.start() < i:
            continue
        depth, j = 1, m.end()
        while j < len(text) and depth:
            depth += {"{": 1, "}": -1}.get(text[j], 0)
            j += 1
        out.append(text[i:m.start()])
        i = j
    out.append(text[i:])
    return "".join(out)


def gradle_coordinates(text: str) -> list[str]:
    """Maven coordinates (group:artifact:version) a build.gradle depends on, outside buildscript and comments."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(?m)//.*$", "", text)
    return list(dict.fromkeys(m.group(2) for m in _DEP_LINE.finditer(_strip_block(text, "buildscript"))))


def project_coordinates(files: dict[str, str]) -> list[str]:
    """The coordinates of every subproject build.gradle (not the root one, which builds the repository)."""
    out: list[str] = []
    for path, text in sorted(files.items()):
        if path.endswith("build.gradle") and "/" in path:
            out += gradle_coordinates(text)
    return list(dict.fromkeys(out))


def java_subprojects(files: dict[str, str]) -> list[str]:
    """Gradle subprojects holding Java code (transforms-java, ...): what a repository publishes."""
    subs = set()
    for path in files:
        if path.endswith(".java") and "/src/main/java/" in f"/{path}":
            subs.add(path.split("/src/main/java/")[0].split("/")[-1] if "/src/main/java/" in path else "")
    return sorted(s for s in subs if s)


def _dependency_jars(repo: Path, deps: Optional[dict] = None, errors: Optional[dict] = None) -> list[Path]:
    files = {p.relative_to(repo).as_posix(): p.read_text("utf-8", errors="replace") for p in repo.rglob("build.gradle")}
    deps = DEPENDENCIES if deps is None else deps
    errors = DEPENDENCY_ERRORS if errors is None else errors
    for coord in project_coordinates(files):
        if coord not in deps:
            raise ValueError(f"build.gradle: {errors.get(coord) or f'the dependency {coord} could not be resolved'}")
    # every resolved jar: those build.gradle names and what they depend on in turn (Gradle's transitive compile)
    jars = [Path(j) for j in dict.fromkeys(deps.values())] if project_coordinates(files) else []
    return jars


def package_jar(info: dict, dest: Path, name: str, version: str) -> Path:
    """The compiled classes and resources of a project as a jar (what a shared code repository publishes)."""
    import zipfile

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + f".tmp{uuid.uuid4().hex[:6]}")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("META-INF/MANIFEST.MF", f"Manifest-Version: 1.0\nImplementation-Title: {name}\nImplementation-Version: {version}\n\n")
        for f in sorted(Path(info["classes"]).rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(info["classes"]).as_posix())
    os.replace(tmp, dest)
    return dest


def compile_project(repo: Path, tests: bool = False, deps: Optional[dict] = None, dep_errors: Optional[dict] = None) -> dict:
    """Compile the project (and its tests): cached by the hash of its sources, resources and UDF definitions.
    Returns {classes, test_classes, class_names, test_class_names, sources: {class: repo-relative file}, udfs}."""
    api = api_classes()
    main, test_src = java_files(repo)
    res, test_res = _resources(repo, "main"), _resources(repo, "test")
    defs = udf_definitions(repo)
    generated = generate_udfs(defs)
    deps = _dependency_jars(repo, deps, dep_errors)
    h = hashlib.sha1(api.parent.name.encode())
    for d in deps:
        h.update(f"{d}:{d.stat().st_size}:{d.stat().st_mtime_ns}".encode())
    for p in main + test_src + [f for f, _ in res + test_res]:
        h.update(p.relative_to(repo).as_posix().encode())
        h.update(p.read_bytes())
    key = h.hexdigest()[:20]
    target = ROOT / "cache" / f"repo-{key}"
    sources = {}
    for p in main + test_src:
        cls = _class_of(p)
        if cls:
            sources[cls] = p.relative_to(repo).as_posix()
    info = {"classes": target / "classes", "test_classes": target / "test-classes", "sources": sources, "udfs": defs, "generated": sorted(generated),
            "deps": deps}
    if not (target / "ok").exists():
        with _lock:
            if not (target / "ok").exists():
                tmp = target.with_name(target.name + f".tmp{uuid.uuid4().hex[:6]}")
                gen = tmp / "generated"
                for rel, text in generated.items():
                    (gen / rel).parent.mkdir(parents=True, exist_ok=True)
                    (gen / rel).write_text(text, "utf-8")
                all_main = main + sorted(gen.rglob("*.java"))
                if all_main:
                    _javac(all_main, tmp / "classes", _cp(deps, api, spark_jars() / "*"), repo)
                (tmp / "classes").mkdir(parents=True, exist_ok=True)
                for f, rel in res:
                    (tmp / "classes" / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(f, tmp / "classes" / rel)
                (tmp / "ok").write_text("ok", "utf-8")
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
                tmp.rename(target)
    if tests and test_src and not (target / "tests-ok").exists():
        with _lock:
            if not (target / "tests-ok").exists():
                out = target / "test-classes"
                if out.exists():
                    shutil.rmtree(out, ignore_errors=True)
                _javac(test_src, out, _cp(target / "classes", deps, api, spark_jars() / "*", _test_jars()), repo)
                for f, rel in test_res:
                    (out / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(f, out / rel)
                (target / "tests-ok").write_text("ok", "utf-8")
    info["class_names"] = _class_names(target / "classes")
    info["test_class_names"] = _class_names(target / "test-classes") if (target / "test-classes").is_dir() else []
    return info


def _java(main_class: str, mode: str, spec: dict, classpath: str, timeout: int = TIMEOUT, cwd: Optional[Path] = None) -> tuple[dict, str]:
    """Run a mode of Main / UdfMain with a JSON spec; returns (result, logs)."""
    with tempfile.TemporaryDirectory(prefix="java-") as tmp:
        t = Path(tmp)
        spec = {**spec, "out": str(t / "result.json"), "tmp": str(t)}
        (t / "spec.json").write_text(json.dumps(spec, default=_json_default), "utf-8")
        env = {k: v for k, v in os.environ.items() if not re.search(r"KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL", k)}
        env["SPARK_LOCAL_IP"] = "127.0.0.1"
        # builds call the API as the user who started them (also on ServiceDiscovery): the per-build job token
        if spec.get("api_url"):
            env["BLUESANDAI_API_URL"] = str(spec["api_url"])
        if spec.get("api_token"):
            env["BLUESANDAI_API_TOKEN"] = str(spec["api_token"])
        try:
            p = subprocess.run([_bin("java"), *JVM_FLAGS, f"-Dlog4j2.configurationFile={_log_config().as_uri()}", f"-Djava.io.tmpdir={t}",
                                "-cp", classpath, main_class, mode, str(t / "spec.json")],
                               capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace", env=env, cwd=str(cwd or t))
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"the Java job ran longer than {timeout} s and was stopped") from None
        logs = _clean(p.stderr or "", t)
        if not (t / "result.json").exists():
            raise RuntimeError(f"the JVM stopped without a result (exit {p.returncode}):\n{logs[-4000:]}")
        result = json.loads((t / "result.json").read_text("utf-8"))
        # outputs are files in the temp folder: read them before it goes away
        if mode == "build" and result.get("ok"):
            result["loaded"] = _load_outputs(result.get("outputs") or {})
        return result, logs


def _json_default(o: Any) -> Any:
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return str(o)
    if isinstance(o, bytes):
        import base64

        return base64.b64encode(o).decode()
    return str(o)


# ------------------------------------------------------------------------------------------------
# listing transforms
# ------------------------------------------------------------------------------------------------


def _output_ref(path: str) -> dict:
    parts = [p for p in str(path).split("/") if p]
    return {"name": parts[-1] if parts else str(path), "folder": "/".join(parts[:-1]) or None, "ref": path}


def iso_seconds(duration: Optional[str]) -> Optional[int]:
    """ISO 8601 duration ("PT2H", "P1DT30M") in seconds."""
    if not duration:
        return None
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?", duration.strip().upper())
    if not m or not any(m.groups()):
        raise ValueError(f"@MaxAllowedDuration: {duration!r} is not an ISO 8601 duration such as PT2H")
    d, h, mi, s = (float(x) if x else 0 for x in m.groups())
    return int(d * 86400 + h * 3600 + mi * 60 + s)


def list_repo(repo: Path) -> tuple[list[dict], list[dict]]:
    """(transform entries for code_runner's registry, errors). Compiles the project and asks the JVM which
    transforms the PipelineDefiner registers."""
    errors: list[dict] = []
    main, _ = java_files(repo)
    if not main and not udf_definition_files(repo):
        return [], []
    try:
        info = compile_project(repo)
    except ValueError as e:
        return [], [{"file": main[0].relative_to(repo).as_posix() if main else "", "error": str(e)}]
    entries: list[dict] = []
    if info["udfs"]:
        problems, _ = udf_check(repo, info)
        errors += [{"file": u.get("file", ""), "error": p} for u in info["udfs"] for p in problems if p.startswith(u["name"] + ":")]
    if not info["class_names"]:
        return entries, errors
    res, logs = _java(MAIN, "list", {"classes": info["class_names"]}, _cp(info["classes"], info["deps"], api_classes(), spark_jars() / "*"), timeout=240)
    if not res.get("ok"):
        return entries, errors + [{"file": main[0].relative_to(repo).as_posix() if main else "", "error": res.get("error") or logs[-3000:]}]
    seen: dict[str, int] = {}
    def warn(ws: list) -> None:
        for w in ws:
            rel_w = info["sources"].get(w.get("class", ""), "")
            if not any(e.get("error") == w["message"] for e in errors):
                errors.append({"file": rel_w, "error": w["message"], "warning": True})

    for d in res.get("transforms") or []:
        if "warnings_only" in d:
            warn(d["warnings_only"])
            continue
        rel = info["sources"].get(d["class"], d["class"].replace(".", "/") + ".java")
        outs = {k: _output_ref(v) for k, v in d["outputs"].items()}
        first = next(iter(outs.values()))
        key = f"{rel}::{d['method']}" if d["registration"] == "auto" else f"{rel}::{d['method']}[{first['name']}]"
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 1:
            key = f"{key}#{seen[key]}"
        line = 1
        try:
            src = (repo / rel).read_text("utf-8")
            m = re.search(rf"\b{re.escape(d['method'])}\s*\(", src)
            line = src.count("\n", 0, m.start()) + 1 if m else 1
        except OSError:
            pass
        try:
            max_s = iso_seconds(d.get("max_duration"))
        except ValueError as e:
            errors.append({"file": rel, "error": str(e)})
            max_s = None
        warn(d.get("warnings") or [])
        entries.append({
            "key": key, "file": rel, "function": d["method"], "line": line, "kind": "java", "language": "java",
            "output": {"name": first["name"], "folder": first["folder"]},
            "outputs": {k: {"name": v["name"], "folder": v["folder"]} for k, v in outs.items()},
            "output_param": next(iter(outs)), "inputs": d["inputs"], "media_inputs": {}, "media_outputs": {},
            "incremental": {"java": True, "require_incremental": False, "semantic_version": 1, "snapshot_inputs": [], "strict_append": False},
            "uses_ctx": any(p["type"] == "TransformContext" for p in d["parameters"]), "doc": "",
            "java": {"class": d["class"], "method": d["method"], "manual_index": d["manual_index"], "kind": d["kind"], "registration": d["registration"],
                     "ignore_incremental_deletes": d["ignore_incremental_deletes"], "use_schema_modification_type": d["use_schema_modification_type"],
                     "stop_propagating": d["stop_propagating"], "stop_requiring": d["stop_requiring"], "max_duration": d.get("max_duration"),
                     "max_duration_s": max_s},
        })
    return entries, errors


# ------------------------------------------------------------------------------------------------
# building a transform
# ------------------------------------------------------------------------------------------------


def _arrow_type(t) -> str:
    import pyarrow as pa

    if pa.types.is_boolean(t):
        return "Boolean"
    if pa.types.is_int8(t):
        return "Byte"
    if pa.types.is_int16(t):
        return "Short"
    if pa.types.is_int32(t):
        return "Integer"
    if pa.types.is_integer(t):
        return "Long"
    if pa.types.is_float32(t) or pa.types.is_float16(t):
        return "Float"
    if pa.types.is_floating(t):
        return "Double"
    if pa.types.is_decimal(t):
        return "Decimal"
    if pa.types.is_date(t):
        return "Date"
    if pa.types.is_timestamp(t):
        return "Timestamp"
    return "String"


def _read_table(parquet: str) -> tuple[list[dict], list[dict]]:
    """(columns, rows) of a Parquet dataset; nested values as JSON text."""
    import pyarrow.parquet as pq

    table = pq.read_table(parquet)
    columns = [{"name": f.name, "type": _arrow_type(f.type)} for f in table.schema]
    rows = table.to_pylist()
    for r in rows:
        for k, v in r.items():
            if isinstance(v, (list, dict)):
                r[k] = json.dumps(v, default=_json_default)
    return columns, rows


def _rows_hash(rows: list[dict], n: Optional[int] = None) -> str:
    h = hashlib.sha256()
    for r in rows[: len(rows) if n is None else n]:
        h.update(json.dumps(r, sort_keys=True, default=_json_default).encode())
        h.update(b"\x1e")
    return h.hexdigest()[:32]


def _plan_frame(seen: Optional[dict], columns: list[dict], rows: list[dict], fresh: bool, ignore_deletes: bool, schema_mod: bool) -> tuple[str, str, int]:
    """(modification type, schema modification type, processed rows) of a tabular input."""
    if fresh or not seen:
        return "NEW_VIEW", "UNCHANGED", 0
    n = int(seen.get("rows") or 0)
    schema_changed = seen.get("columns") is not None and seen["columns"] != columns
    if schema_changed:
        return ("UNCHANGED", "NEW_SCHEMA", min(n, len(rows))) if schema_mod else ("NEW_VIEW", "UNCHANGED", 0)
    if len(rows) == n and _rows_hash(rows) == seen.get("hash"):
        return "UNCHANGED", "UNCHANGED", n
    if len(rows) > n and _rows_hash(rows, n) == seen.get("hash"):
        return "APPENDED", "UNCHANGED", n
    if len(rows) < n and ignore_deletes:
        # rows removed upstream are not a breaking change: what is left counts as processed
        return "UNCHANGED", "UNCHANGED", len(rows)
    return "UPDATED", "UNCHANGED", 0


def _plan_files(seen: Optional[dict], sigs: dict[str, str], fresh: bool, ignore_deletes: bool) -> tuple[str, list[str]]:
    """(files modification type, logical paths already processed) of an input's files."""
    if fresh or seen is None:
        return "NEW_VIEW", []
    same = {k for k, v in sigs.items() if seen.get(k) == v}
    changed = [k for k, v in sigs.items() if k in seen and seen[k] != v]
    removed = [k for k in seen if k not in sigs]
    if changed or (removed and not ignore_deletes):
        return "UPDATED", []
    if len(same) == len(sigs):
        return "UNCHANGED", sorted(same)
    return "APPENDED", sorted(same)


def build(repo: Path, t: dict, spec: dict, work: Path) -> dict:
    """Run a Java transform. `spec` is code_runner's: inputs (Parquet paths), media_inputs (folders), incremental_state,
    force_snapshot, previous_outputs ({param: Parquet path}), parameters. Returns {outputs: {param: {kind, mode, ...}},
    incremental, logs}."""
    import pandas as pd

    info = compile_project(repo)
    j = t["java"]
    state = spec.get("incremental_state") or {}
    seen_inputs = state.get("inputs") or {}
    fresh_reason = None
    if spec.get("force_snapshot"):
        fresh_reason = "a snapshot build was requested"
    elif not state:
        fresh_reason = "first build"
    elif spec.get("previous_output_reason"):
        fresh_reason = spec["previous_output_reason"]
    fresh = fresh_reason is not None
    inputs: dict[str, dict] = {}
    new_state: dict[str, dict] = {}
    added: dict[str, int] = {}
    modifications: dict[str, str] = {}
    work.mkdir(parents=True, exist_ok=True)
    for name in t["inputs"]:
        entry: dict[str, Any] = {}
        seen = seen_inputs.get(name) or {}
        if name in (spec.get("inputs") or {}):
            parquet = spec["inputs"][name]
            columns, rows = _read_table(parquet)
            mod, schema_mod, processed = _plan_frame(seen.get("frame"), columns, rows, fresh, j["ignore_incremental_deletes"], j["use_schema_modification_type"])
            data = work / f"in-{len(inputs)}.json"
            data.write_text(json.dumps({"columns": columns, "rows": rows}, default=_json_default), "utf-8")
            file_name = spec.get("input_names", {}).get(name) or Path(parquet).name
            sigs = {file_name: _rows_hash(rows)}
            files = {file_name: parquet}
            entry.update(data=str(data), modification=mod, schema_modification=schema_mod, processed=processed)
            new_state[name] = {"frame": {"rows": len(rows), "hash": _rows_hash(rows), "columns": columns}, "files": sigs}
            added[name] = len(rows) - processed
            modifications[name] = mod + (" (new schema)" if schema_mod == "NEW_SCHEMA" else "")
        else:
            items = ((spec.get("media_inputs") or {}).get(name) or {}).get("items") or []
            files = {i["path"]: i["file"] for i in items}
            sigs = {i["path"]: f"{i.get('updated_at')}:{i.get('size')}" for i in items}
            new_state[name] = {"files": sigs}
            modifications[name] = "files"
        fmod, processed_files = _plan_files(seen.get("files"), sigs, fresh, j["ignore_incremental_deletes"])
        if "data" not in entry:
            modifications[name] = fmod
            added[name] = len(sigs) - len(processed_files)
        entry.update(files=files, processed_files=processed_files, files_modification=fmod)
        inputs[name] = entry
    outputs = {param: str(work / f"out-{i}") for i, param in enumerate(t["outputs"])}
    timeout = j.get("max_duration_s") or TIMEOUT
    res, logs = _java(MAIN, "build", {"classes": info["class_names"], "transform": j, "inputs": inputs, "outputs": outputs,
                                      "parameters": spec.get("parameters") or {}, "api_url": spec.get("api_url", ""),
                                      "api_token": spec.get("api_token", ""), "cores": 2},
                      _cp(info["classes"], info["deps"], api_classes(), spark_jars() / "*"), timeout=timeout, cwd=work)
    if not res.get("ok"):
        raise RuntimeError((res.get("error") or "the Java transform failed") + (f"\n\n{logs[-3000:]}" if logs else ""))
    loaded = res.get("loaded") or {}
    out: dict[str, dict] = {}
    for param, w in loaded.items():
        if w["kind"] == "dataframe":
            df = w["frame"]
            prev = (spec.get("previous_outputs") or {}).get(param)
            appended = w["mode"] == "UPDATE"
            if appended and prev:
                df = pd.concat([pd.read_parquet(prev), df], ignore_index=True)
            out[param] = {"kind": "dataframe", "mode": w["mode"], "frame": df, "written": w["rows"]}
        else:
            out[param] = {"kind": "files", "mode": w["mode"], "files": w["files"]}
    missing = [p for p in t["outputs"] if p not in out]
    if missing:
        logs += f"\nNothing was written to {', '.join(missing)}: those outputs keep their last build."
    any_update = any(o["mode"] == "UPDATE" for o in out.values())
    incremental = {"mode": "incremental" if any_update and not fresh else "snapshot", "reason": fresh_reason if fresh else (None if any_update else "every output was written as a SNAPSHOT"),
                   "output_mode": "modify" if any_update else "replace", "semantic_version": 1, "added_rows": added,
                   "modification_types": modifications,
                   "written_rows": next((o.get("written") for o in out.values() if o["kind"] == "dataframe"), None),
                   "state": {"semantic_version": 1, "inputs": new_state}}
    return {"outputs": out, "incremental": incremental, "logs": logs}


def _arrow_for(kind: str):
    import pyarrow as pa

    return {"Boolean": pa.bool_(), "Byte": pa.int8(), "Short": pa.int16(), "Integer": pa.int32(), "Long": pa.int64(), "Float": pa.float32(),
            "Double": pa.float64(), "Decimal": pa.decimal128(38, 18), "Date": pa.date32(), "Timestamp": pa.timestamp("us", tz="UTC")}.get(kind, pa.string())


def _typed(v: Any, kind: str) -> Any:
    if v is None:
        return None
    if kind == "Date":
        return date.fromisoformat(str(v)[:10])
    if kind == "Timestamp":
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    if kind == "Decimal":
        return Decimal(str(v))
    return v


def frame_of(columns: list[dict], rows: list[dict]):
    """A pandas DataFrame with the columns' types (through Arrow)."""
    import pyarrow as pa

    schema = pa.schema([(c["name"], _arrow_for(c["type"])) for c in columns])
    data = {c["name"]: [_typed(r.get(c["name"]), c["type"]) for r in rows] for c in columns}
    return pa.table(data, schema=schema).to_pandas()


def _load_outputs(written: dict) -> dict:
    out = {}
    for param, w in written.items():
        if w["kind"] == "dataframe":
            data = json.loads(Path(w["data"]).read_text("utf-8"))
            out[param] = {"kind": "dataframe", "mode": w["mode"], "rows": w["rows"], "frame": frame_of(data["columns"], data["rows"])}
        else:
            d = Path(w["dir"])
            files = []
            if d.is_dir():
                for f in sorted(d.rglob("*")):
                    if f.is_file():
                        files.append({"path": f.relative_to(d).as_posix(), "data": f.read_bytes(), "size": f.stat().st_size})
            out[param] = {"kind": "files", "mode": w["mode"], "files": files}
    return out


# ------------------------------------------------------------------------------------------------
# tests
# ------------------------------------------------------------------------------------------------


def run_tests(repo: Path, only: Optional[str] = None) -> list[dict]:
    """JUnit 5 / 4 tests in src/test/java (with AssertJ and Mockito, and a local SparkSession through
    SparkSessionExtension or SparkSessionResource), plus the examples of the repository's UDFs."""
    _, test_src = java_files(repo)
    if not test_src and not udf_definition_files(repo):
        return []
    try:
        info = compile_project(repo, tests=True)
    except ValueError as e:
        return [{"file": (test_src or [repo])[0].relative_to(repo).as_posix() if test_src else "", "name": "compile", "line": 1, "ok": False, "error": str(e)}]
    results: list[dict] = []
    cp = _cp(info["test_classes"], info["classes"], info["deps"], api_classes(), spark_jars() / "*", _test_jars())
    if info["test_class_names"] and any("@Test" in p.read_text("utf-8", errors="replace") for p in test_src):
        with tempfile.TemporaryDirectory(prefix="junit-") as tmp:
            reports = Path(tmp) / "reports"
            # the launcher runs on the JVM class path (which expands Spark's jars/*), not its own --class-path
            args = [_bin("java"), *JVM_FLAGS, f"-Dlog4j2.configurationFile={_log_config().as_uri()}", f"-Djava.io.tmpdir={tmp}",
                    "-cp", cp, "org.junit.platform.console.ConsoleLauncher", "execute", "--disable-banner", "--details=none",
                    "--reports-dir", str(reports)]
            if only and only.endswith(".java"):
                cls = _class_of(repo / only)
                args += ["--select-class", cls] if cls else ["--scan-class-path", str(info["test_classes"])]
            else:
                args += ["--scan-class-path", str(info["test_classes"])]
            try:
                p = subprocess.run(args, capture_output=True, text=True, timeout=TIMEOUT, encoding="utf-8", errors="replace", cwd=tmp,
                                   env={**os.environ, "SPARK_LOCAL_IP": "127.0.0.1"})
                console = _clean((p.stdout or "") + (p.stderr or ""), Path(tmp))
            except subprocess.TimeoutExpired:
                return [{"file": "", "name": "tests", "line": 1, "ok": False, "error": f"the tests ran longer than {TIMEOUT} s"}]
            for xml in sorted(reports.glob("*.xml")):
                for case in ET.parse(xml).getroot().iter("testcase"):
                    cls = case.get("classname") or ""
                    rel = info["sources"].get(cls.split("$")[0], cls.replace(".", "/") + ".java")
                    bad = case.find("failure") if case.find("failure") is not None else case.find("error")
                    skipped = case.find("skipped") is not None
                    name = re.sub(r"\(\)$", "", case.get("name") or "")
                    line = 1
                    try:
                        src = (repo / rel).read_text("utf-8")
                        m = re.search(rf"\b{re.escape(name)}\s*\(", src)
                        line = src.count("\n", 0, m.start()) + 1 if m else 1
                    except OSError:
                        pass
                    out = (case.findtext("system-out") or "") + (case.findtext("system-err") or "")
                    results.append({"file": rel, "name": name, "line": line, "ok": bad is None, "skipped": skipped,
                                    "error": None if bad is None else ((bad.get("message") or "") + "\n" + (bad.text or ""))[:3000].strip(),
                                    "ms": int(float(case.get("time") or 0) * 1000), "output": out[-2000:]})
            if not results and p.returncode not in (0, 1):
                results.append({"file": "", "name": "tests", "line": 1, "ok": False, "error": console[-3000:]})
    if info["udfs"]:
        try:
            for e in udf_examples(repo, info):
                rel = info["sources"].get(e["class"], e["class"].replace(".", "/") + ".java")
                results.append({"file": rel, "name": f"example {e['udf']} · {e['id']}", "line": 1, "ok": e["ok"], "error": e.get("error"), "ms": 0,
                                "output": json.dumps({"expected": e["expected"], "actual": e.get("actual")}, default=str)[:2000],
                                # shown with the UDF in Pipeline Builder
                                "example": {k: e.get(k) for k in ("udf", "id", "description", "visibility", "category", "configuration", "input", "expected")}})
        except Exception as ex:  # noqa: BLE001
            results.append({"file": "", "name": "UDF examples", "line": 1, "ok": False, "error": str(ex)[:3000]})
    if only and not only.endswith(".java"):
        results = [r for r in results if r["file"] == only]
    return results


# ------------------------------------------------------------------------------------------------
# user-defined functions: definitions and code generation
# ------------------------------------------------------------------------------------------------


def udf_definition_files(repo: Path) -> list[Path]:
    return sorted(p for p in repo.rglob("*") if p.is_file() and is_udf_definition(p.relative_to(repo).as_posix()))


def camel(name: str) -> str:
    parts = re.split(r"[_\-\s]+", name.strip())
    return parts[0][:1].lower() + parts[0][1:] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def pascal(name: str) -> str:
    c = camel(name)
    return c[:1].upper() + c[1:]


UDF_TYPES = {"DEFAULT": "map", "FLAT_MAP_UDF": "flat_map", "KEYED_PROCESS_UDF": "keyed_process", "ASYNC_DEPLOYED_APP_UDF": "async", "ASYNC_CUSTOM_UDF": "async"}
UDF_SUFFIX = {"map": "MapUdf", "flat_map": "FlatMapUdf", "keyed_process": "KeyedProcessUdf"}
# event time columns: timestamps, ISO text or epoch numbers (milliseconds from 1e11, else seconds)
EVENT_TIME_TYPES = {"timestamp", "date", "string", "long", "integer", "double"}
# field type -> (Java type, conversion of a row value; {} is the value)
SCALARS = {"string": ("String", "Values.toStr({})"), "boolean": ("Boolean", "Values.toBoolean({})"), "byte": ("Byte", "Values.toByte({})"),
           "short": ("Short", "Values.toShort({})"), "integer": ("Integer", "Values.toInteger({})"), "long": ("Long", "Values.toLong({})"),
           "float": ("Float", "Values.toFloat({})"), "double": ("Double", "Values.toDouble({})"), "decimal": ("BigDecimal", "Values.toDecimal({})"),
           "date": ("LocalDate", "Values.toDate({})"), "timestamp": ("Instant", "Values.toTimestamp({})"), "binary": ("byte[]", "Values.toBinary({})")}
COLUMN_TYPE = {"string": "String", "boolean": "Boolean", "byte": "Byte", "short": "Short", "integer": "Integer", "long": "Long", "float": "Float",
               "double": "Double", "decimal": "Decimal", "date": "Date", "timestamp": "Timestamp"}


def is_udf_definition(rel: str) -> bool:
    return rel.endswith((".yml", ".yaml")) and "src/main/resources/udfs/definitions/" in "/" + rel


def udf_definitions(repo: Path) -> list[dict]:
    return parse_udf_definitions({p.relative_to(repo).as_posix(): p.read_text("utf-8") for p in udf_definition_files(repo)})


def parse_udf_definitions(files: dict[str, str]) -> list[dict]:
    """Parsed UDF definitions (of a repository's files, path -> text): {name, file, type (map | flat_map | keyed_process),
    description, input / output schemas, arguments, package, factory_interface, config_class}; keyed process UDFs also
    key_columns, event_time_column and state_schema."""
    import yaml

    out = []
    for rel, text in sorted(files.items()):
        if not is_udf_definition(rel):
            continue
        try:
            d = yaml.safe_load(text) or {}
        except yaml.YAMLError as e:
            raise ValueError(f"{rel}: not valid YAML: {e}") from None
        for k in ("name", "inputSchema", "outputSchema"):
            if k not in d:
                raise ValueError(f"{rel}: the UDF definition needs `{k}`")
        name = str(d["name"])
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name):
            raise ValueError(f"{rel}: name must be letters, digits and underscores, starting with a letter")
        kind = UDF_TYPES.get(str(d.get("type") or "DEFAULT"))
        if kind is None:
            raise ValueError(f"{rel}: type must be DEFAULT, FLAT_MAP_UDF, KEYED_PROCESS_UDF, ASYNC_DEPLOYED_APP_UDF or ASYNC_CUSTOM_UDF")
        keyed = _keyed_settings(rel, d, kind)
        if kind == "async":
            raise ValueError(f"{rel}: async UDFs are not supported (as in Pipeline Builder)")
        pkg = f"com.palantir.foundry.{name.lower()}"
        base = pascal(name)
        suffix = UDF_SUFFIX[kind]
        out.append({
            **keyed,
            "name": name, "file": rel, "type": kind, "description": d.get("description") or "",
            "input_schema": d["inputSchema"], "output_schema": d["outputSchema"], "arguments": d.get("arguments") or {},
            "custom_types": ((d.get("customTypes") or {}).get("types") or {}),
            "package": pkg, "factory_interface": f"{pkg}.{base}{suffix}Factory", "config_class": f"{pkg}.config.{base}Configuration",
            "udf_interface": f"{pkg}.{base}{suffix}",
        })
    names = [u["name"] for u in out]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise ValueError(f"two UDF definitions are named {', '.join(dupes)}")
    return out


def _keyed_settings(rel: str, d: dict, kind: str) -> dict:
    """keyColumns, eventTimeColumn and stateSchema of a KEYED_PROCESS_UDF (and only of one)."""
    keys, event, state = d.get("keyColumns"), d.get("eventTimeColumn"), d.get("stateSchema")
    if kind != "keyed_process":
        if keys is not None or event is not None or state is not None:
            raise ValueError(f"{rel}: keyColumns, eventTimeColumn and stateSchema are for keyed process UDFs (type: KEYED_PROCESS_UDF)")
        return {}
    fields = {f.get("name"): ((f.get("type") or {}).get("type")) for f in (d["inputSchema"] or {}).get("fields") or []}
    if not isinstance(keys, list) or not keys or not all(isinstance(k, str) for k in keys):
        raise ValueError(f"{rel}: a keyed process UDF needs keyColumns: a list of input columns its records are partitioned by")
    missing = [k for k in keys if k not in fields]
    if missing:
        raise ValueError(f"{rel}: keyColumns {', '.join(missing)} are not fields of the input schema")
    if event is not None:
        if not isinstance(event, str) or event not in fields:
            raise ValueError(f"{rel}: eventTimeColumn must be a field of the input schema")
        if fields[event] not in EVENT_TIME_TYPES:
            raise ValueError(f"{rel}: eventTimeColumn {event} must be a timestamp, date, string or number field, not {fields[event]}")
    if not isinstance(state, dict) or not isinstance(state.get("fields"), list) or not state["fields"]:
        raise ValueError(f"{rel}: a keyed process UDF needs stateSchema (name, fields): the state it keeps per key")
    return {"key_columns": keys, "event_time_column": event, "state_schema": state}


def column_type(ft: dict, custom: dict) -> str:
    """The Pipeline Builder column type of a UDF field type (arrays, maps and structs travel as JSON text)."""
    t = (ft or {}).get("type")
    if t == "custom":
        target = custom.get(ft.get("custom"))
        return column_type(target, custom) if target else "String"
    return COLUMN_TYPE.get(t, "String")


class _Gen:
    """Generates the typed classes of one UDF definition."""

    def __init__(self, d: dict):
        self.d = d
        self.pkg = d["package"]
        self.custom = d["custom_types"]
        self.files: dict[str, str] = {}
        self.structs: dict[str, str] = {}

    def java_type(self, ft: dict, hint: str, depth: int = 0) -> tuple[str, str]:
        """(Java type, conversion template of a row value: {} stands for the value) for a field type."""
        t = (ft or {}).get("type")
        if t in SCALARS:
            return SCALARS[t]
        x, k = f"x{depth}", f"k{depth}"
        if t == "array":
            el = (ft.get("array") or {}).get("elementType") or {}
            jt, conv = self.java_type(el, hint + "Element", depth + 1)
            return f"List<{jt}>", "Values.toList({}, " + x + " -> " + conv.replace("{}", x) + ")"
        if t == "map":
            m = ft.get("map") or {}
            kt, kc = self.java_type(m.get("keyType") or {}, hint + "Key", depth + 1)
            vt, vc = self.java_type(m.get("valueType") or {}, hint + "Value", depth + 1)
            return f"Map<{kt}, {vt}>", "Values.toMap({}, " + k + " -> " + kc.replace("{}", k) + ", " + x + " -> " + vc.replace("{}", x) + ")"
        if t == "struct":
            cls = self.struct(pascal(hint), (ft.get("struct") or {}).get("fields") or [])
            return f"{self.pkg}.types.{cls}", f"{self.pkg}.types.{cls}.fromValue({{}})"
        if t == "custom":
            name = ft.get("custom")
            target = self.custom.get(name)
            if target is None:
                raise ValueError(f"{self.d['file']}: unknown custom type {name}")
            if target.get("type") == "struct":
                cls = self.struct(pascal(name), (target.get("struct") or {}).get("fields") or [])
                return f"{self.pkg}.types.{cls}", f"{self.pkg}.types.{cls}.fromValue({{}})"
            return self.java_type(target, name, depth)
        raise ValueError(f"{self.d['file']}: unknown field type {t!r}")

    def conv(self, template: str, expr: str) -> str:
        return template.replace("{}", expr)

    def struct(self, cls: str, fields: list[dict]) -> str:
        if cls not in self.structs:
            self.structs[cls] = ""
            self.structs[cls] = self.row_class(f"{self.pkg}.types", cls, fields, setters=True, create=True)
            self.files[f"{self.pkg.replace('.', '/')}/types/{cls}.java"] = self.structs[cls]
        return cls

    def row_class(self, pkg: str, cls: str, fields: list[dict], setters: bool, create: bool, extra_doc: str = "") -> str:
        members, getters, sets, reads, writes = [], [], [], [], []
        for f in fields:
            fname = f["name"]
            jn = camel(fname)
            jt, conv = self.java_type(f.get("type") or {}, cls + pascal(fname))
            nullable = bool(f.get("nullable", True))
            members.append(f"    private {jt} {jn};")
            getters.append(f"    public {jt} {jn}() {{\n        return {jn};\n    }}")
            if setters:
                sets.append(f"    public {cls} {jn}({jt} value) {{\n        this.{jn} = value;\n        return this;\n    }}")
            check = "" if nullable else f'\n        if (o.{jn} == null) throw new IllegalArgumentException("{fname} is not nullable but the row has no value for it");'
            got = 'm.get("' + fname + '")'
            reads.append(f"        o.{jn} = {self.conv(conv, got)};{check}")
            wcheck = "" if nullable else f'\n        if ({jn} == null) throw new IllegalStateException("{cls}.{fname} is not nullable but was not set");'
            writes.append(f'{wcheck}\n        m.put("{fname}", Values.plain({jn}));')
        create_m = f"\n    public static {cls} create(RowBuilderFactory factory) {{\n        return new {cls}();\n    }}\n" if create else ""
        return f"""package {pkg};

import com.palantir.foundry.udf.api.RowBuilderFactory;
import com.palantir.foundry.udf.api.Struct;
import com.palantir.foundry.udf.api.Values;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Generated from {self.d['file']}{extra_doc}. Do not edit: change the definition and run generateUdfResources. */
public final class {cls} implements Struct {{
{chr(10).join(members)}

    private {cls}() {{}}
{create_m}
{chr(10).join(getters)}

{chr(10).join(sets)}

    public static {cls} fromMap(Map<String, Object> m) {{
        {cls} o = new {cls}();
{chr(10).join(reads)}
        return o;
    }}

    public static {cls} fromValue(Object v) {{
        return v == null ? null : fromMap(Values.toRow(v));
    }}

    @Override
    public Map<String, Object> toMap() {{
        Map<String, Object> m = new LinkedHashMap<>();{''.join(writes)}
        return m;
    }}

    @Override
    public boolean equals(Object o) {{
        return o instanceof {cls} && toMap().equals((({cls}) o).toMap());
    }}

    @Override
    public int hashCode() {{
        return toMap().hashCode();
    }}

    @Override
    public String toString() {{
        return "{cls}" + toMap();
    }}
}}
"""

    def config(self) -> str:
        base = pascal(self.d["name"])
        cls = f"{base}Configuration"
        members, getters, sets, reads, writes = [], [], [], [], []
        for aname, a in self.d["arguments"].items():
            jn = camel(aname)
            jt, conv = self.java_type((a or {}).get("type") or {"type": "string"}, cls + pascal(aname))
            req = bool((a or {}).get("required", False))
            members.append(f"    private {jt} {jn};")
            getters.append(f"    public {jt} {jn}() {{\n        return {jn};\n    }}")
            sets.append(f"        public Builder {jn}({jt} value) {{\n            c.{jn} = value;\n            return this;\n        }}")
            check = f'\n        if (c.{jn} == null) throw new IllegalArgumentException("argument {aname} is required");' if req else ""
            got = 'm.get("' + aname + '")'
            reads.append(f"        c.{jn} = {self.conv(conv, got)};{check}")
            writes.append(f'\n        m.put("{aname}", Values.plain({jn}));')
        required = [camel(n) for n, a in self.d["arguments"].items() if (a or {}).get("required")]
        build_checks = "".join(f'\n            if (c.{r} == null) throw new IllegalStateException("argument {r} is required");' for r in required)
        return f"""package {self.pkg}.config;

import com.palantir.foundry.udf.api.Struct;
import com.palantir.foundry.udf.api.Values;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The arguments of {self.d['name']} (generated from {self.d['file']}). */
public final class {cls} implements Struct {{
{chr(10).join(members)}

    private {cls}() {{}}

{chr(10).join(getters)}

    public static Builder builder() {{
        return new Builder();
    }}

    public static final class Builder {{
        private final {cls} c = new {cls}();

{chr(10).join(sets)}

        public {cls} build() {{{build_checks}
            return c;
        }}
    }}

    public static {cls} fromMap(Map<String, Object> m) {{
        {cls} c = new {cls}();
{chr(10).join(reads)}
        return c;
    }}

    @Override
    public Map<String, Object> toMap() {{
        Map<String, Object> m = new LinkedHashMap<>();{''.join(writes)}
        return m;
    }}
}}
"""

    def generate(self) -> dict[str, str]:
        d = self.d
        base = pascal(d["name"])
        path = self.pkg.replace(".", "/")
        ins, outs = d["input_schema"], d["output_schema"]
        in_cls, out_cls = pascal(ins.get("name") or "Input"), pascal(outs.get("name") or "Output")
        in_fields, out_fields = ins.get("fields") or [], outs.get("fields") or []
        self.files[f"{path}/input/{in_cls}.java"] = self.row_class(f"{self.pkg}.input", in_cls, in_fields, setters=False, create=False, extra_doc=" (input rows)")
        self.files[f"{path}/input/Settable{in_cls}.java"] = self.row_class(f"{self.pkg}.input", f"Settable{in_cls}", in_fields, setters=True, create=True,
                                                                            extra_doc=" (input rows you set, for examples and tests)")
        self.files[f"{path}/output/{out_cls}.java"] = self.row_class(f"{self.pkg}.output", out_cls, out_fields, setters=True, create=True, extra_doc=" (output rows)")
        self.files[f"{path}/config/{base}Configuration.java"] = self.config()
        imports = f"import {self.pkg}.config.{base}Configuration;\nimport {self.pkg}.input.{in_cls};\nimport {self.pkg}.output.{out_cls};\nimport java.util.Map;\n"
        if d["type"] == "map":
            self.files[f"{path}/{base}MapUdf.java"] = f"""package {self.pkg};

import com.palantir.foundry.udf.api.FoundryRowMapUdf;
{imports}
/** {d['name']}: one {in_cls} row in, one {out_cls} row out. Implement it in {base}MapUdfImpl. */
public interface {base}MapUdf {{
    {out_cls} map(FoundryRowMapUdf.Context ctx, {in_cls} input) throws Exception;
}}
"""
            self.files[f"{path}/{base}MapUdfFactory.java"] = f"""package {self.pkg};

import com.palantir.foundry.udf.api.FoundryRowMapUdfFactory;
import {self.pkg}.config.{base}Configuration;

/** Implement it in {base}MapUdfFactoryImpl (public, no-argument constructor): create() returns new {base}MapUdfAdapter(impl). */
public interface {base}MapUdfFactory extends FoundryRowMapUdfFactory<{base}Configuration> {{}}
"""
            self.files[f"{path}/{base}MapUdfAdapter.java"] = f"""package {self.pkg};

import com.palantir.foundry.udf.api.FoundryRowMapUdf;
{imports}
/** Runs a {base}MapUdf on plain rows. */
public final class {base}MapUdfAdapter implements FoundryRowMapUdf {{
    private final {base}MapUdf impl;

    public {base}MapUdfAdapter({base}MapUdf impl) {{
        this.impl = impl;
    }}

    @Override
    public Map<String, Object> map(Context ctx, Map<String, Object> row) throws Exception {{
        {out_cls} out = impl.map(ctx, {in_cls}.fromMap(row));
        if (out == null) throw new IllegalStateException("{d['name']} returned no row: a row map UDF outputs exactly one row per input");
        return out.toMap();
    }}
}}
"""
        elif d["type"] == "keyed_process":
            self.keyed_process(path, base, in_cls, out_cls, imports)
        else:
            self.files[f"{path}/{base}FlatMapUdf.java"] = f"""package {self.pkg};

import com.palantir.foundry.udf.api.flatmap.Collector;
import com.palantir.foundry.udf.api.flatmap.FoundryRowFlatMapUdf;
{imports}
/** {d['name']}: one {in_cls} row in, any number of {out_cls} rows out (collect them). Implement it in {base}FlatMapUdfImpl. */
public interface {base}FlatMapUdf {{
    interface Context extends FoundryRowFlatMapUdf.Context {{}}

    void flatMap(Context ctx, {in_cls} input, Collector<{out_cls}> out) throws Exception;
}}
"""
            self.files[f"{path}/{base}FlatMapUdfFactory.java"] = f"""package {self.pkg};

import com.palantir.foundry.udf.api.flatmap.FoundryRowFlatMapUdfFactory;
import {self.pkg}.config.{base}Configuration;

/** Implement it in {base}FlatMapUdfFactoryImpl (public, no-argument constructor): create() returns new {base}FlatMapUdfAdapter(impl). */
public interface {base}FlatMapUdfFactory extends FoundryRowFlatMapUdfFactory<{base}Configuration> {{}}
"""
            self.files[f"{path}/{base}FlatMapUdfAdapter.java"] = f"""package {self.pkg};

import com.palantir.foundry.udf.api.flatmap.Collector;
import com.palantir.foundry.udf.api.flatmap.FoundryRowFlatMapUdf;
{imports}
/** Runs a {base}FlatMapUdf on plain rows. */
public final class {base}FlatMapUdfAdapter implements FoundryRowFlatMapUdf {{
    private final {base}FlatMapUdf impl;

    public {base}FlatMapUdfAdapter({base}FlatMapUdf impl) {{
        this.impl = impl;
    }}

    @Override
    public void flatMap(FoundryRowFlatMapUdf.Context ctx, Map<String, Object> row, Collector<Map<String, Object>> out) throws Exception {{
        impl.flatMap(ctx::getRowBuilderFactory, {in_cls}.fromMap(row), r -> out.collect(r.toMap()));
    }}
}}
"""
        return self.files


    def keyed_process(self, path: str, base: str, in_cls: str, out_cls: str, imports: str) -> None:
        d = self.d
        st = d["state_schema"]
        st_cls = pascal(st.get("name") or f"{base}State")
        self.files[f"{path}/state/{st_cls}.java"] = self.row_class(f"{self.pkg}.state", st_cls, st["fields"], setters=True, create=True, extra_doc=" (the state kept per key)")
        keyed_imports = f"""import com.palantir.foundry.udf.api.RowBuilderFactory;
import com.palantir.foundry.udf.api.flatmap.Collector;
import com.palantir.foundry.udf.api.keyed.FoundryKeyedProcessUdf;
import com.palantir.foundry.udf.api.keyed.TimeDomain;
import com.palantir.foundry.udf.api.keyed.TimerService;
import {self.pkg}.state.{st_cls};
import java.time.Instant;
import java.util.List;
{imports}"""
        keys = ", ".join(d["key_columns"])
        event = f"; event time {d['event_time_column']}" if d.get("event_time_column") else ""
        self.files[f"{path}/{base}KeyedProcessUdf.java"] = f"""package {self.pkg};

{keyed_imports}
/**
 * {d['name']}: {in_cls} records partitioned by {keys}{event}. Each call sees the {st_cls} and the timers of its
 * record's key; it collects any number of {out_cls} rows, also from onTimer. Implement it in {base}KeyedProcessUdfImpl.
 */
public interface {base}KeyedProcessUdf {{
    interface Context {{
        RowBuilderFactory getRowBuilderFactory();

        /** the values of {keys} */
        List<Object> currentKey();

        /** the record's event time; null in a processing-time timer (or without an event time column) */
        Instant eventTime();

        TimerService timerService();

        /** this key's state; null until updateState */
        {st_cls} getState();

        void updateState({st_cls} state);

        void clearState();
    }}

    interface OnTimerContext extends Context {{
        Instant timestamp();

        TimeDomain timeDomain();
    }}

    void processElement(Context ctx, {in_cls} input, Collector<{out_cls}> out) throws Exception;

    default void onTimer(OnTimerContext ctx, Collector<{out_cls}> out) throws Exception {{}}
}}
"""
        self.files[f"{path}/{base}KeyedProcessUdfFactory.java"] = f"""package {self.pkg};

import com.palantir.foundry.udf.api.keyed.FoundryKeyedProcessUdfFactory;
import {self.pkg}.config.{base}Configuration;

/** Implement it in {base}KeyedProcessUdfFactoryImpl (public, no-argument constructor): create() returns new {base}KeyedProcessUdfAdapter(impl). */
public interface {base}KeyedProcessUdfFactory extends FoundryKeyedProcessUdfFactory<{base}Configuration> {{}}
"""
        self.files[f"{path}/{base}KeyedProcessUdfAdapter.java"] = f"""package {self.pkg};

{keyed_imports}
/** Runs a {base}KeyedProcessUdf on plain rows and plain keyed state. */
public final class {base}KeyedProcessUdfAdapter implements FoundryKeyedProcessUdf {{
    private final {base}KeyedProcessUdf impl;

    public {base}KeyedProcessUdfAdapter({base}KeyedProcessUdf impl) {{
        this.impl = impl;
    }}

    private static {base}KeyedProcessUdf.OnTimerContext typed(FoundryKeyedProcessUdf.Context c) {{
        return new {base}KeyedProcessUdf.OnTimerContext() {{
            public RowBuilderFactory getRowBuilderFactory() {{
                return c.getRowBuilderFactory();
            }}

            public List<Object> currentKey() {{
                return c.currentKey();
            }}

            public Instant eventTime() {{
                return c.eventTime();
            }}

            public TimerService timerService() {{
                return c.timerService();
            }}

            public {st_cls} getState() {{
                Map<String, Object> m = c.state().get();
                return m == null ? null : {st_cls}.fromMap(m);
            }}

            public void updateState({st_cls} state) {{
                if (state == null) c.state().clear();
                else c.state().set(state.toMap());
            }}

            public void clearState() {{
                c.state().clear();
            }}

            public Instant timestamp() {{
                return ((FoundryKeyedProcessUdf.OnTimerContext) c).timestamp();
            }}

            public TimeDomain timeDomain() {{
                return ((FoundryKeyedProcessUdf.OnTimerContext) c).timeDomain();
            }}
        }};
    }}

    @Override
    public void processElement(Context ctx, Map<String, Object> row, Collector<Map<String, Object>> out) throws Exception {{
        impl.processElement(typed(ctx), {in_cls}.fromMap(row), r -> out.collect(r.toMap()));
    }}

    @Override
    public void onTimer(OnTimerContext ctx, Collector<Map<String, Object>> out) throws Exception {{
        impl.onTimer(typed(ctx), r -> out.collect(r.toMap()));
    }}
}}
"""


def generate_udfs(defs: list[dict]) -> dict[str, str]:
    """Generated Java sources (path -> text) for every UDF definition."""
    out: dict[str, str] = {}
    for d in defs:
        out.update(_Gen(d).generate())
    return out


def _udf_spec(defs: list[dict]) -> list[dict]:
    return [{"name": d["name"], "type": d["type"], "factory_interface": d["factory_interface"], "config_class": d["config_class"],
             "key_columns": d.get("key_columns") or [], "event_time_column": d.get("event_time_column")} for d in defs]


def udf_check(repo: Path, info: Optional[dict] = None) -> tuple[list[str], str]:
    info = info or compile_project(repo)
    if not info["udfs"]:
        return [], ""
    res, logs = _java(UDF_MAIN, "check", {"classes": info["class_names"], "udfs": _udf_spec(info["udfs"])}, _cp(info["classes"], info["deps"], api_classes(), spark_jars() / "*"), timeout=120)
    if not res.get("ok"):
        return [f"{info['udfs'][0]['name']}: {res.get('error')}"], logs
    return res.get("problems") or [], logs


def udf_examples(repo: Path, info: Optional[dict] = None) -> list[dict]:
    info = info or compile_project(repo, tests=True)
    if not info["udfs"]:
        return []
    names = info["class_names"] + info.get("test_class_names", [])
    res, logs = _java(UDF_MAIN, "examples", {"classes": names, "udfs": _udf_spec(info["udfs"])},
                      _cp(info["test_classes"] if info.get("test_class_names") else None, info["classes"], info["deps"], api_classes(), spark_jars() / "*", _test_jars()), timeout=240)
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or logs[-3000:])
    return res.get("examples") or []


def udf_run(repo: Path, name: str, config: dict, rows: list[dict], keyed: Optional[dict] = None, bounded: bool = True) -> tuple[list[dict], str]:
    """The rows a UDF outputs (a keyed process UDF runs as a batch here: see udf_process)."""
    rows, _keyed, logs = udf_process(repo, name, config, rows, keyed, bounded)
    return rows, logs


def udf_process(repo: Path, name: str, config: dict, rows: list[dict], keyed: Optional[dict] = None, bounded: bool = True) -> tuple[list[dict], Optional[dict], str]:
    """(rows, keyed state, logs) of a UDF over rows. Keyed process UDFs start from `keyed` ({state, timers, watermark};
    none: empty) and `bounded` fires every remaining event-time timer at the end (a batch build); a streaming job passes
    bounded=False and keeps the returned keyed state for the next micro-batch. Other UDFs return None for it."""
    info = compile_project(repo)
    d = next((u for u in info["udfs"] if u["name"] == name), None)
    if not d:
        raise ValueError(f"no UDF {name} in this version")
    fields = [f["name"] for f in d["input_schema"].get("fields") or []]
    missing = [f for f in fields if rows and f not in rows[0]]
    if missing:
        raise ValueError(f"{name} needs the input columns {', '.join(missing)}")
    selected = [{f: r.get(f) for f in fields} for r in rows]
    spec = {"classes": info["class_names"], "udfs": _udf_spec(info["udfs"]), "udf": name, "config": config, "rows": selected}
    if d["type"] == "keyed_process":
        spec.update(keyed=keyed or {}, bounded=bounded, now=int(time.time() * 1000))
    res, logs = _java(UDF_MAIN, "run", spec, _cp(info["classes"], info["deps"], api_classes(), spark_jars() / "*"), timeout=TIMEOUT)
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or logs[-3000:])
    return res.get("rows") or [], res.get("keyed"), logs


def udf_columns(d: dict) -> list[dict]:
    return [{"name": f["name"], "type": column_type(f.get("type") or {}, d["custom_types"])} for f in d["output_schema"].get("fields") or []]
