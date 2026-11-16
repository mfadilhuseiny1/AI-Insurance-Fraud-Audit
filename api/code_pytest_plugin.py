"""The pytest plugin of Code Repositories unit tests (code_runner.py loads it with `-p code_pytest_plugin`), so it is
also loaded in pytest-xdist workers (tasks.pytest { numProcesses "N" }): the transforms runtime modules
(transforms.api, transforms.mediasets, ...) and a session-scoped `spark_session` fixture sized by the transform's
Spark settings (BLUESANDAI_SPARK_CONF, set by the runner for its workers)."""

from __future__ import annotations

import json
import os

import pytest

import code_pyapi

code_pyapi.install_modules()
if os.environ.get("BLUESANDAI_SPARK_CONF"):
    try:
        code_pyapi.SPARK_CONF.update(json.loads(os.environ["BLUESANDAI_SPARK_CONF"]))
    except ValueError:
        pass
if os.environ.get("BLUESANDAI_REPO_ROOT"):
    code_pyapi.CURRENT_FILE["root"] = os.environ["BLUESANDAI_REPO_ROOT"]


@pytest.fixture(scope="session")
def spark_session():
    yield code_pyapi.spark_session()
