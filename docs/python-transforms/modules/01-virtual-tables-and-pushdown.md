# Virtual tables and compute pushdown

Remaining work for Python transforms — module `01-virtual-tables-and-pushdown`. Source: `23 - Python.md`.

## What is missing and how to finish it

**Partly done (2026-10-09).** Done: Iceberg tables in Python transforms (code_tables.py), and virtual tables on
Foundry-native compute (virtual_tables.py): `TableInput` on a virtual table, `TableOutput(path, source, locator)` with
SnowflakeTable / BigQueryTable / DatabricksTable / IcebergTable / FilesTable / DeltaTable (deltalake; 4 checks),
registration on the first build with fixed source and location, JDBC partition options on Spark (a repartition of
the table read through its source), and POST /api/virtual-tables to register input virtual tables. Tested end to end
with an Iceberg REST catalog connection, a filesystem source and the SQL write path on PostgreSQL (12 checks); the
Snowflake / BigQuery / Databricks writes were not run against those warehouses.

**Not done.** Compute pushdown — `@transform.databricks.using` / `.snowflake.using` / `.bigquery.using`
(`with_compute`, `with_dependencies`, `with_warehouse`, `with_engine("pyspark")`; Snowpark, Databricks Connect, Ibis
on BigQuery need those accounts and packages) and the file template wizard for virtual table outputs.
Reads are whole tables (no predicate pushdown). Data Connection → Virtual tables lists them and registers a source's
table (its locator from the source's type).

**Today:** these names exist in `code_pyapi.py` (`_Unavailable`, `_PushdownFactory`, `install_modules` →
`transforms.tables`) so code loads, but the transform is marked `blocked` and its build fails with a clear message.

**To finish:**
1. Model virtual tables in the platform first (a Files item pointing at a source + table locator). Pipeline Builder
   already has `/api/pipeline/virtual/read|write` and `api/connectors/databricks_conn.py` / `snowflake_conn.py`
   (see `docs/REMAINING.md` §1) — reuse them.
2. Foundry-native compute: `TableInput.dataframe(options=...)` reads the table through the connector into
   Arrow/Spark; `TableOutput.write_dataframe` writes back; register the output as a virtual table on first build.
3. Pushdown: Snowpark session (`snowflake-snowpark-python`), Databricks Connect (`databricks-connect`), Ibis for
   BigQuery (`ibis-framework[bigquery]`); all inputs/outputs must share one source; no `@incremental`.
4. Checks: the source/location of a created output can't change (fail checks).

Where the code lives: `api/code_pyapi.py` (transforms.api), `api/code_runner.py` (runs a transform in a subprocess),
`api/code_repos.py` (builds, checks, Task Runner, libraries), `api/code_env.py` (meta.yaml), `api/code_media.py`
(media sets), `api/code_expectations.py` (data expectations), `web/src/components/code/PythonPanels.tsx` and
`web/src/app/code-repositories/[id]/page.tsx` (UI). Test with `docs/python-transforms/runner_harness.py` (writes repo files + spec.json, runs `code_runner.py`)
and live calls to `/api/code-repos/*` (sign-in required: an API token, or `BLUESANDAI_AUTH=off`).

## Source documentation (verbatim)

Sections: [tables-overview](https://www.palantir.com/docs/foundry/transforms-python/tables-overview/), [tables-api](https://www.palantir.com/docs/foundry/transforms-python/tables-api/), [tables-compute-pushdown](https://www.palantir.com/docs/foundry/transforms-python/tables-compute-pushdown/), [tables-bigquery](https://www.palantir.com/docs/foundry/transforms-python/tables-bigquery/), [tables-databricks](https://www.palantir.com/docs/foundry/transforms-python/tables-databricks/), [tables-snowflake](https://www.palantir.com/docs/foundry/transforms-python/tables-snowflake/), [lightweight-api-evolution](https://www.palantir.com/docs/foundry/transforms-python/lightweight-api-evolution/)

---

### Overview

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/tables-overview/

#### Python transforms on virtual tables

[Virtual tables](https://www.palantir.com/docs/foundry/data-integration/virtual-tables/) allow you to query and write to tables in supported data platforms without storing the data in Foundry. You can interact with virtual tables in Python transforms using the `transforms-tables` library.

Foundry supports two compute modes on virtual tables:

1. **Foundry-native Spark compute:** This can be used with virtual table inputs or outputs from one or multiple sources, and composed together with Foundry-native dataset inputs and outputs. Virtual tables do not support [lightweight compute engines](https://www.palantir.com/docs/foundry/transforms-python/compute-engines/) such as Polars and Pandas in Foundry.
2. **Compute pushdown:** In this mode, through lightweight, Foundry orchestrates external compute in the source system. In order to use compute pushdown, all inputs and outputs must be virtual tables associated with the same source, and the source must be compute pushdown compatible.

> [!NOTE]
>
> Incremental computation using the `@incremental` decorator is not currently supported when using compute pushdown.

##### Prerequisites

To use virtual tables in a Python transform, you must:

1. [Upgrade your Python repository](https://www.palantir.com/docs/foundry/code-repositories/repository-upgrades/) to the latest version.
2. Install `transforms-tables` from the [Libraries tab](https://www.palantir.com/docs/foundry/transforms-python/use-python-libraries/).

> [!WARNING]
>
> Transforms that use the `use_external_systems` decorator are not compatible with virtual tables. Switch to [source-based external transforms](https://www.palantir.com/docs/foundry/data-connection/external-transforms/) or split your transform into multiple transforms, one that uses virtual tables and one that uses the `use_external_systems` decorator.

When virtual tables are used in Code Repositories, the transforms consuming them will automatically obtain network egress based on the [egress policies](https://www.palantir.com/docs/foundry/data-connection/set-up-direct-connection/#configure-a-network-policy) configured on the source.

The following settings must be enabled on the source:

* **Code imports:** This allows the source to be imported and used in a code repository. More information on this setting can be found in the documentation on [importing a source into code](https://www.palantir.com/docs/foundry/data-connection/external-transforms/#prerequisite-import-a-source-into-code).
* **Export controls:** This controls which [security markings](https://www.palantir.com/docs/foundry/security/markings/) and organizations will be allowed on inputs to a Python transform using a virtual table. Review the documentation on [configuring export controls on the source](https://www.palantir.com/docs/foundry/data-connection/external-transforms/#configure-export-controls-on-the-source) for more information.

Remember to import the output source into your repository using the sidebar.

Tables used as inputs and outputs in a Python transform do not need to come from the same source, or even the same platform. By default, Python transforms will use Foundry's compute to read and write tables, which allows querying across different external systems. Refer to the [Compute pushdown](https://www.palantir.com/docs/foundry/transforms-python/tables-compute-pushdown/) section for details on fully federating compute to an external system.

##### API reference

For detailed information on the `TableInput`, `TableOutput`, and available `Table` subclasses (such as `BigQueryTable`, `DatabricksTable`, `DeltaTable`, `FilesTable`, `IcebergTable`, and `SnowflakeTable`), refer to the [API overview](https://www.palantir.com/docs/foundry/transforms-python/tables-api/) documentation.

##### Quick start examples

Below is an example using a Snowflake source that takes a virtual table input and generates a virtual table output using Foundry-native Spark compute.

```python
from transforms.api import transform
from transforms.tables import TableInput, TableOutput, TableTransformInput, TableTransformOutput, SnowflakeTable


@transform.spark.using(
    input_table=TableInput('/path/input_table_name'),
    output_table=TableOutput(
        '/path/output_table_name',  # Virtual table output in Foundry
        'ri.magritte..source.123...',  # The output source RID
        SnowflakeTable('DATABASE', 'SCHEMA', 'TABLE'),  # The output storage location
    ),
)
def compute(input_table: TableTransformInput, output_table: TableTransformOutput):
    output_table.write_dataframe(input_table.dataframe())
```

Foundry datasets can also be used in combination with virtual tables. The example below takes a Foundry dataset input and writes a virtual table output to the external source.

```python
from transforms.api import transform, Input, TransformInput
from transforms.tables import TableOutput, TableTransformOutput, SnowflakeTable


@transform.spark.using(
    input_dataset=Input('/path/input_dataset_name'),
    output_table=TableOutput(
        '/path/output_table_name',  # Virtual table output in Foundry
        'ri.magritte..source.123...',  # Output source RID
        SnowflakeTable('DATABASE', 'SCHEMA', 'TABLE'),  # Output storage location
    ),
)
def compute(input_dataset: TransformInput, output_table: TableTransformOutput):
    output_table.write_dataframe(input_dataset.dataframe())
```

The following example uses compute pushdown with virtual table inputs and outputs.

```python
from snowflake.snowpark.functions import lit
import snowflake.snowpark as snow
from transforms.api import transform
from transforms.tables import (
    SnowflakeTable,
    TableInput,
    TableOutput,
    SnowflakeInput,
    SnowflakeOutput,
)

@transform.snowflake.using(
    input_table=TableInput('/path/input_table_name'),
    output_table=TableOutput(
        '/path/output_table_name',  # Virtual table output in Foundry
        'ri.magritte..source.123...',  # Output source RID
        SnowflakeTable('DATABASE', 'SCHEMA', 'TABLE'),  # Output storage location
    ),
)
def compute_in_snowflake(input_table: SnowflakeInput, output_table: SnowflakeOutput):

    # Get a Snowpark DataFrame instance
    df: snow.DataFrame = input_table.dataframe()

    # Example data transformation - create a new column
    df = df.with_column("NEW_COLUMN", lit("ABC"))

    # Write back to the new table
    output_table.write(df)
```

##### JDBC partitioning

When reading virtual table data using JDBC connectivity, you can configure partitioning in Python transforms to parallelize the read and improve the performance of loading the table.

Below is an example that adds partitioning when loading `input_table`. This will be based on `column_name` which will be divided into three equal sized partitions between a lower bound of 1 and an upper bound of 100.

```python
@transform(
    input_table=TableInput("/path/input_table_name"),
    output_df=Output("/path/output_dataset_name")
)
def compute(input_table: TableTransformInput, output_df: TransformOutput):
    input_df = input_table.dataframe(
        options={
            "numPartitions": "3",
            "partitionColumn": "column_name",
            "lowerBound": "1",
            "upperBound": "100"
        }
    )

    output_df.write_dataframe(input_df)
```

Partitioning configuration should be passed via the `options` parameter when calling `.dataframe()` to load the virtual table input. `partitionColumn` must be a numeric, date, or timestamp column. The data will be distributed into a number of partitions specified by `numPartitions`. These will be evenly sized ranges between the `lowerBound` and `upperBound` options.

The `lowerBound` and `upperBound` options are used only to calculate the partition stride, not to filter rows. All rows in the table will be returned, including those with values outside the specified bounds.

For more details about the available partitioning options, see the [Spark JDBC documentation ↗](https://spark.apache.org/docs/latest/sql-data-sources-jdbc.html).

##### File template configuration wizard \[Beta]

> [!NOTE]
> **Beta**
>
> Virtual table outputs in the file template configuration wizard are in the [beta](https://www.palantir.com/docs/foundry/platform-overview/development-life-cycle/) phase of development. Functionality may change during active development.

Virtual table inputs and outputs can be configured in the [Code Repositories file template configuration wizard](https://www.palantir.com/docs/foundry/code-repositories/create-transforms/) using the `virtual table` template variable type. When creating virtual table outputs, the wizard will walk you through selecting an output [source](https://www.palantir.com/docs/foundry/data-connection/core-concepts/#sources) to write to, along with a Foundry location for the virtual table.

![Configuring a virtual table output in the "Output table source" dialog.](assets/foundry/transforms-python/create-virtual-table-template.png)

---

### API reference

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/tables-api/

#### API overview

The `transforms-tables` library provides `TableInput` and `TableOutput` parameters to interact with virtual tables in Python transforms. These behave in a similar way to the `Input` and `Output` parameters used with Foundry datasets. However, writing to a virtual table requires additional configuration to [specify the source](https://www.palantir.com/docs/foundry/data-integration/source-type-overview/) and the location within the external system where the table will be stored. The virtual table will be created during checks, as with dataset outputs. Once created, the extra configuration for the source and table metadata can be removed from the `TableOutput` and replaced with the table RID to be more concise.

```python
from transforms.api import transform
from transforms.tables import TableInput, TableOutput, TableTransformInput, TableTransformOutput, SnowflakeTable


@transform.spark.using(
    source_table=TableInput(alias: str),
    output_table=TableOutput(
        alias: str,  # The Compass path where the virtual table should be registered
        source: str,  # The source RID where the output table should be written
        table: Table,  # The locator defining where the output table should be stored in the external system
    ),
)
def compute(source_table: TableTransformInput, output_table: TableTransformOutput):
    ...  # Normal transforms API
```

The `table: Table` parameter in `TableOutput` defines where the output table should be created in the external system.

> [!WARNING]
> **Source and location cannot be changed after creation**
>
> Once a virtual table has been created, it is not possible to change its source or location. Modifying the source or location will cause checks to fail.

The available `Table` subclasses are:

* `BigQueryTable(project: str, dataset: str, table: str)`
* `DatabricksTable(catalog: str, schema: str, table: str, format: Optional[str], location: Optional[str])`
* `DeltaTable(path: str)`
* `FilesTable(path: str, format: str)`
* `IcebergTable(table: str, warehouse_path: Optional[str])`
* `SnowflakeTable(database: str, schema: str, table: str)`

You must use the appropriate class based on the type of source you are connecting to. Refer to the documentation below for more information.

###### `transforms.tables.BigQuery`

Configures an output table in [Google BigQuery ↗](https://cloud.google.com/bigquery/docs).

**Constructor:**

```python
BigQueryTable(project: str, dataset: str, table: str)
```

| Parameter | Type | Description | Optional |
| --- | --- | --- | --- |
| `project` | `str` | The Google Cloud project ID where the BigQuery dataset resides. | No |
| `dataset` | `str` | The name of the BigQuery dataset containing the table. | No |
| `table` | `str` | The name of the BigQuery table. | No |

###### BigQuery compute pushdown (Ibis API)

For BigQuery compute pushdown, use Ibis-specific input and output classes in `transforms.tables` with the BigQuery transform decorator. Foundry establishes an Ibis connection to BigQuery from the configured input and output tables. You can express data transformations with the Ibis DataFrame API.

**Decorator:** `@transform.bigquery.using(...)`

**Configuration:** `TableInput` and `TableOutput` for the virtual table references and BigQuery table locator via `BigQueryTable(project, dataset, table)`

**Function signature:** `def compute(source_table: IbisInput, output_table: IbisOutput)`

**Methods:**

* `IbisInput.table()` returns an Ibis table expression for the input
* `IbisOutput.write(table_expr)` writes an Ibis table expression to the output

**Example:**

```python
from transforms.api import transform
from transforms.tables import (
    IbisInput,
    IbisOutput,
    TableInput,
    TableOutput,
    BigQueryTable,
)

@transform.bigquery.using(
    source_table=TableInput("ri.tables.main.table.1234"),
    output_table=TableOutput(
        "ri.tables.main.table.5678",
        "ri.magritte..source.1234",
        BigQueryTable("PROJECT", "DATASET", "TABLE"),
    ),
)
def compute(source_table: IbisInput, output_table: IbisOutput):
    table = source_table.table()
    output_table.write(table)
```

See [BigQuery compute pushdown](https://www.palantir.com/docs/foundry/transforms-python/tables-bigquery/) for detailed guidance on using Ibis.

###### `transforms.tables.DatabricksTable`

Configures an output table in [Databricks ↗](https://docs.databricks.com/aws/en/). Writing to tables in Databricks requires **external access** to be set up in Unity Catalog. Review the [Databricks](https://www.palantir.com/docs/foundry/available-connectors/databricks/#virtual-tables) section of the virtual tables documentation for more information.

**Constructor:**

```python
DatabricksTable(
    catalog: str,
    schema: str,
    table: str,
    format: Optional[str],
    location: Optional[str] = None
)
```

| Parameter | Type | Description | Optional |
| --- | --- | --- | --- |
|`catalog` | `str` | The Databricks catalog name. | No |
|`schema` | `str` | The schema (database) name within the catalog. | No |
|`table` | `str` | The table name. | No |
|`format` | `Optional[str]` | The file format (`delta`, `iceberg`). Defaults to `delta`. | Yes |
|`location` | `Optional[str]` | The storage location for an external table (for example, `abfss://<bucket-path>/<table-directory>`). | Yes |

The following types of tables can be written to in Databricks:

* **External Delta table:** The `location` parameter should specify the directory in cloud storage where the table should be stored. The `format` parameter defaults to `delta` so is not strictly required. Refer to the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/tables/external) for more information on external tables.
* **Managed Iceberg table:** The `format` parameter should be set to `iceberg`. The location where the table will be stored is determined by Unity Catalog, so the `location` parameter is not required. Refer to the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/iceberg) for more information on managed Iceberg tables.

###### `transforms.tables.DeltaTable`

Configures an output table in [Delta Lake ↗](https://docs.delta.io/latest/).

**Constructor:**

```python
DeltaTable(path: str)
```

| Parameter | Type | Description | Optional |
| --- | --- | --- | --- |
| `path` | `str` | The storage path to the Delta table. | No |

Can be used with [Azure Blob Filesystem](https://www.palantir.com/docs/foundry/available-connectors/onelake-and-azure-blob-filesystem/), [Google Cloud Storage](https://www.palantir.com/docs/foundry/available-connectors/google-cloud-storage/), or [Amazon S3](https://www.palantir.com/docs/foundry/available-connectors/amazon-s3/) sources.

###### `transforms.tables.FilesTable`

Configures an output table stored in Avro, CSV, or Parquet format in a cloud storage location.

**Constructor:**

```python
FilesTable(path: str, format: str)
```

| Parameter | Type | Description | Optional |
| --- | --- | --- | --- |
| `path` | `str` | The path to the folder . | No |
| `format` | `str` | The file format (`avro`, `csv`, `parquet`). | No |

Can be used with [Azure Blob Filesystem](https://www.palantir.com/docs/foundry/available-connectors/onelake-and-azure-blob-filesystem/), [Google Cloud Storage](https://www.palantir.com/docs/foundry/available-connectors/google-cloud-storage/), or [Amazon S3](https://www.palantir.com/docs/foundry/available-connectors/amazon-s3/) sources.

###### `transforms.tables.IcebergTable`

Configures an output table in an [Apache Iceberg ↗](https://iceberg.apache.org/docs/latest/) catalog.

**Constructor:**

```python
IcebergTable(table: str, warehouse_path: Optional[str] = None)
```

| Parameter | Type | Description | Optional |
| --- | --- | --- | --- |
| `table` | `str` | The full table identifier (for example, db.table or catalog notation). | No |
| `warehouse_path` | `Optional[str]` | The warehouse storage path for the Iceberg table. | Yes |

Refer to the [Iceberg catalogs](https://www.palantir.com/docs/foundry/data-integration/virtual-tables/#iceberg-catalogs) section of this documentation for more information on supported sources.

###### `transforms.tables.SnowflakeTable`

Configures an output table in [Snowflake ↗](https://docs.snowflake.com/).

**Constructor:**

```python
SnowflakeTable(database: str, schema: str, table: str)
```

| Parameter | Type | Description | Optional |
| --- | --- | --- | --- |
| `database` | `str` | The Snowflake database name. | No |
| `schema` | `str` | The schema name within the database. | No |
| `table` | `str` | The table name. | No |

---

### Compute pushdown

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/tables-compute-pushdown/

#### Compute pushdown

Tables backed by a [BigQuery](https://www.palantir.com/docs/foundry/available-connectors/bigquery/), [Databricks](https://www.palantir.com/docs/foundry/available-connectors/databricks/), or [Snowflake](https://www.palantir.com/docs/foundry/available-connectors/snowflake/) connection can push Foundry authored transforms to BigQuery, Databricks, or Snowflake. This is known as "compute pushdown", and allows Foundry's pipeline management, data lineage, and security functionality to be used on top of data warehouse compute. Use [virtual table](https://www.palantir.com/docs/foundry/data-integration/virtual-tables/) inputs and outputs to push down compute.

To use compute pushdown, all inputs and outputs must be virtual tables associated with the same source connection, and that source must be compute pushdown compatible (for example, BigQuery, Databricks, or Snowflake).

![Compute pushdown architecture diagram.](assets/foundry/transforms-python/compute-pushdown-diagram.png)

For more information and code examples, refer to the following source-specific compute pushdown documentation:

* [BigQuery compute pushdown](https://www.palantir.com/docs/foundry/transforms-python/tables-bigquery/)
* [Databricks compute pushdown](https://www.palantir.com/docs/foundry/transforms-python/tables-databricks/)
* [Snowflake compute pushdown](https://www.palantir.com/docs/foundry/transforms-python/tables-snowflake/)

---

### BigQuery compute pushdown

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/tables-bigquery/

#### BigQuery compute pushdown

To use compute pushdown with BigQuery, create a [Python repository](https://www.palantir.com/docs/foundry/transforms-python/overview/) and install the most recent version of the `transforms-tables` library.

An [Ibis ↗](https://ibis-project.org/) connection to BigQuery will be established based on the connection details of the BigQuery tables configured as inputs and/or outputs. Data can be transformed using the Ibis DataFrame API. For complete guidance on the Ibis API, consult the [Ibis documentation ↗](https://ibis-project.org/backends/bigquery).

Note the use of Foundry lightweight API syntax rather than Foundry Spark syntax in the following example of a BigQuery-backed Ibis transform:

```python
from transforms.api import transform
from transforms.tables import (
    IbisInput,
    IbisOutput,
    TableInput,
    TableOutput,
    BigQueryTable
)


@transform.bigquery.using(
    source_table=TableInput("ri.tables.main.table.1234"),
    output_table=TableOutput(
        "ri.tables.main.table.5678",
        "ri.magritte..source.1234",
        BigQueryTable("PROJECT", "DATASET", "TABLE"),
    ),
)
def compute(source_table: IbisInput, output_table: IbisOutput):
    # Data transformation with Ibis
    table = source_table.table()
    output_table.write(table)
```

> [!NOTE]
>
> Incremental computation using the `@incremental` decorator is not currently supported when using compute pushdown to BigQuery.

---

### Databricks compute pushdown

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/tables-databricks/

#### Databricks compute pushdown

Foundry offers the ability to push down compute to Databricks when using [virtual tables](https://www.palantir.com/docs/foundry/data-integration/virtual-tables/). When using Databricks virtual tables registered to the same source as inputs and outputs to a pipeline, it is possible to fully federate compute to Databricks.

This documentation walks you through the process of authoring a [Python transform](https://www.palantir.com/docs/foundry/transforms-python/transforms/) in Code Repositories that can be executed entirely in your Databricks environment. This capability leverages Databricks Connect. Refer to the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/dev-tools/databricks-connect) for more information on the features and limitations of Databricks Connect.

##### Quick start

This example shows how to use a Databricks transform in a [Python transform pipeline](https://www.palantir.com/docs/foundry/transforms-python/transforms/). Suppose we have the following Spark pipeline using PySpark via `@transform`:

```python
from pyspark.sql.functions import col
from transforms.api import transform, Input, Output


@transform.spark.using(
    source_table=Input('/Project/folder/input'),
    output_table=Output('/Project/folder/output'),
)
def compute(source_table: TransformInput, output_table: TransformOutput):
    df = source_table.dataframe()
    df = df.filter(col('id') > 1)
    output_table.write_dataframe(df)
```

To turn this into a Databricks transform, you must:

1. Review the [prerequisites to using tables in Python transforms](https://www.palantir.com/docs/foundry/transforms-python/tables-overview/#prerequisites).
2. Install `databricks-connect` from the [**Libraries** tab](https://www.palantir.com/docs/foundry/transforms-python/use-python-libraries/).
3. Import and apply the `@databricks` decorator to your transform.

For more details, consult the [setup](#setup) section of the documentation below.

```python
from pyspark.sql.functions import col
from transforms.api import transform
from transforms.tables import (
    databricks,
    DatabricksInput,
    DatabricksOutput,
    TableInput,
    TableOutput,
)


@transform.databricks.using(
    source_table=TableInput('/Project/folder/input'),
    output_table=TableOutput(
        '/Project/folder/output', # Where to register the Databricks output as a virtual table in Foundry
        "ri.magritte..source.1234", # Your Databricks source connection
       "CATALOG.SCHEMA.TABLE", # The location to which the transform output will be written in Databricks
    ),
)
def compute(source_table: DatabricksInput, output_table: DatabricksOutput):
    df = source_table.dataframe()
    df = df.filter(col('id') > 1)
    output_table.write_dataframe(df)
```

Given Databricks Connect uses the [`pyspark.sql.DataFrame` ↗](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.html) API, you will see the logic of the code itself is largely unchanged. The primary difference is the transform uses Spark compute running in Databricks.

`TableInput` and `TableOutput` parameters are used instead of `Input` and `Output` to reference the input and output Databricks virtual tables of the transform. The transform function is passed `DatabricksInput` and `DatabricksOutput` parameters that can be used to read from and write to tables in Databricks.

> [!WARNING]
>
> The `@databricks` decorator, as shown above, is only compatible with `TableInput` and `TableOutput` parameters. The tables referenced as inputs and outputs to the transform must be registered on the same [Databricks source](https://www.palantir.com/docs/foundry/available-connectors/databricks/).
>
> Incremental computation using the `@incremental` decorator is not currently supported when using compute pushdown to Databricks.

##### Setup

To use compute pushdown with Databricks:

1. Create a [Python code repository](https://www.palantir.com/docs/foundry/transforms-python/overview/).
2. Review the [prerequisites to using tables in Python transforms](https://www.palantir.com/docs/foundry/transforms-python/tables-overview/#prerequisites).
3. Install the `databricks-connect` library. We recommend using version 16.4, as this is fully compatible with serverless compute. If using classic compute, you must use a version that is compatible with your Databricks cluster version. Refer to the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/dev-tools/databricks-connect/requirements#databricks-connect-versions) for more information.

The `databricks-connect` library can be installed using the [**Libraries** tab](https://www.palantir.com/docs/foundry/transforms-python/use-python-libraries/) of your Code Repository environment. The library is only available via PyPI, and is not available through Conda. Alternatively, you can manually add the library under the `pip` requirements block in the `conda_recipe/meta.yaml` file. For example, to install version 16.4 of `databricks-connect`, add:

```yaml
requirements:
  pip:
   - databricks-connect >=16.4.0,<17.0.0
```

##### API highlights

The following sections highlight the differences between the Databricks transform API and a regular Python transform. Before using `@databricks`, ensure you have performed the [setup](#setup) steps above.

A Databricks transform uses `transforms.tables.TableInput` and `transforms.tables.TableOutput` parameters to reference the input and output Databricks virtual tables. A `TableInput` can reference a virtual table by file path or RID. A `TableOutput` requires:

1. The file path in Foundry where the virtual table will be created.
2. The [source](https://www.palantir.com/docs/foundry/data-connection/set-up-source/) where the virtual table will be registered.
3. The location in Databricks where the table will be written. This can be specified using `DatabricksTable("<catalog>", "<schema>", "<table>")` or `"<catalog>.<schema>.<table>"` syntax. `catalog`, `schema` and `table` correspond to the three-level namespace structure of a table identifier in Unity Catalog. Refer to the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/database-objects/) for more information.

The API of `DatabricksInput` and `DatabricksOutput` is similar to a regular Python transform. `.dataframe()` loads the input table as a `pyspark.sql.DataFrame`. `.write_dataframe()` writes a `pyspark.sql.DataFrame` to the output table. The transform logic itself can be expressed using PySpark transformation.

> [!WARNING]
>
> Not all features of PySpark are supported in Databricks Connect. Refer to the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/dev-tools/databricks-connect/python/limitations) for details on feature availability and limitations.

###### Output table types

You can write output tables in Databricks using one of the following table types:

* **Managed Delta:** Table stored in Delta Lake format in Databricks-managed storage.
* **External Delta:** Table stored in Delta Lake format in an external storage location.
* **Managed Iceberg:** Table stored in Iceberg format in Databricks-managed storage.

You can use the `format` and `location` parameters on `DatabricksTable` or `write_dataframe` to configure the output table type. If `format` and `location` are not specified the table will be written as a managed Delta table (the default table type in Databricks). Use `format="iceberg"` to write the output as a managed Iceberg table. Use `location="<STORAGE_LOCATION>"` to write the output as an external Delta table, where `<STORAGE_LOCATION>` refers to an external storage path in cloud object storage where the table will be stored.

The example below shows a transform writing to three output tables of different types.

```python
from transforms.tables import (
    databricks,
    DatabricksTable,
    DatabricksInput,
    DatabricksOutput,
    TableInput,
    TableOutput,
)

@transform.databricks.using(
    source_table=TableInput('/Project/folder/input'),
    managed_delta_output_table=TableOutput(
        '/Project/folder/output',
        "ri.magritte..source.1234",
       "CATALOG.SCHEMA.MANAGED_DELTA_TABLE",
    ),
    managed_iceberg_output_table=TableOutput(
        '/Project/folder/output',
        "ri.magritte..source.1234",
       "CATALOG.SCHEMA.MANAGED_ICEBERG_TABLE",
    ),
    external_delta_output_table=TableOutput(
        '/Project/folder/output',
        "ri.magritte..source.1234",
        DatabricksTable(
            catalog="CATALOG",
            schema="SCHEMA",
            table="EXTERNAL_DELTA_TABLE",
            location="s3://some-bucket/path/to/table"
        ),
    ),
)
def compute(
    source_table: DatabricksInput,
    managed_delta_output_table: DatabricksOutput,
    managed_iceberg_output_table: DatabricksOutput,
    external_delta_output_table: DatabricksOutput,
):
    df = source_table.dataframe()

    # write to a managed Delta table
    managed_delta_output_table.write_dataframe(df)

    # write to a managed Iceberg table by specifying the format option inline
    managed_iceberg_output_table.write_dataframe(df, format="iceberg")

    # write to an external table where the location has been specified in the DatabricksTable
    external_delta_output_table.write_dataframe(df)
```

Refer to the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/tables) for more information on table types.

###### Compute configuration

By default, a Databricks Connect session will be established using serverless compute. This is equivalent to using `@databricks(serverless=True)`.

Alternatively, you can use `with_compute(cluster_id="<cluster-id>")` to configure a connection to a specific compute cluster.

For information on compute configuration for Databricks Connect, review the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/dev-tools/databricks-connect/cluster-config).

###### User-defined functions (UDFs)

[User-defined functions (UDFs)](https://www.palantir.com/docs/foundry/transforms-python-spark/pyspark-udfs/) are supported in Databricks Connect. When you execute a PySpark DataFrame operation that includes UDFs, Databricks Connect serializes the UDF and sends it to the server as part of the request. For full details on UDF features and limitations, refer to the [official Databricks documentation ↗](https://docs.databricks.com/aws/en/dev-tools/databricks-connect/python/udf).

The example below defines a simple UDF that squares the values in a column:

```python
from pyspark.sql.functions import col, udf
from pyspark.sql.types import IntegerType
from transforms.api import transform
from transforms.tables import (
    databricks,
    DatabricksInput,
    DatabricksOutput,
    TableInput,
    TableOutput,
)


@udf(returnType=IntegerType())
def double(x):
    return x * x


@transform.databricks.using(
    source_table=TableInput('/Project/folder/input'),
    output_table=TableOutput(
        '/Project/folder/output',
        "ri.magritte..source.1234",
       "CATALOG.SCHEMA.TABLE",
    ),
)
def compute(source_table: DatabricksInput, output_table: DatabricksOutput):
    df = source_table.dataframe()
    df = df.withColumn("doubled", double(col("id")))
    output_table.write_dataframe(df)
```

###### Specify Python dependencies for UDFs

Databricks Connect supports specifying Python dependencies required for UDFs. These dependencies are installed on Databricks compute as part of the UDF's Python environment. You can use `with_dependencies(dependencies=["<dependency>"])` to configure additional dependencies to be installed in the UDF environment.

The example below defines a UDF that depends on the `pyjokes` package:

```python
from pyspark.sql.functions import col, udf
from pyspark.sql.types import StringType
from transforms.api import transform
from transforms.tables import databricks, DatabricksOutput, TableOutput


@udf(returnType=StringType())
def get_joke():
    from pyjokes import get_joke
    return get_joke()


@transform.databricks.using(
    output_table=TableOutput(
        '/Project/folder/output',
        "ri.magritte..source.1234",
       "CATALOG.SCHEMA.TABLE",
    ),
).with_dependencies(dependencies=["pyjokes<1"])
def compute(output_table: DatabricksOutput):
    df = output_table.spark_session.range(1, 10)
    df = df.withColumn("jokes", get_joke())
    output_table.write_dataframe(df)
```

> [!WARNING]
>
> If you encounter an error such as `ModuleNotFoundError: No module named 'myproject'`, it usually means your UDF is referencing code that exists only in your local environment and is not available to the Databricks Spark workers executing the UDF. To avoid this error, ensure that your UDF does not directly depend on functions or classes defined in local modules. You can resolve this in one of the following ways:
>
> * **Inline the necessary logic** directly within the UDF definition.
> * **Define both the UDF and its supporting code** within the body of the `@transform` function.
> * **Wrap the UDF and its supporting code in a function** that returns a reference to the UDF, and call this function within the transform to create the UDF.

---

### Snowflake compute pushdown

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/tables-snowflake/

#### Snowflake compute pushdown

To use compute pushdown with Snowflake, create a [Python repository](https://www.palantir.com/docs/foundry/transforms-python/overview/) and install the most recent version of the `transforms-tables` library.

A [Snowpark ↗](https://www.snowflake.com/en/data-cloud/snowpark/) session will be configured based on the connection details of the Snowflake tables configured as inputs and/or outputs to the transforms. Data can be transformed using the Snowpark DataFrame API. For complete guidance on the Snowpark API, consult the [Snowpark documentation ↗](https://docs.snowflake.com/en/developer-guide/snowpark/index).

Note the use of Foundry lightweight API syntax rather than Foundry Spark syntax in the following example of a Snowpark transform:

```python
from snowflake.snowpark.functions import col, udf
from snowflake.snowpark.types import StringType
import snowflake.snowpark as snow
from transforms.api import transform
from transforms.tables import (
    SnowflakeTable,
    TableInput,
    TableOutput,
    SnowflakeInput,
    SnowflakeOutput,
)

ID_PREFIX = "CUSTOMER-NO-"


@transform.snowflake.using(
    input_table=TableInput("ri.tables.main.table.1234"),
    output_table=TableOutput(
        "ri.tables.main.table.5678",
        "ri.magritte..source.1234",
        SnowflakeTable("DATABASE", "PUBLIC", "CUSTOMERS_CLEANED"),
    ),
)
def compute_in_snowflake(input_table: SnowflakeInput, output_table: SnowflakeOutput):
    """
    With Snowflake tables, you can perform lightweight transforms using the Snowpark APIs. All compute for these
    is pushed down to the underlying Snowflake instance, so this can tackle big data workloads. In a set up like this,
    all data must live in the same Snowpark instance and be accessible through the same connection.
    """
    # Get a Snowpark DataFrame instance
    df: snow.DataFrame = input_table.dataframe()
    session: snow.Session = df.session

    # Define a UDF to apply to our data
    @udf(session=session, return_type=StringType())
    def fix_id_col(ident: int) -> str:
        """
        UDF to convert ID to string and prepend "CUSTOMER-NO-".
        """
        return ID_PREFIX + str(ident)

    # Apply UDF
    df = df.with_column("ID", fix_id_col(col("ID")))

    # Write back to the new table
    output_table.write(df)
```

##### Compute configuration

By default, Foundry uses the warehouse you configure on the source to allocate compute resources.

Alternatively, you can use `.with_warehouse(warehouse="MY_WAREHOUSE")` to configure a connection with a specific warehouse:

```python
from transforms.api import transform
from transforms.tables import (
    SnowflakeTable,
    TableInput,
    TableOutput,
    SnowflakeInput,
    SnowflakeOutput,
)

# Transform with custom warehouse configuration
@transform.snowflake(
    source_table=TableInput(
        "ri.tables.main.table.my_snowflake_input_table"
    ),
    output_table=TableOutput(
        "ri.tables.main.table.my_snowflake_output_table",
        "ri.magritte..source.my_snowflake_source",
        SnowflakeTable("MY_DATABASE", "PUBLIC", "MY_TABLE"),
    ),
).with_warehouse("my_warehouse")
def compute(source_table: SnowflakeInput, output_table: SnowflakeOutput):
    df: snow.DataFrame = source_table.dataframe()
    output_table.write(df)
```

##### Use PySpark API with Spark Connect

As an alternative to Snowpark, you can use `.with_engine(engine="pyspark")` to establish a Snowpark Connect session. This will enable the use of PySpark APIs through Spark Connect. See [Snowpark Connect ↗](https://docs.snowflake.com/en/developer-guide/snowpark-connect/snowpark-connect-overview) for more information.

```python
from pyspark.sql.connect.dataframe import DataFrame
from pyspark.sql.connect.functions import lit
from pyspark.sql.connect.session import SparkSession
from transforms.api import transform
from transforms.tables import (
    TableInput,
    TableOutput,
    SnowparkConnectInput,
    SnowparkConnectOutput,
    SnowflakeTable
)

@transform.snowflake.using(
    input_table=TableInput("ri.tables.main.table.1234"),
    output_table=TableOutput(
        "ri.tables.main.table.5678",
        "ri.magritte..source.1234",
        SnowflakeTable("DATABASE", "PUBLIC", "CUSTOMERS_CLEANED_ANON"),
    ),
).with_engine("pyspark")
def compute(source_table: SnowparkConnectInput, output_table: SnowparkConnectOutput):
    # This will be a Spark Connect Dataframe instead of Snowpark
    df: DataFrame = source_table.dataframe()
    # Similarly this will be a Spark Connect session
    session: SparkSession = source_table.session

    df = df.withColumn("test", lit(3))
    output_table.write_dataframe(df)

```

##### Convert data into a pandas DataFrame

The Snowpark API allows data to be converted into a pandas DataFrame. If the scale of your data is small enough, this can be used to bring the data from Snowflake into Foundry lightweight compute. This enables the use of transforms beyond the capabilities of the Snowpark APIs, and allows Snowflake tables to be combined with other Foundry data.

```python
import hashlib
from transforms.api import transform
from transforms.tables import (
    SnowflakeTable,
    TableInput,
    TableOutput,
    SnowflakeInput,
    SnowflakeOutput,
)


@transform.snowflake.using(
    input_table=TableInput("ri.tables.main.table.1234"),
    output_table=TableOutput(
        "ri.tables.main.table.5678",
        "ri.magritte..source.1234",
        SnowflakeTable("DATABASE", "PUBLIC", "CUSTOMERS_CLEANED_ANON"),
    ),
)
def compute_local(input_table: SnowflakeInput, output_table: SnowflakeOutput):
    """
    Snowpark also supports conversion to pandas DataFrames, meaning that you can use lightweight
    transforms on top of Snowflake tables to conduct in-container compute work. You can use
    this to go beyond the scope of what is supported in Snowpark.
    """
    # Get a Snowpark DataFrame instance
    df = input_table.dataframe()
    session = df.session

    # Convert to pandas
    pd_df = df.to_pandas()

    # Create ANON_CODE by hashing the concatenation of CITY, STATE, and ZIP_CODE
    def generate_anon_code(row):
        concatenated = f"{row['CITY']}{row['STATE']}{row['ZIP_CODE']}"
        return hashlib.sha256(concatenated.encode("utf-8")).hexdigest()

    # Apply the function to create the ANON_CODE column
    pd_df["ANON_CODE"] = pd_df.apply(generate_anon_code, axis=1)

    # Select the ID and ANON_CODE columns
    result_data = pd_df[["ID", "ANON_CODE"]]

    # Write back to the new table
    new_df = session.create_dataframe(result_data, schema=["ID", "ANON_CODE"])
    output_table.write(new_df)
```

> [!NOTE]
>
> Incremental computation using the `@incremental` decorator is not currently supported when using compute pushdown to Snowflake.

---

### Lightweight API evolution

> **Link dokumentasi:** https://www.palantir.com/docs/foundry/transforms-python/lightweight-api-evolution/

#### Lightweight transforms API evolution

The transforms API for [lightweight compute](https://www.palantir.com/docs/foundry/transforms-python/compute-engines/) has evolved over time to support more streamlined syntax options.

Reference this page for details on the evolution of the lightweight API.

To start writing lightweight transforms, see [Getting started](https://www.palantir.com/docs/foundry/transforms-python/getting-started/) or the Polars and pandas examples in [Python transforms](https://www.palantir.com/docs/foundry/transforms-python/overview/). These pages explain how to use lightweight transforms as the default compute option.

##### Legacy syntax: @lightweight decorator

The original syntax for lightweight compute is the `@lightweight` decorator. This syntax option remains fully supported.

```python
from transforms.api import transform, lightweight, Input, Output


@lightweight
@transform(
    output=Output("/path/data/output"),
    input=Input("/path/data/input"),
)
def clean(output, input):
    df = input.pandas()
    output.write_table(df)
```

##### Updated syntax for Lightweight

The new recommended syntax for accessing lightweight transforms is `@transform.using`. This API removes the need for additional lightweight imports and streamlines the creation of lightweight transforms as the default.

The new API is available from transforms version 3.68.0 and higher. To make this available in Code Repositories, upgrade your repository with the [repository upgrade guide](https://www.palantir.com/docs/foundry/code-repositories/repository-upgrades/). Ensure that the `transformsLangPythonPluginVersion` is equal to 1.978.0 or higher.

To learn more about transforms versions, see the [transforms versions overview](https://www.palantir.com/docs/foundry/transforms-common/transforms-versions/).

```python
from transforms.api import transform, Input, Output


@transform.using(
    output=Output("/path/data/output"),
    input=Input("/path/data/input"),
)
def clean(output, input):
    df = input.pandas()
    output.write_table(df)
```

To summarize, you can create a Lightweight transform using any of the below syntax options:

* Updated API:<br>`@transform.using(...)`
* Updated API explicitly referencing Lightweight:<br>`@transform.lightweight(...)`
* Legacy API with @lightweight decorator:<br>`@lightweight` <br>`@transform(...)`

##### Updated syntax for Spark

Alongside the new, default lightweight API, there is a new transforms API for Spark. The recommended syntax is `@transform.spark.using`.

The new API is available from transforms version 3.95.0 and higher. To make this available in Code Repositories, upgrade your repository with the [repository upgrade guide](https://www.palantir.com/docs/foundry/code-repositories/repository-upgrades/). Ensure that the `transformsLangPythonPluginVersion` is equal to 1.1003.0 or higher.

```python
from transforms.api import transform, Input, Output


@transform.spark.using(
    output=Output("/path/data/output"),
    input=Input("/path/data/input"),
)
def clean(output, input):
    df = input.dataframe()
    output.write_dataframe(df)
```

##### Updated syntax for Databricks Connect

To define transforms that push down compute to Databricks via Databricks Connect, use the combined decorator `@transform.databricks.using`. This standardized syntax replaces patterns that previously mixed `@databricks` and `@transform` decorators.

You can chain configuration methods to specify compute and dependencies:

* `with_compute(cluster_id="<cluster-id>")` to connect to a specific Databricks compute cluster
* `with_dependencies(dependencies=["<dependency>"])` to install Python packages required by UDFs on Databricks compute

By default, Databricks Connect establishes a session using serverless compute.

```python
from pyspark.sql.functions import col
from transforms.api import transform
from transforms.tables import DatabricksInput, DatabricksOutput, TableInput, TableOutput

@transform.databricks.using(
    source_table=TableInput('/Project/folder/input'),
    output_table=TableOutput(
        '/Project/folder/output',           # Register virtual table in Foundry
        'ri.magritte..source.1234',         # Databricks source connection RID
        'CATALOG.SCHEMA.TABLE',             # Unity Catalog table target in Databricks
    ),
).with_compute(cluster_id="<cluster-id>")
def compute(source_table: DatabricksInput, output_table: DatabricksOutput):
    df = source_table.dataframe()
    df = df.filter(col('id') > 1)
    output_table.write_dataframe(df)
```

For UDFs that require additional Python dependencies, configure them with `with_dependencies`:

```python
from pyspark.sql.functions import udf
from pyspark.sql.types import StringType
from transforms.api import transform
from transforms.tables import DatabricksOutput, TableOutput

@udf(returnType=StringType())
def get_joke():
    from pyjokes import get_joke
    return get_joke()

@transform.databricks.using(
    output_table=TableOutput(
        '/Project/folder/output',
        'ri.magritte..source.1234',
        'CATALOG.SCHEMA.TABLE',
    ),
).with_dependencies(dependencies=["pyjokes<1"])
def compute(output_table: DatabricksOutput):
    df = output_table.spark_session.range(1, 10)
    df = df.withColumn('jokes', get_joke())
    output_table.write_dataframe(df)
```

##### Troubleshoot version errors with @transform.using

If you receive an error message similar to the following, you may be on an older version of the transforms library that does not support the updated syntax.

* `Usage of transform.using() on outdated repository`
* `A function object does not have an attribute using`

To resolve this issue, try the following options:

* Upgrade your repository to the latest version of the `transforms` library and repository template following [the repository upgrade guide](https://www.palantir.com/docs/foundry/code-repositories/repository-upgrades/).
* Switch to [legacy syntax](#legacy-syntax-lightweight-decorator).
