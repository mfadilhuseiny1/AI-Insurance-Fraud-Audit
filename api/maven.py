"""Maven dependency resolution for Java transforms (doc 25 / 16: build.gradle `compile 'group:artifact:version'`).

A coordinate that is not shared code of another repository resolves from, in order:
  1. the Artifacts repositories in the repository's Settings → Artifacts (their Maven content, artifact_repos.py), and
  2. Maven Central (https://repo1.maven.org/maven2), unless BLUESANDAI_MAVEN_CENTRAL=off.

Its POM is read for the dependencies it brings (Gradle's transitive compile): compile and runtime scopes, optional
ones skipped, exclusions honoured, versions from properties, the parent chain and dependencyManagement (BOM imports
included); the nearest version of an artifact wins. Artifacts Spark already ships (the jars in pyspark's jars folder)
are not added again. Downloads from Maven Central are checked against the SHA-1 it publishes and cached in
.java/maven.
"""

from __future__ import annotations

import hashlib
import os
import re
import threading
import xml.etree.ElementTree as ET
from collections import deque
from pathlib import Path
from typing import Callable, Optional

CENTRAL = "https://repo1.maven.org/maven2"
MAX_ARTIFACTS = 300
_lock = threading.Lock()
_SKIP_SCOPES = {"test", "provided", "system", "import"}


class MavenError(Exception):
    pass


def central_enabled() -> bool:
    return os.environ.get("BLUESANDAI_MAVEN_CENTRAL", "on").lower() not in ("off", "0", "false", "no")


def _cache() -> Path:
    import code_java

    return code_java.ROOT / "maven"


def _path(group: str, artifact: str, version: str, ext: str, classifier: str = "") -> str:
    return f"{group.replace('.', '/')}/{artifact}/{version}/{artifact}-{version}{'-' + classifier if classifier else ''}.{ext}"


class Resolver:
    """Fetches files from the Artifacts repositories, then Maven Central (cached)."""

    def __init__(self, art_repos: list[str], central: Optional[bool] = None, fetch: Optional[Callable[[str], bytes]] = None) -> None:
        self.art_repos = art_repos
        self.central = central_enabled() if central is None else central
        self._fetch = fetch
        self._poms: dict[tuple[str, str, str], dict] = {}

    def file(self, rel: str) -> tuple[Optional[Path], str]:
        """(local path, where it came from) of a file in the Maven layout, or (None, why)."""
        import artifact_repos

        for rid in self.art_repos:
            try:
                p = artifact_repos.maven_file(rid, rel)
            except Exception:  # noqa: BLE001 - a repository the caller cannot see is skipped
                p = None
            if p:
                return p, rid
        if not self.central:
            return None, "not in the Artifacts repositories of Settings → Artifacts (Maven Central is off)"
        cached = _cache() / rel
        if cached.is_file():
            return cached, "Maven Central"
        try:
            data = self._download(f"{CENTRAL}/{rel}")
        except MavenError as e:
            return None, str(e)
        if data is None:
            return None, "not found in the Artifacts repositories or Maven Central"
        try:
            want = (self._download(f"{CENTRAL}/{rel}.sha1") or b"").decode("ascii", "replace").strip().split()
        except MavenError:
            want = []
        if want and hashlib.sha1(data).hexdigest() != want[0].lower():  # noqa: S324 - Maven Central's published checksum
            return None, f"checksum mismatch for {rel}"
        with _lock:
            cached.parent.mkdir(parents=True, exist_ok=True)
            tmp = cached.with_name(cached.name + ".part")
            tmp.write_bytes(data)
            os.replace(tmp, cached)
        return cached, "Maven Central"

    def _download(self, url: str) -> Optional[bytes]:
        if self._fetch:
            return self._fetch(url)
        import urllib.error
        import urllib.request

        last: Optional[Exception] = None
        for _ in range(3):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 - Maven Central over https
                    return r.read()
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                last = e
            except Exception as e:  # noqa: BLE001
                last = e
        raise MavenError(f"could not download {url}: {last}")

    # -- POMs ---------------------------------------------------------------------------------

    def pom(self, group: str, artifact: str, version: str, depth: int = 0) -> dict:
        key = (group, artifact, version)
        if key in self._poms:
            return self._poms[key]
        if depth > 12:
            raise MavenError(f"the parent chain of {group}:{artifact}:{version} is too deep")
        p, where = self.file(_path(group, artifact, version, "pom"))
        if p is None:
            info = {"packaging": "jar", "props": {}, "managed": {}, "deps": [], "missing": where}
            self._poms[key] = info
            return info
        try:
            root = ET.fromstring(p.read_bytes())
        except ET.ParseError as e:
            raise MavenError(f"{group}:{artifact}:{version}: the POM is not valid XML ({e})") from None
        for el in root.iter():
            if isinstance(el.tag, str) and "}" in el.tag:
                el.tag = el.tag.split("}", 1)[1]
        parent = root.find("parent")
        props: dict[str, str] = {}
        managed: dict[tuple[str, str], dict] = {}
        if parent is not None:
            pg, pa, pv = (parent.findtext(x, "").strip() for x in ("groupId", "artifactId", "version"))
            if pg and pa and pv:
                par = self.pom(pg, pa, pv, depth + 1)
                props.update(par["props"])
                managed.update(par["managed"])
                props.update({"project.parent.version": pv, "parent.version": pv, "project.parent.groupId": pg})
        g = root.findtext("groupId", "").strip() or (parent.findtext("groupId", "").strip() if parent is not None else group)
        v = root.findtext("version", "").strip() or (parent.findtext("version", "").strip() if parent is not None else version)
        props.update({"project.groupId": g, "project.artifactId": artifact, "project.version": v, "pom.version": v, "version": v, "groupId": g})
        for el in (root.find("properties") or []):
            if isinstance(el.tag, str):
                props[el.tag] = (el.text or "").strip()

        def sub(s: Optional[str]) -> str:
            s = (s or "").strip()
            for _ in range(10):
                n = re.sub(r"\$\{([^}]+)\}", lambda m: props.get(m.group(1), m.group(0)), s)
                if n == s:
                    break
                s = n
            return s

        for d in root.findall("dependencyManagement/dependencies/dependency"):
            dg, da, dv = sub(d.findtext("groupId")), sub(d.findtext("artifactId")), sub(d.findtext("version"))
            if sub(d.findtext("scope")) == "import" and sub(d.findtext("type")) == "pom" and dv:
                managed.update(self.pom(dg, da, dv, depth + 1)["managed"])
            elif dg and da:
                managed[(dg, da)] = {"version": dv, "scope": sub(d.findtext("scope"))}
        deps = []
        for d in root.findall("dependencies/dependency"):
            dg, da = sub(d.findtext("groupId")), sub(d.findtext("artifactId"))
            m = managed.get((dg, da)) or {}
            deps.append({"group": dg, "artifact": da, "version": sub(d.findtext("version")) or m.get("version", ""),
                         "scope": sub(d.findtext("scope")) or m.get("scope") or "compile", "optional": sub(d.findtext("optional")) == "true",
                         "type": sub(d.findtext("type")) or "jar", "classifier": sub(d.findtext("classifier")),
                         "exclusions": {(sub(x.findtext("groupId")), sub(x.findtext("artifactId"))) for x in d.findall("exclusions/exclusion")}})
        info = {"packaging": sub(root.findtext("packaging")) or "jar", "props": props, "managed": managed, "deps": deps, "missing": None}
        self._poms[key] = info
        return info

    # -- resolution ---------------------------------------------------------------------------

    def resolve(self, coords: list[str], provided: Optional[dict[str, str]] = None) -> tuple[dict[str, str], dict[str, str]]:
        """({coordinate: jar path} for the coordinates and what they depend on, {coordinate: why it failed}).
        `provided`: {artifact id: version} already on the classpath (Spark's jars): a dependency of the same major
        version is left to Spark's copy, another major version is added."""
        provided = provided or {}

        def shipped(artifact: str, version: str) -> bool:
            have = provided.get(artifact)
            return bool(have) and have.split(".")[0] == version.split(".")[0]

        jars: dict[str, str] = {}
        errors: dict[str, str] = {}
        chosen: dict[tuple[str, str], str] = {}
        # (group, artifact, version, classifier, exclusions, the build.gradle coordinate it comes from, is that coordinate)
        queue: deque[tuple[str, str, str, str, frozenset, str, bool]] = deque()
        for c in coords:
            parts = c.split(":")
            if len(parts) < 3:
                errors[c] = f"{c} is not group:artifact:version"
                continue
            queue.append((parts[0], parts[1], parts[2], parts[3] if len(parts) > 3 else "", frozenset(), c, True))
        while queue:
            group, artifact, version, classifier, excluded, origin, top = queue.popleft()
            if (group, artifact) in chosen:
                continue  # nearest wins
            label = f"{group}:{artifact}:{version}"

            def fail(why: str) -> None:
                errors.setdefault(origin, why if top else f"{origin}: its dependency {why}")

            if re.search(r"[\[\](),]", version) or version in ("+", "latest.release", "latest.integration") or version.endswith("+"):
                fail(f"{label}: version ranges and dynamic versions are not supported, pin a version")
                continue
            if not version:
                fail(f"{group}:{artifact}: no version (and none in a dependencyManagement)")
                continue
            chosen[(group, artifact)] = version
            if not top and shipped(artifact, version):
                continue
            try:
                pom = self.pom(group, artifact, version)
            except MavenError as e:
                fail(str(e))
                continue
            if pom["packaging"] not in ("pom",):
                ext = "jar" if pom["packaging"] in ("jar", "bundle", "maven-plugin", "") else pom["packaging"]
                p, where = self.file(_path(group, artifact, version, ext if ext in ("jar", "aar") else "jar", classifier))
                if p is None:
                    fail(f"{label}: {where}")
                    continue
                jars[origin if top else f"{origin}#{label}"] = str(p)
                if len(jars) > MAX_ARTIFACTS:
                    fail(f"more than {MAX_ARTIFACTS} artifacts: trim the dependencies")
                    break
            for d in pom["deps"]:
                if d["scope"] in _SKIP_SCOPES or d["optional"] or d["type"] not in ("jar", "bundle", ""):
                    continue
                if (d["group"], d["artifact"]) in excluded or (d["group"], "*") in excluded or ("*", "*") in excluded:
                    continue
                queue.append((d["group"], d["artifact"], d["version"], d["classifier"], excluded | d["exclusions"], origin, False))
        return jars, errors


def spark_provided() -> dict[str, str]:
    """{artifact id: version} of the jars Spark ships (pyspark/jars): spark-core_2.12-3.5.7.jar → spark-core_2.12."""
    import code_java

    try:
        folder = code_java.spark_jars()
    except Exception:  # noqa: BLE001
        folder = None
    out: dict[str, str] = {}
    for j in (folder.glob("*.jar") if folder else []):
        m = re.match(r"^(.+?)-(\d[\w.\-]*)\.jar$", j.name)
        if m:
            out[m.group(1)] = m.group(2)
    return out
