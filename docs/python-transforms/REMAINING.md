# Python transforms: remaining work

What is not done yet from Palantir's Python transforms documentation (`23 - Python.md`, the
[transforms-python](https://www.palantir.com/docs/foundry/transforms-python/overview/) docs), as of commit `51882b7`
on `claude/gifted-sagan-maxkbo`. What *is* done is described in the README (Code Repositories → Python transforms).

Each module in [`modules/`](modules/) has: what is missing, what exists today and where, a plan to finish it, and the
source documentation sections **verbatim** so the work can be done without the original file.

| # | Module | State | Main gaps |
|---|--------|-------|-----------|
| 01 | [Virtual tables and compute pushdown](modules/01-virtual-tables-and-pushdown.md) | Partly | virtual tables on Foundry-native compute done (DeltaTable too); Snowflake / BigQuery / Databricks pushdown, template wizard |
| 02 | [Containers and GPUs](modules/02-containers-and-gpus.md) | Partly | BYOC and DataFusion done; `gpu_type`, cuDF, GPU Polars need a GPU |
| 03 | [Local development](modules/03-local-development.md) | Partly | Git remote done; VS Code extension, local preview and pytest |
| 04 | Environment and libraries | Done (module file removed) | small differences left, listed below |
| 05 | Unit tests and linting | Done (module file removed) | small differences left, listed below |
| 06 | Incremental and abort | Done (module file removed) | small differences left, listed below |
| 07 | [Media sets](modules/07-media-sets.md) | Mostly | done: tile (GeoTIFF), Cipher, transcribe, image embeddings, layout-aware blocks; left: NITF, SigLIP weights |
| 08 | transforms.api gaps | Done (module file removed) | small differences left, listed below |
| 09 | Debugging | Done (module file removed) | small differences left, listed below |

## Suggested order (smallest and most useful first)

1. ~~Module 06~~ done (2026-10-08, commit `4154594`).
2. ~~Module 08~~ done (2026-10-08).
3. ~~Module 09~~ done (2026-10-08).
4. ~~Module 04~~ done (2026-10-08).
5. ~~Module 05~~ done (2026-10-08).
6. Module 07: the extra models where acceptable.
7. Modules 01, 03, 02: need new platform pieces (virtual tables, a Git server, containers / GPUs).

## Left over from module 06 (incremental and abort, done)

Done: read modes, modify / replace, snapshot_inputs, strict_append, semantic_version, require_incremental,
allow_user_deletes, folder inputs, transaction / batch limits, per-output abort and `ctx.abort_job()`, preview always
non-incremental, aborted transactions greyed out in dataset history, empty snapshot for unwritten outputs, user deletes
vs retention (see README → Python transforms). Still differs from Foundry:
- `v2_semantics` is only recorded (it is required by `allow_user_deletes` and transaction limits, but changes nothing
  else).
- A modified input row looks like a deleted row plus an added one (row hashes), so with `allow_user_deletes` it does
  not force a snapshot the way a Foundry `modified` file change would.
- No "Snapshot/Incremental" report in a Spark details tab (the build shows a note instead); input transaction types
  come from `dataset_versions` sources (APPEND for `mode: append`), not real Catalog transactions.
- Datasets are one Parquet file, so the "file count > N → merge and replace" pattern never triggers.

## Left over from module 08 (transforms.api gaps, done)

Done: InputSet / OutputSet, `foundry.transforms.Dataset`, `FoundryDataSidecarFile` / `FoundryDataSidecarFileSystem`,
stop_propagating / stop_requiring / sever_permissions applied to output markings, custom Transforms profiles with
`spark.sql.files.maxPartitionBytes` / `openCostInBytes` (Spark `files()` packed by file size), Ibis and SQLFrame on
DuckDB (see README → Python transforms). Still differs from Foundry:
- Removing markings in code needs an administrator: markings here have no separate "remove marking" permission and
  there is no unmarking approval workflow. Java transforms' `stop_propagating` / `stop_requiring` are read but not
  applied (Python only).
- Custom Transforms profiles live in the repository's `repoSettings.json` (`sparkProfiles`, `spark.sql.*` settings
  only); Foundry defines them in Control Panel.
- `foundry.transforms.Dataset.get` reads other datasets by item id only (not by path) and writes only the transform's
  declared outputs. The docs' unit test examples mock `Dataset.get` with keys that are neither parameter names nor
  paths (`results_output`, `aircraft_input`), so they only pass when the mock uses the parameter names or paths.
- `ComputeBackend.VELOX` is logged only; `transform_df` / plain `@transform` still run on pandas unless the file
  imports pyspark, uses `@configure` or the repository sets `legacyPythonEngine: spark` (Foundry runs them on Spark).
- `ContainerTransform*` (module 02) and `TableTransformInput` / Iceberg tables (module 01) are still missing.

## Left over from module 09 (debugging, done)

Done: the Code Repositories debugger and console run `@transform.using` / `@transform.spark.using` transforms (through
`code_runner._run_new`, as a preview runs them; the console preloads their inputs, outputs, parameters and `ctx`) and
work on Windows: pause and live breakpoints use `_thread.interrupt_main` instead of SIGUSR1 / `os.kill`, commands are
read from a duplicate of stdin (a blocked pipe read stalled other calls on Windows), repository paths compare
case-insensitively, and stopping kills the process tree. Logging and build metrics were already done. Still differs:
- On Spark only the driver side is debugged; code inside UDFs / `rdd.map` runs in Spark's Python workers and does
  not stop at breakpoints.
- The debug panel shows the primary output's rows; the other outputs are in the finished event (`result.outputs`)
  but not rendered separately.
- The VS Code debugger belongs to module 03 (local development).

## Left over from module 04 (environment and libraries, done)

Done: per-repository environments built with uv from meta.yaml (`api/code_envs.py`; Python 3.10 / 3.11 through uv;
uv solves and explains conflicts; resolved versions locked until meta.yaml changes), published library versions locked
per meta.yaml, library permissions (`ReadRepositoryPermissionDenied`), pinning from the Libraries panel, Add from PyPI,
`pip:` / `test:` installs, `condaJars` / `sparkJars` (Ivy → Spark classpath), downloading published libraries as a
conda channel (`/api/artifacts/repositories/<id>/contents/release/conda/...`, tested with micromamba), and repository
upgrades (template version 2 with ci.yml / settings.gradle / gradle.properties / versions.properties; … → Upgrade opens
an upgrade PR; "Automatic merge of upgrade PRs" opens them hourly and merges them once checks pass). Still differs:
- Packages come from PyPI through uv, not conda channels: no channels / backing repositories / Artifact settings for
  conda, and conda-only packages are not installable.
- The environment lock lives in `data/code-envs/locks/` instead of `conda-versions.run.linux-64.lock` /
  `conda-version-test` files committed into the repository (no 7-day cache, no `SUPERSEDED` lock commits).
- Test-only dependencies are installed into the same environment the builds use (Foundry keeps a separate test
  environment); like Foundry, the Task Runner does not add test-only dependencies.
- Repository upgrades cover the Python transforms and Python library templates (Java, R, UDF templates are not
  upgraded), and their impact analysis tab and runtime Spark module version checks are not part of the automatic
  merge. With automatic merges off, an upgrade is offered by a banner and … → Upgrade (no PR is opened by itself).
- The published library's conda package is noarch only, built from the tagged sources (no compiled packages).

## Left over from module 05 (unit tests and linting, done)

Done (`api/code_lint.py`, `api/code_pytest_plugin.py`): Gradle plugins in a Python project's build.gradle turn the CI
tasks on — `com.palantir.transforms.lang.pytest-defaults` (unit tests; without it tests do not run, a repository
without a Python build.gradle always runs them), `tasks.pytest { numProcesses "N" }` (pytest-xdist; workers load the
transforms runtime and the `spark_session` fixture), `com.palantir.conda.pep8` (pycodestyle), `com.palantir.conda.pylint`
(`src/.pylintrc`), `com.palantir.transforms.lang.antipattern-linter`; Checks list the tasks (condaPackRun with its stages
when the repository environment is built, pytest, pep8, pylint, antipatternLinter) and every message. Still differs:
- PEP8 allows lines up to 120 characters unless the project configures pycodestyle (`[pycodestyle]` in setup.cfg /
  tox.ini); Foundry's default is not documented.
- Every PEP8 and Pylint message fails Checks (the Gradle tasks' behaviour as far as documented); a `.pylintrc` decides
  which Pylint messages exist. Pylint runs in the API's Python, not the repository environment.
- The Spark anti-pattern rules are this platform's own set (SPARK001–SPARK008: collect / toPandas, count() for
  emptiness, Python UDFs, withColumn in a loop, repartition(1) / coalesce(1), crossJoin, SQL built from strings);
  Foundry's rule list is not documented. They are warnings.
- condaPackRun's download / verify / link stages are one stage (uv does them together); a cached environment shows
  as up to date.
- Each pytest-xdist worker starts its own local Spark session for Spark tests.

## Working on it

- Code: `api/code_pyapi.py`, `api/code_runner.py`, `api/code_repos.py`, `api/code_env.py`, `api/code_media.py`,
  `api/code_expectations.py`, `web/src/components/code/PythonPanels.tsx`, `web/src/app/code-repositories/[id]/page.tsx`.
- Test quickly without the API: [`runner_harness.py`](runner_harness.py) (run it with the project venv).
- Live tests through the API need sign-in: an API token (Account → API tokens) or `BLUESANDAI_AUTH=off`.
- Checks before committing: `cd web && npx tsc --noEmit -p . && npx eslint <changed files>`; `python -m pyflakes` on changed API files.
- Packages go into `.venv` with uv (`uv pip install --python .venv/Scripts/python.exe …`); add them to `requirements.txt`.
