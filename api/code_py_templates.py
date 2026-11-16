"""Starting files of new Python repositories (Code Repositories' "Python" and "Python Library" templates),
laid out as in palantir.com/docs/foundry/transforms-python/project-structure.

TEMPLATE_VERSION is the template's version: repository upgrades (code_repos upgrade endpoints) bring a branch to it.
upgrade_files() says what an upgrade writes: files it overwrites (`ci.yml`, `settings.gradle`) and properties files it
merges with the branch's (`gradle.properties`, `versions.properties`: the template's value wins for a common key).
Default files under conda_recipe/ and src/, and the build.gradle files, are never touched by an upgrade.
"""

from __future__ import annotations

import re

# version 1: repositories created before upgrades existed (no hidden template files)
TEMPLATE_VERSION = 3
PLUGIN_VERSION = f"1.{TEMPLATE_VERSION}.0"

CI_YML = """# Managed by repository upgrades: this file is overwritten by the next upgrade (do not add custom checks here).
# Checks on every commit: compile, load the transforms, resolve conda_recipe/meta.yaml and run the unit tests.
java-version: JAVA_17
jobs:
  foundry-publish:
    timeout: 20 minutes
    steps:
      - |
        ./gradlew --no-daemon --build-cache --stacktrace check publish
"""

README = """# {name}

Python transforms over datasets in Files, with Foundry's transforms API (`transforms.api`).

```
transforms-python
├── build.gradle
├── conda_recipe
│   └── meta.yaml          packages the transforms need (Libraries panel / Task Runner `install`)
└── src
    ├── myproject
    │   ├── datasets
    │   │   └── examples.py    your transforms
    │   └── pipeline.py        the Pipeline: discover_transforms(datasets)
    ├── setup.py               the transforms.pipelines `root` entry point
    └── test
        └── test_examples.py   pytest tests (run in Checks)
```

- `@transform.using(...)` runs on a single node (Polars, pandas, DuckDB via `ctx.duckdb()`);
  `@transform.spark.using(...)` runs on Spark. Both can have several outputs.
- **Checks** run on every commit: the environment in meta.yaml resolves, files compile, transforms load, tests pass.
- **Preview** runs a transform without writing anything; **Build** writes its outputs to Files.
- Outputs go to `My Project / Code Repositories / {name}` unless the Output path names a folder.
"""

EXAMPLE = '''from transforms.api import Input, Output, transform, LightweightInput, LightweightOutput


# Replace the input path with a dataset from Files (copy its path from the Datasets panel)
# and the output path with where the result should go.
@transform.using(
    output_dataset=Output("example_output"),
    input_dataset=Input("{input}"),
)
def compute(input_dataset: LightweightInput, output_dataset: LightweightOutput) -> None:
    output_dataset.write_table(input_dataset.polars(lazy=True).unique().head(1000))
'''

PIPELINE = '''from transforms.api import Pipeline

from myproject import datasets

my_pipeline = Pipeline()
my_pipeline.discover_transforms(datasets)
'''

SETUP = '''#!/usr/bin/env python
"""Python project setup script."""

import os
from setuptools import find_packages, setup

setup(
    name=os.environ.get("PKG_NAME", "myproject"),
    version=os.environ.get("PKG_VERSION", "0.0.0"),
    description="Python data transformation project",
    author="{name}",
    packages=find_packages(exclude=["contrib", "docs", "test"]),
    # Please specify your dependencies in conda_recipe/meta.yaml instead.
    install_requires=[],
    entry_points={{"transforms.pipelines": ["root = myproject.pipeline:my_pipeline"]}},
)
'''

META = """# If you need to modify the runtime requirements for your package,
# update the 'requirements.run' section in this file

package:
  name: "{{ PACKAGE_NAME }}"
  version: "{{ PACKAGE_VERSION }}"

source:
  path: ../src

requirements:
  build:
    - python
    - setuptools

  run:
    - python
    - transforms {{ PYTHON_TRANSFORMS_VERSION }}
    - transforms-expectations
    - polars
    - pandas

build:
  script: python setup.py install --single-version-externally-managed --record=record.txt
"""

GRADLE = """apply plugin: 'bluesandai.python'
apply plugin: 'bluesandai.python-defaults'

// Apply the testing plugin
apply plugin: 'bluesandai.pytest'

// Transform logic level versioning: set `tllv false` to make every file part of each transform's version
transformsPython {
    tllv true
}
"""

TEST = '''import polars as pl


def test_dataframe():
    df = pl.DataFrame([["a", 1], ["b", 2]], schema=["letter", "number"], orient="row")
    assert df.columns == ["letter", "number"]
'''


# what earlier template versions wrote to the overwritten files: a file holding one of these (or the current
# content) has no user-authored changes, so an automatic upgrade may overwrite it
PAST_OVERWRITES: dict[str, list[str]] = {}

GRADLE_LOCAL = '#!/usr/bin/env python3\n"""./gradlew for a clone of a BluesandAI code repository (git remote: <api>/api/git/<repo id>.git).\n\nLike Foundry\'s Gradle-based local preview, the tasks run remotely, in the platform, on the pushed branch:\n  ./gradlew displayTransformsList\n  ./gradlew datasetPreview --transformId=<id> [--printMode=table] [--inputFiles=<alias>:<path>] [--outputFiles=<alias>:<path>]\n  ./gradlew checks\nThe API address, repository and token come from `git remote get-url origin` (the clone URL of Work locally); set\nBLUESANDAI_TOKEN instead when the URL holds no token. Push first: the platform previews what was pushed.\nOnly the Python standard library is needed.\n"""\n\nimport json\nimport os\nimport re\nimport subprocess\nimport sys\nimport urllib.error\nimport urllib.request\n\n\ndef git(*args):\n    return subprocess.run(["git", *args], capture_output=True, text=True).stdout.strip()\n\n\ndef remote():\n    url = git("remote", "get-url", "origin")\n    m = re.match(r"^(https?)://(?:([^:@/]*):([^@/]*)@)?([^/]+)(.*)/api/git/([A-Za-z0-9_-]+)\\.git/?$", url)\n    if not m:\n        sys.exit(f"origin is not a BluesandAI Git remote ({url or \'no origin\'}): clone with the URL of Work locally")\n    scheme, _user, token, host, prefix, repo = m.groups()\n    return f"{scheme}://{host}{prefix}", repo, token or os.environ.get("BLUESANDAI_TOKEN", "")\n\n\ndef call(base, token, path, body=None, query=""):\n    req = urllib.request.Request(f"{base}{path}{query}", data=json.dumps(body or {}).encode(), method="POST",\n                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})\n    try:\n        with urllib.request.urlopen(req, timeout=900) as r:\n            return json.loads(r.read() or b"{}")\n    except urllib.error.HTTPError as e:\n        try:\n            detail = json.loads(e.read()).get("detail")\n        except ValueError:\n            detail = e.reason\n        sys.exit(f"FAILURE: {detail}")\n\n\ndef main(argv):\n    tasks = [a for a in argv if not a.startswith("-")]\n    opts = {}\n    for a in argv:\n        if a.startswith("--") and "=" in a:\n            k, v = a[2:].split("=", 1)\n            opts.setdefault(k, []).append(v)\n    if not tasks:\n        print(__doc__)\n        return 0\n    base, repo, token = remote()\n    branch = git("rev-parse", "--abbrev-ref", "HEAD")\n    ahead = git("rev-list", "--count", "@{u}..HEAD") if git("rev-parse", "--abbrev-ref", "@{u}") else ""\n    if not git("rev-parse", "--abbrev-ref", "@{u}"):\n        print(f"warning: {branch} does not track a pushed branch: push it first (git push -u origin {branch})", file=sys.stderr)\n    elif ahead not in ("", "0"):\n        print(f"warning: {ahead} local commit(s) not pushed: the platform runs the pushed {branch}", file=sys.stderr)\n    status = 0\n    for task in tasks:\n        if task == "displayTransformsList":\n            res = call(base, token, f"/api/transforms-common/repos/{repo}/transforms-list", query=f"?branch={urllib.request.quote(branch)}")\n        elif task == "datasetPreview":\n            if not opts.get("transformId"):\n                sys.exit("datasetPreview needs --transformId=<id> (see ./gradlew displayTransformsList)")\n            res = call(base, token, f"/api/transforms-common/repos/{repo}/dataset-preview",\n                       {"branch": branch, "transform_id": opts["transformId"][0], "print_mode": (opts.get("printMode") or ["uri"])[0],\n                        "input_files": opts.get("inputFiles", []), "output_files": opts.get("outputFiles", [])})\n        elif task in ("checks", "check"):\n            res = call(base, token, f"/api/code-repos/{repo}/checks", {"branch": branch})\n            lines = ["> Task :checks"] + [f"  {c.get(\'name\') or c.get(\'id\')}: {c.get(\'status\')}" for c in res.get("tasks") or res.get("steps") or []]\n            res = {"ok": res.get("status") in ("passed", "succeeded") or res.get("ok"), "logs": "\\n".join(lines) + f"\\nChecks {res.get(\'status\')}"}\n        else:\n            print(f"Task \'{task}\' runs in the platform\'s checks or builds here: use displayTransformsList, datasetPreview or checks", file=sys.stderr)\n            status = 1\n            continue\n        print(res.get("logs") or json.dumps(res, indent=1))\n        if not res.get("ok", True):\n            status = 1\n    print("BUILD SUCCESSFUL" if status == 0 else "BUILD FAILED")\n    return status\n\n\nif __name__ == "__main__":\n    sys.exit(main(sys.argv[1:]))\n'
GRADLEW = '#!/bin/sh\n# Gradle-style tasks that run in the platform (gradle/bluesandai_local.py)\nexec python3 "$(dirname "$0")/gradle/bluesandai_local.py" "$@"\n'
GRADLEW_BAT = '@echo off\r\nrem Gradle-style tasks that run in the platform (gradle\\bluesandai_local.py)\r\npython "%~dp0gradle\\bluesandai_local.py" %*\r\n'


def upgrade_files(kind: str) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    """(files an upgrade overwrites, {properties file: keys it merges}) of the current template version."""
    project = "transforms-python" if kind == "python" else None
    overwrite = {"ci.yml": CI_YML, "settings.gradle": f"rootProject.name = 'root'\n{f'include {project!r}' if project else ''}\n",
                 # version 3: ./gradlew for local development (the tasks run in the platform: code_git.py, transforms_common.py)
                 "gradlew": GRADLEW, "gradlew.bat": GRADLEW_BAT, "gradle/bluesandai_local.py": GRADLE_LOCAL}
    merge = {
        "gradle.properties": {"transformsLangPythonPluginVersion": PLUGIN_VERSION, "transformsTemplateVersion": str(TEMPLATE_VERSION)},
        "versions.properties": {"bluesandai.transforms.python:*": PLUGIN_VERSION, "bluesandai.conda:*": PLUGIN_VERSION},
    }
    return overwrite, merge


def _hidden_files(kind: str, gradle_properties: str = "") -> dict[str, str]:
    """The template's hidden files for a new repository."""
    overwrite, merge = upgrade_files(kind)
    out = dict(overwrite)
    out["gradle.properties"] = gradle_properties + "".join(f"{k}={v}\n" for k, v in merge["gradle.properties"].items())
    out["versions.properties"] = "".join(f"{k} = {v}\n" for k, v in merge["versions.properties"].items())
    return out


def python_files(name: str, settings: str, sample_input: str) -> dict[str, str]:
    base = "transforms-python"
    return {
        **_hidden_files("python"),
        "README.md": README.format(name=name),
        "repoSettings.json": settings,
        f"{base}/build.gradle": GRADLE,
        f"{base}/conda_recipe/meta.yaml": META,
        f"{base}/src/setup.py": SETUP.format(name=name),
        f"{base}/src/myproject/__init__.py": "",
        f"{base}/src/myproject/pipeline.py": PIPELINE,
        f"{base}/src/myproject/datasets/__init__.py": "",
        f"{base}/src/myproject/datasets/examples.py": EXAMPLE.replace("{input}", sample_input),
        f"{base}/src/test/__init__.py": "",
        f"{base}/src/test/test_examples.py": TEST,
    }


LIB_README = """# {name}

A Python library: other repositories use it by adding `{package}` to the run requirements of their
conda_recipe/meta.yaml (or Libraries panel → Add), then `import {module}`.

- Packages are the folders under `src/` with an `__init__.py`.
- To publish a version, tag a commit (Branches → Tags, e.g. `0.1.0`); it is published once that commit's
  checks pass. Consumers can pin a version (`{package} 0.1.0`); unpinned they get the newest.
- The Artifacts app lists published versions and which repositories consume them.
"""

LIB_GRADLE = """apply plugin: 'bluesandai.python-library'
apply plugin: 'bluesandai.python-library-defaults'

// Apply the testing plugin
apply plugin: 'bluesandai.pytest'

// Publish only for tagged releases (zero commits ahead of last git tag)
condaLibraryPublish.onlyIf { versionDetails().commitDistance == 0 }
"""

LIB_META = """package:
  name: "{{ PACKAGE_NAME }}"
  version: "{{ PACKAGE_VERSION }}"

source:
  path: ../src

requirements:
  build:
    - python
    - setuptools

  run:
    - python
"""

LIB_MODULE = '''"""Helpers shared across transforms repositories."""


def normalize_name(value):
    """Trim and title-case a name; None stays None."""
    if value is None:
        return None
    return " ".join(part.capitalize() for part in str(value).split())
'''

LIB_TEST = '''from {module}.utils import normalize_name


def test_normalize_name():
    assert normalize_name("  ada   LOVELACE ") == "Ada Lovelace"
    assert normalize_name(None) is None
'''


def library_files(name: str, settings: str) -> dict[str, str]:
    package = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-") or "my-library"
    module = re.sub(r"[^a-z0-9_]", "_", package.replace("-", "_")) or "mylibrary"
    if module[0].isdigit():
        module = f"lib_{module}"
    return {
        **_hidden_files("python-library", f"condaPackageName={package}\n"),
        "README.md": LIB_README.format(name=name, package=package, module=module),
        "repoSettings.json": settings,
        "build.gradle": LIB_GRADLE,
        "conda_recipe/meta.yaml": LIB_META,
        f"src/{module}/__init__.py": "",
        f"src/{module}/utils.py": LIB_MODULE,
        "src/test/test_utils.py": LIB_TEST.format(module=module),
    }
