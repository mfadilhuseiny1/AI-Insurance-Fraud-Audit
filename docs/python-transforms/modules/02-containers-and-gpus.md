# Bring your own container, GPUs and GPU engines

Remaining work for Python transforms — module `02-containers-and-gpus`. Source: `23 - Python.md`.

## What is missing and how to finish it

**Done (2026-10-09):** `.with_container(container_image, container_tag)` (BYOC, `api/byoc_slot.py`; 10 checks) and
Apache DataFusion (installed; the docs' example runs).

**Not done.** `gpu_type` in `with_resources`, cuDF (`cudf.from_pandas`), GPU Polars (`pl.GPUEngine`,
`write_table(engine="gpu")` — today it silently collects on the CPU): this machine has no NVIDIA GPU. `cpu_cores` / `memory_*` ARE done (thread limits; the memory limit stops
the build; metrics are recorded).

**Today:** a GPU request or a container marks the transform `blocked` (`code_pyapi._register_new`, `_Using.with_container`).

**To finish:**
1. BYOC: an image registry (Artifacts) + Docker on the host; run `code_runner.py` inside the image
   (`docker run` with the repo mounted at `$USER_WORKING_DIR/user_code`, uid 5001); no preview (doc).
2. GPUs: detect NVIDIA GPUs (`nvidia-smi`), expose them as a resource queue (Resource Management), set
   `CUDA_VISIBLE_DEVICES` for the build; install `cudf-polars` / `cudf` only where a GPU exists.
3. DataFusion: `uv pip install datafusion`; `my_input.path()` already returns a Parquet folder.

Where the code lives: `api/code_pyapi.py` (transforms.api), `api/code_runner.py` (runs a transform in a subprocess),
`api/code_repos.py` (builds, checks, Task Runner, libraries), `api/code_env.py` (meta.yaml), `api/code_media.py`
(media sets), `api/code_expectations.py` (data expectations), `web/src/components/code/PythonPanels.tsx` and
`web/src/app/code-repositories/[id]/page.tsx` (UI). Test with `docs/python-transforms/runner_harness.py` (writes repo files + spec.json, runs `code_runner.py`)
and live calls to `/api/code-repos/*` (sign-in required: an API token, or `BLUESANDAI_AUTH=off`).

## Source documentation (verbatim)

Sections: [bring-container](https://www.palantir.com/docs/foundry/transforms-python/bring-container/), [configure-resources](https://www.palantir.com/docs/foundry/transforms-python/configure-resources/), [advanced-compute](https://www.palantir.com/docs/foundry/transforms-python/advanced-compute/), [polars-lazy](https://www.palantir.com/docs/foundry/transforms-python/polars-lazy/)

---

### Bring your own container

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/bring-container/

#### Bring your own container workflows

Most computations can be easily expressed with just Python. However, there are use cases where one might want to rely on a non-Python execution engine or script. For instance, it could be an F# application, an ancient VBA script, or even just an end-of-life (EOL) version of Python. The possibilities are limitless when using bring-your-own-container (BYOC) workflows. In short, BYOC enables the creation of a Docker image locally with all the specific dependencies and/or binaries an application requires, and then running a lightweight transform on top of this image.

The following is an example of how to run a COBOL transform in Foundry. For simplicity, this example compiles the COBOL program inside the transform. Alternatively, you may pre-compile the program and copy the binary executable into the Docker image. First, [enable containerized workflows](https://www.palantir.com/docs/foundry/administration/container-governance/#enable-container-workflows) then build the Docker image locally following these [image requirements](https://www.palantir.com/docs/foundry/transforms-container/container-overview/#image-requirements).

Consider the following minimal Dockerfile as an example:

```dockerfile
FROM ubuntu:latest

RUN apt update && apt install -y coreutils curl sed build-essential gnucobol

RUN useradd --uid 5001 user
USER 5001
```

**Note:** The Docker image does not need to have Python installed for lightweight to work.

> [!WARNING]
>
> Using `ubuntu:latest` as the base image might result in cURL command failures in IL5 or FedRAMP environments. If that occurs, use `ubuntu:jammy` instead.

Then, build the image and upload it to Foundry. To do so, [create an Artifacts repository](https://www.palantir.com/docs/foundry/code-repositories/create-artifact-repository/) and follow [these instructions to tag and push](https://www.palantir.com/docs/foundry/code-repositories/publish-artifact/) our image. In this example, the image is tagged with the name `my-image` and version `0.0.1`. The final step before authoring the BYOC lightweight transform is to [add this Artifacts Repository as a local backing repository](https://www.palantir.com/docs/foundry/code-repositories/artifact-settings/#add-a-new-artifact-to-your-code-repository) to the Code Repository.

This following example considers a COBOL script which generates a CSV file, with its source code located at `resources/data_generator.cbl` inside my Code Repository.

The final step is to write a lightweight transform that allows a connection of the data processing program to Foundry. The following snippet demonstrates how to access the dataset through the Python API while also including arbitrary executables shipped inside the image in question. To invoke the COBOL executable, use the Python standard library's functions (in this case, `os.system(...)`).

```python
from transforms.api import Output, transform


@transform.using(
    my_output=Output('my-output')
).with_container(
   container_image="my-image",
   container_tag="0.0.1"
)
def compile_cobol_data_generator(my_output):
    """Demonstrate how we can bring dependencies that would be difficult to get through Conda."""
    # Compile the Cobol program
    # (Everything from the src folder is available in $USER_WORKING_DIR/user_code)
    os.system("cobc -x -free -o data_generator $USER_WORKING_DIR/user_code/resources/data_generator.cbl")

    # Run the program to create and populate data.csv
    os.system('$USER_WORKING_DIR/data_generator')

    # Store the results into Foundry
    my_output.write_table(pd.read_csv('data.csv'))
```

> [!WARNING]
>
> Preview is not yet supported for BYOC workflows.

Using the **Build** button will eventually instantiate a container from our Docker image and invoke the commands specified. Resource allocation, logging, communicating with Foundry, enforcing permissions and auditability are all taken care of automatically.

---

### Configure resources

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/configure-resources/

#### Resource configuration

This page covers the configuration of resources for single-node transforms. Distributed Spark transforms are configured with [Spark profiles](https://www.palantir.com/docs/foundry/optimizing-pipelines/apply-spark-profiles/) so that controls can be placed on large resource consumption.

Transform resources can be configured by calling `with_resources` on the transform decorator.

```python
from transforms.api import transform, Input, Output


@transform.using(
    output=Output("/path/output"),
    input=Input("/path/input"),
).with_resources(
    cpu_cores=1
)
def my_compute_function(output, input):
    ...
```

The following options can be configured:

* **`cpu_cores`:** The number of CPU cores to request for the transform's container. Can be a fraction, defaults to two.
* **`memory_gb`:** The amount of memory to request for the container, in GB.
* **`memory_mb`:** The amount of memory to request for the container, in MB.
* **`gpu_type`:** The type of GPU to allocate for the transform, provided as a string.

> [!WARNING]
>
> Only one of `memory_gb` and `memory_mb` can be configured.

By default, the maximum allowed values are 8 cores and 64 GBs of memory. To increase these limits, contact Palantir Support.

Below is an example configuration of cores, memory, and GPU type.

```python
from transforms.api import transform, Input, Output


@transform.using(
    output=Output("/path/output"),
    input=Input("/path/input"),
).with_resources(
    cpu_cores=8,
    memory_gb=32,
    gpu_type="NVIDIA_T4"
)
def my_compute_function(output, input):
    ...
```

Use the [Metrics telemetry tab](https://www.palantir.com/docs/foundry/transforms-python/metrics/) to monitor build memory and CPU utilization and tune resource settings. Metrics are available for transforms that use lightweight compute engines.

##### GPU provisioning

GPUs can only be used in Python transforms if they are [available to the project](https://www.palantir.com/docs/foundry/resource-management/resource-queues/#use-gpus) that the transform is in. Not all GPU types are available on all environments.

The following are GPU types that can be made available for transforms:

* `"NVIDIA_T4"`
* `"NVIDIA_V100"`
* `"NVIDIA_A10G"`
* `"NVIDIA_A100"`
* `"NVIDIA_A16"`
* `"NVIDIA_H100"`
* `"NVIDIA_H200"`
* `"NVIDIA_L4"`
* `"NVIDIA_L40S"`

For examples of GPU usage, including GPU-accelerated Polars with cuDF, see [Advanced single-node compute options](https://www.palantir.com/docs/foundry/transforms-python/advanced-compute/).

---

### Advanced compute options

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/advanced-compute/

#### Advanced single-node compute options

The basic principle of the following integrations is that you can access [tabular Foundry datasets](https://www.palantir.com/docs/foundry/data-integration/datasets/) in multiple formats, such as a pandas DataFrame, Arrow Table, Polars DataFrame, and even as raw Parquet or CSV files. This is also shown in the [transforms overview](https://www.palantir.com/docs/foundry/transforms-python/transforms/#work-with-varied-data-formats). When saving tables from memory to Foundry, we can pass them in any of the formats in which they have been read.

See [Compute engine selection](https://www.palantir.com/docs/foundry/transforms-python/compute-engines/) to choose between single-node compute engines (pandas and Polars) and distributed compute (Spark). The integrations on this page extend single-node capabilities for specialized use cases.

> [!WARNING]
>
> Pandas can sometimes read Parquet files that Spark cannot process. For example, Parquet files using certain timestamp formats such as `INT64 (TIMESTAMP(NANOS,false))` cause Spark to fail with `org.apache.spark.sql.AnalysisException: Illegal Parquet type`. Read the Parquet file directly with pandas as a workaround:
>
> ```python
> import pandas as pd
> 
> df = pd.read_parquet(my_input.path())
> ```

##### Working with Apache DataFusion

Sometimes, it is easier to cut out the data deserialization step and directly pass the raw underlying dataset files to our compute engine. We can get the path to the files on disk, which get downloaded on-demand by calling `my_input.path()`. When it comes to writing raw files back to Foundry, we have two limitations to keep in mind:

* Only Parquet files can be stored in Foundry datasets through this API.
* Files must be placed in the folder located at the value of `my_output.path_for_write_table`.

When both criteria are met, we can call `write_table` with the path to this folder, like so:

```python
my_output.write_table(my_output.path_for_write_table)
```

To see this in action, consider the following example demonstrating how to use [DataFusion ↗](https://arrow.apache.org/datafusion-python/user-guide/common-operations/basic-info.html) in the platform.

```python
import datafusion
from datafusion import lit
from datafusion.functions import col, starts_with
from transforms.api import transform, Output, Input


@transform.using(my_input=Input('my-input'), my_output=Output('my-output'))
def my_datafusion_transform(my_input, my_output):
    ctx = datafusion.SessionContext()
    table = ctx.read_parquet(my_input.path())
    my_output.write_table(
        table
        .filter(starts_with(col("name"), lit("John")))
        .to_arrow_table()
    )
```

##### Using cuDF

You can also achieve integration through the use of `pandas.DataFrame`. The following snippet shows an instance using [cuDF ↗](https://github.com/rapidsai/cudf) in a lightweight transform. This will essentially run pandas code in a highly parallelized manner on the GPU where possible.

```python
@transform.using(
    my_input=Input('my-input'),
    my_output=Output('my-output')
).with_resources(
    cpu_cores=4,
    memory_gb=32,
    gpu_type='NVIDIA_T4'
)
def my_cudf_transform(my_input, my_output):
    import cudf  # Only import CUDF at runtime, not during CI
    df = cudf.from_pandas(my_input.pandas()[['name']])
    filtered_df = df[df['name'].str.startswith('John')]
    sorted_df = filtered_df.sort_values(by='name')
    my_output.write_table(sorted_df)
```

The above snippet assumes that your Foundry enrollment is equipped with an NVIDIA T4 GPU and it is available to your project through a [resource queue](https://www.palantir.com/docs/foundry/resource-management/resource-queues/#use-gpus).

##### GPU-accelerated Polars with cuDF

You can accelerate [Polars lazy API](https://www.palantir.com/docs/foundry/transforms-python/polars-lazy/) queries on GPUs using [`cudf-polars` ↗](https://docs.rapids.ai/api/cudf/stable/cudf_polars/), a GPU-backed execution engine for Polars. This allows you to run existing Polars lazy API queries on GPUs with minimal code changes by passing `pl.GPUEngine()` to the `collect()` call. For details on supported operations and performance characteristics, see the [Polars GPU support documentation ↗](https://docs.pola.rs/user-guide/gpu-support/).

To use GPU-accelerated Polars, your Foundry enrollment must be equipped with a supported NVIDIA GPU, and the GPU must be available to your project through a [resource queue](https://www.palantir.com/docs/foundry/resource-management/resource-queues/#use-gpus). See [GPU provisioning](https://www.palantir.com/docs/foundry/transforms-python/configure-resources/#gpu-provisioning) for the list of available GPU types.

> [!WARNING]
>
> GPU-accelerated collection currently only supports `collect()`, which fully materializes results in memory. Streaming operations such as `sink_parquet()` are not yet supported. Ensure that your output data fits in available GPU and system memory.

###### Setup

To use GPU acceleration for the Polars lazy API, add the `cudf-polars` package to the `run` requirements in your `conda_recipe/meta.yaml` file. For details on adding packages, refer to the [Python libraries documentation](https://www.palantir.com/docs/foundry/transforms-python/use-python-libraries/#discover-and-use-python-libraries).

```yaml
requirements:
  run:
    - python
    - transforms {{ PYTHON_TRANSFORMS_VERSION }}
    - cudf-polars
```

Next, request a GPU in your transform by chaining `.with_resources()` onto your decorator:

```python
from transforms.api import transform, Output, Input

@transform.using(
    output=Output("/Users/jsmith/output"),
    my_input=Input("/Users/jsmith/input"),
).with_resources(
    gpu_type="NVIDIA_T4",
    memory_gb=32,
)
def compute(output, my_input):
    ...
```

###### Writing with the Polars GPU engine

Build your query using the standard Polars lazy API, then pass `engine="gpu"` to `write_table()` to collect and write the result using the GPU:

```python
import polars as pl
from transforms.api import transform, Output, Input

@transform.using(
    output=Output("/Users/jsmith/output"),
    my_input=Input("/Users/jsmith/input"),
).with_resources(
    gpu_type="NVIDIA_T4",
    memory_gb=32,
)
def compute(output, my_input):
    lf = my_input.polars(lazy=True)

    result = (
        lf.with_columns(
            (pl.col("a") * pl.col("b")).alias("product"),
            (pl.col("a").pow(2) + pl.col("b").pow(2)).sqrt().alias("norm"),
        )
        .group_by("category")
        .agg(
            pl.col("product").sum().alias("total_product"),
            pl.col("norm").mean().alias("mean_norm"),
            pl.len().alias("n"),
        )
        .sort("total_product", descending=True)
    )

    output.write_table(result, engine="gpu")
```

The GPU engine only supports a subset of Polars operations. For the full list, see the [Polars GPU support documentation ↗](https://docs.pola.rs/user-guide/gpu-support/). By default, unsupported queries silently fall back to the CPU engine. To raise an error instead, collect manually with `raise_on_fail=True` and pass the resulting DataFrame to `write_table()`:

```python
df = lf.collect(engine=pl.GPUEngine(raise_on_fail=True))
output.write_table(df)
```

---

### Polars lazy API

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/polars-lazy/

#### Polars lazy API

The [Polars lazy API ↗](https://docs.pola.rs/user-guide/concepts/lazy-api/) only evaluates queries after they are collected. This allows the engine to apply optimizations that improve performance in most cases, and is the recommended mode of compute when using Polars. Lazy execution is recommended for pipelines that process large amounts of data. However, different queries will benefit to varying degrees, and the stability of individual pipelines should always be verified before deploying to production systems.

To access the Polars lazy API in Foundry, set the `lazy` flag to `True` in your transform as shown below:

```python
from transforms.api import transform, Input, Output


@transform.lightweight(
    output=Output("/Users/jsmith/output"),
    input=Input("/Users/jsmith/input"),
)
def compute(output, input):
    df = input.polars(lazy=True)
    # your data transformation logic
    output.write_table(df)
```

By default, lazy execution is **disabled**.

The Polars [streaming engine ↗](https://docs.pola.rs/user-guide/concepts/streaming/) is generally used during lazy computation. This allows for larger-than-memory data to be processed, as the query can be executed in batches instead of all at once. In addition, queries will execute faster when data streaming is enabled. Streaming is always enabled when Polars is used in lazy mode.

##### Filter pushdown

Lazy execution is especially beneficial when filter pushdown, also known as predicate pushdown, can be used. Filter pushdown means that filtering operations such as `.filter()`, `.where()`, or boolean indexing, are not executed immediately. Instead, they are recorded as part of the query plan. When the query is executed, Polars attempts to push these filters in the execution plan as early as possible. In some cases, they can be pushed all the way down to the data scan itself, avoiding data input/output altogether. The smaller the fraction of data used in the pipeline, the greater the impact filter pushdown will have. The full set of optimizations used during lazy compute can be found in the Polars [lazy optimization ↗](https://docs.pola.rs/user-guide/lazy/optimizations/) documentation.

If your query resembles the example below, enabling lazy execution is strongly recommended, as it will significantly improve performance.

```python
import polars as pl
from transforms.api import transform, Input, Output


@transform.lightweight(
    output=Output("/Users/jsmith/2025_06_sale_data"),
    sales_data=Input("/Users/jsmith/sales_data"),
)
def june_2025_sales(output, sales_data):
    df = (
        sales_data.polars(lazy=True)
        .filter(
            (pl.col("date") >= pl.lit("2025-06-01")) &
            (pl.col("date") <= pl.lit("2025-06-30"))
        )
    )
    output.write_table(df)
```

##### Debug lazy pipelines

In lazy execution mode, Polars will generate a query plan. Use `.explain()` or `.describe_plan()` on a lazy DataFrame to view the planned execution steps and applied optimizations.

```python
from transforms.api import transform, Input, Output


@transform.lightweight(
    output=Output("/Users/jsmith/output"),
    input=Input("/Users/jsmith/input"),
)
def compute(output, input):
    df = input.polars(lazy=True)
    # your data transformation logic
    print(df.explain())
    output.write_table(df)
```

If a query is failing and lazy execution makes it challenging to identify the issue, you can materialize intermediate results with `.collect()`.

```python
from transforms.api import transform, Input, Output


@transform.lightweight(
    output=Output("/Users/jsmith/output"),
    input=Input("/Users/jsmith/input"),
)
def compute(output, input):
    df = input.polars(lazy=True)
    # part of a query
    df.collect()
    # remainder of a query
    output.write_table(df)
```

##### Use with incremental transforms on streaming datasets

When using `polars(lazy=True)` in an [incremental transform](https://www.palantir.com/docs/foundry/transforms-python/incremental-overview/) on a streaming dataset, the incremental window may sometimes contain no new files. Calling `.polars(lazy=True)` on an empty input in this scenario can trigger a `BinderException`. To handle this, check whether the input is empty before using the lazy API:

```python
from transforms.api import transform, incremental, Input, Output


@incremental()
@transform.using(
    my_output=Output('/path/to/output'),
    my_input=Input('/path/to/input'),
)
def compute(ctx, my_output, my_input):
    if ctx.is_incremental and my_input.polars().is_empty():
        return
    df = my_input.polars(lazy=True)
    my_output.write_table(df)
```

For more details on this known limitation, see the [incremental transforms](https://www.palantir.com/docs/foundry/transforms-python/incremental-overview/#example-non-incremental-and-incremental-transforms) documentation.

##### GPU acceleration

You can accelerate Polars lazy API queries with GPU processing by using `cudf-polars`, a GPU-backed execution engine. Run existing Polars lazy API queries with GPU processing by passing `pl.GPUEngine()` to the `collect()` call:

```python
result = df.collect(engine=pl.GPUEngine())
```

GPU-accelerated collection supports `collect()`, which fully materializes results in memory. Streaming operations such as `sink_parquet()` are not supported.

For detailed setup instructions, supported operations, and code examples, see [GPU-accelerated Polars with cuDF](https://www.palantir.com/docs/foundry/transforms-python/advanced-compute/#gpu-accelerated-polars-with-cudf).

##### When to use lazy APIs

To fully leverage Polars optimizations in lazy compute, your foundry dataset is exposed using an internal object store proxy, so queries will only load the necessary data. Since Polars in eager mode does not have the same optimizations, your entire dataset is prefetched to disk when `lazy=False`.

Consider the following points to decide when to enable lazy execution.

* **Use lazy execution (`lazy=True`) in the following situations:**
  * You are working with large datasets or complex transformation pipelines.
  * You want to benefit from query optimizations such as filter pushdown, predicate pushdown, projection pushdown, or streaming.
  * You have multiple chained operations and want Polars to optimize execution order.
  * You need to process data that does not fit into memory.
* **Use eager execution (`lazy=False`) in the following situations:**
  * You are prototyping or exploring data transformations step by step.
  * You are debugging a complex pipeline and want more predictable behavior.
