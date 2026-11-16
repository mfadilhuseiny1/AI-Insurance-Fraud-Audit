"""Database connectors: the registry of connector types.

Adding a database: write a `DatabaseConnector` (usually a `SqlConnector` dialect) in its own module
and give its `ConnectorSpec` a factory below. Specs without a factory are listed in the UI (with
their connection form) as not available.

Foundry's connector catalog (catalog.json) follows: every catalog connector is implemented from its
vendor's API documentation (catalog_specs.py), with its capabilities, configuration properties and
network domains for reference.
"""

from __future__ import annotations

import contextlib
import functools
import inspect
import re
import types
from typing import Any, Callable, Iterator, Optional
from urllib.parse import urlparse

from . import catalog, catalog_specs
from .airtable_conn import AirtableConnector
from .base import ConnectorError, ConnectorSpec, DatabaseConnector, Field, OAuthApp, SqlConnector, host_fields
from .bigquery_conn import BigQueryConnector
from .clickhouse_conn import ClickHouseConnector
from .couchdb_conn import CouchDbConnector
from .crm import HubSpotConnector, SalesforceConnector
from .databricks_conn import DatabricksConnector
from .dynamodb_conn import DynamoDbConnector
from .files_conn import FileConnector, FilesystemConnector, S3Connector
from .influxdb_conn import InfluxConnector
from .mongodb_conn import MongoConnector
from .mysql import MySqlConnector
from .records import RecordConnector
from .oracle import OracleConnector
from .rest import RestConnector
from .sap import SapConnector
from .postgres import PostgresConnector, RedshiftConnector, TimescaleConnector
from .iceberg_conn import IcebergRestConnector
from .snowflake_conn import SnowflakeConnector
from .sqlserver import SqlServerConnector

__all__ = ["ConnectorError", "DatabaseConnector", "SPECS", "spec", "open_connector"]

SPECS: list[ConnectorSpec] = [
    # -- SQL --
    ConnectorSpec("postgresql", "PostgreSQL", "sql", "Open-source relational database", host_fields(5432), PostgresConnector),
    ConnectorSpec("mysql", "MySQL", "sql", "Relational database", host_fields(3306, database_required=False), MySqlConnector, schemas=False),
    ConnectorSpec("mariadb", "MariaDB", "sql", "MySQL-compatible relational database", host_fields(3306, database_required=False), MySqlConnector, schemas=False),
    ConnectorSpec("sqlserver", "SQL Server", "sql", "Microsoft SQL Server and Azure SQL", host_fields(1433), SqlServerConnector),
    ConnectorSpec(
        "oracle",
        "Oracle",
        "sql",
        "Oracle Database",
        [
            Field("host", "Host"),
            Field("port", "Port", "number", default=1521),
            Field("service_name", "Service name", placeholder="ORCLPDB1"),
            Field("user", "Username"),
            Field("password", "Password", "password", secret=True),
            Field("ssl", "TCPS (TLS)", "bool", required=False, default=False, help="Use the TCPS protocol (Oracle Autonomous Database, TLS listeners)"),
        ],
        OracleConnector,
    ),
    # -- external Iceberg catalogs (virtual Iceberg tables) --
    ConnectorSpec(
        "iceberg-rest",
        "Iceberg REST catalog",
        "warehouse",
        "Virtual Iceberg tables in an external catalog: Polaris, Snowflake Open Catalog / Horizon, Unity Catalog, AWS Glue, Nessie",
        [
            Field("uri", "Catalog URI", placeholder="https://polaris.example.com/api/catalog", help="The Iceberg REST endpoint (Unity: https://<workspace>/api/2.1/unity-catalog/iceberg-rest; Glue: https://glue.<region>.amazonaws.com/iceberg)"),
            Field("warehouse", "Warehouse / catalog name", required=False, help="Unity: the catalog name; Glue: the account id; Polaris: the catalog"),
            Field("auth_type", "Authentication", "select", default="Bearer token", options=["Bearer token", "OAuth 2.0 client credentials", "AWS SigV4", "None"]),
            Field("token", "Token", "password", secret=True, required=False, help="Bearer token: a personal access token or catalog token"),
            Field("client_id", "Client ID", required=False, help="OAuth 2.0 client credentials (Polaris, Open Catalog)"),
            Field("client_secret", "Client secret", "password", secret=True, required=False),
            Field("scope", "Scope", required=False, placeholder="PRINCIPAL_ROLE:ALL"),
            Field("oauth2_server_uri", "OAuth 2.0 token URL", required=False, help="Default: <uri>/v1/oauth/tokens"),
            Field("region", "AWS region", required=False, help="AWS SigV4 (Glue) and S3"),
            Field("signing_name", "SigV4 signing name", required=False, default="glue"),
            Field("access_key_id", "AWS access key ID", required=False, help="SigV4 and S3 reads when the catalog does not vend credentials"),
            Field("secret_access_key", "AWS secret access key", "password", secret=True, required=False),
            Field("session_token", "AWS session token", "password", secret=True, required=False),
            Field("s3_endpoint", "S3 endpoint", required=False, help="S3-compatible storage (MinIO, …)"),
            Field("vended_credentials", "Ask the catalog for storage credentials", "bool", required=False, default=True,
                  help="X-Iceberg-Access-Delegation: vended-credentials"),
            Field("properties", "More PyIceberg properties", "textarea", required=False, placeholder="adls.account-name=…\ngcs.project-id=…",
                  help="key=value per line"),
        ],
        IcebergRestConnector,
        endpoint=catalog_specs._url_host("uri"),
        exports=False,
    ),
    # -- data warehouses --
    ConnectorSpec(
        "bigquery",
        "BigQuery",
        "warehouse",
        "Google Cloud data warehouse",
        [
            Field("project_id", "Project ID", placeholder="my-gcp-project"),
            Field("location", "Location", required=False, placeholder="US"),
            Field("service_account", "Service account key (JSON)", "textarea", secret=True, help="A key for a service account with BigQuery Data Viewer and Job User roles"),
            Field("maximum_gb_billed", "Maximum GB billed per query", "number", required=False, help="Optional cap for incremental queries (previews and table snapshots are free reads)"),
        ],
        BigQueryConnector,
    ),
    ConnectorSpec(
        "snowflake",
        "Snowflake",
        "warehouse",
        "Cloud data warehouse",
        [
            Field("account", "Account identifier", placeholder="myorg-myaccount"),
            Field("warehouse", "Warehouse"),
            Field("database", "Database"),
            Field("role", "Role", required=False),
            Field("user", "Username"),
            Field("password", "Password", "password", secret=True, required=False),
            Field("private_key", "Private key (PEM)", "textarea", secret=True, required=False, help="Key-pair authentication instead of a password"),
        ],
        SnowflakeConnector,
    ),
    ConnectorSpec(
        "databricks",
        "Databricks",
        "warehouse",
        "Lakehouse SQL warehouses",
        [
            Field("server_hostname", "Server hostname", placeholder="adb-123.azuredatabricks.net"),
            Field("http_path", "HTTP path", placeholder="/sql/1.0/warehouses/abc123"),
            Field("catalog", "Catalog", required=False, default="main"),
            Field("access_token", "Personal access token", "password", secret=True),
        ],
        DatabricksConnector,
    ),
    ConnectorSpec("redshift", "Redshift", "warehouse", "Amazon Redshift (PostgreSQL protocol)", host_fields(5439), RedshiftConnector),
    # -- time series --
    ConnectorSpec(
        "influxdb",
        "InfluxDB",
        "timeseries",
        "Time-series database",
        [
            Field("url", "URL", placeholder="https://us-east-1-1.aws.cloud2.influxdata.com"),
            Field("org", "Organization"),
            Field("bucket", "Bucket", required=False),
            Field("token", "API token", "password", secret=True),
        ],
        InfluxConnector,
        schemas=False,
    ),
    ConnectorSpec("timescaledb", "TimescaleDB", "timeseries", "PostgreSQL for time series (hypertables)", host_fields(5432), TimescaleConnector),
    ConnectorSpec(
        "clickhouse",
        "ClickHouse",
        "timeseries",
        "Columnar analytics database",
        host_fields(8443, database_required=False),
        ClickHouseConnector,
        schemas=False,
    ),
    # -- NoSQL --
    ConnectorSpec(
        "mongodb",
        "MongoDB",
        "nosql",
        "Document database (collections as tables)",
        [
            Field("uri", "Connection string", "password", secret=True, placeholder="mongodb+srv://user:pass@cluster.example.net"),
            Field("database", "Database", required=False, help="Optional when the connection string names a database"),
        ],
        MongoConnector,
        schemas=False,
    ),
]


# -- connectors from the catalog that this server implements --


def _s3_endpoint(config: dict) -> tuple[Optional[str], Optional[int]]:
    endpoint = (config.get("endpoint") or "").strip()
    if endpoint:
        return catalog_specs._url_host("endpoint")({"endpoint": endpoint if "://" in endpoint else f"https://{endpoint}"})
    m = re.match(r"s3a?://([^/]+)", config.get("url") or "")
    region = config.get("region") or ""
    if not m:
        return None, None
    return f"{m.group(1)}.s3.{region}.amazonaws.com" if region else f"{m.group(1)}.s3.amazonaws.com", 443


def _dynamodb_endpoint(config: dict) -> tuple[Optional[str], Optional[int]]:
    return catalog_specs._url_host("endpoint_url", f"https://dynamodb.{config.get('region') or 'us-east-1'}.amazonaws.com")(config)


_AWS_KEYS = [
    Field("access_key_id", "Access key ID", required=False, help="Leave empty to use this server's AWS credentials (environment or instance role)"),
    Field("secret_access_key", "Secret access key", "password", secret=True, required=False),
    Field("session_token", "Session token", "password", secret=True, required=False, help="For temporary credentials only"),
]

# (catalog slug, spec) — the slug links the spec to its catalog entry (None: not in the catalog)
_IMPLEMENTED: list[tuple[Optional[str], ConnectorSpec]] = [
    (
        "alloydb",
        ConnectorSpec("alloydb", "AlloyDB", "sql", "Google Cloud's PostgreSQL-compatible database", host_fields(5432), PostgresConnector),
    ),
    (
        "azure-synapse",
        ConnectorSpec(
            "azure-synapse",
            "Azure Synapse",
            "warehouse",
            "Azure Synapse Analytics SQL pools (SQL Server protocol)",
            [
                Field("host", "Host", placeholder="myworkspace.sql.azuresynapse.net"),
                *host_fields(1433)[1:],
            ],
            SqlServerConnector,
        ),
    ),
    (
        "amazon-s3",
        ConnectorSpec(
            "amazon-s3",
            "Amazon S3",
            "storage",
            "CSV, Parquet and JSON files in S3 buckets",
            [
                Field("url", "URL", placeholder="s3://bucket-name/", help="The bucket, optionally with a folder: s3://bucket-name/folder/"),
                Field("region", "Region", required=False, placeholder="us-east-1"),
                Field("endpoint", "Endpoint", required=False, placeholder="s3.us-east-1.amazonaws.com", help="Only for S3-compatible stores (MinIO, R2) or a specific endpoint"),
                *_AWS_KEYS,
                Field("sts_role_arn", "STS role ARN", required=False, placeholder="arn:aws:iam::123456789012:role/foundry-read", help="Assume this role with the credentials above"),
                Field("path_style", "Path-style access", "bool", required=False, default=False, help="https://endpoint/bucket/key instead of https://bucket.endpoint/key"),
            ],
            S3Connector,
            endpoint=_s3_endpoint,
        ),
    ),
    (
        "filesystem",
        ConnectorSpec(
            "filesystem",
            "Agent-level filesystem",
            "storage",
            "Files in a directory on this server (NFS / NAS mounts)",
            [
                Field("root_directory", "Root directory", placeholder="/mnt/share/exports", help="An absolute path below BLUESANDAI_FILESYSTEM_ROOTS (default: data/filesystem)"),
                Field("file_must_not_change", "File must not change for", required=False, default="PT2S", help="ISO-8601 duration a file must stay unchanged before it is read"),
            ],
            FilesystemConnector,
        ),
    ),
    (
        "amazon-dynamodb",
        ConnectorSpec(
            "amazon-dynamodb",
            "Amazon DynamoDB",
            "nosql",
            "Key-value and document tables",
            [
                Field("region", "Region", placeholder="us-east-1"),
                *_AWS_KEYS,
                Field("endpoint_url", "Endpoint URL", required=False, placeholder="http://localhost:8000", help="Only for DynamoDB Local or a VPC endpoint"),
            ],
            DynamoDbConnector,
            schemas=False,
            endpoint=_dynamodb_endpoint,
        ),
    ),
    (
        "apache-couchdb",
        ConnectorSpec(
            "apache-couchdb",
            "Apache CouchDB",
            "nosql",
            "Document databases over HTTP",
            [
                Field("url", "URL", placeholder="https://couch.example.com:6984"),
                Field("user", "Username", required=False),
                Field("password", "Password", "password", secret=True, required=False),
            ],
            CouchDbConnector,
            schemas=False,
        ),
    ),
    (
        "airtable",
        ConnectorSpec(
            "airtable",
            "Airtable",
            "apps",
            "Bases and tables",
            [
                Field("token", "Personal access token", "password", secret=True, required=False, help="Scopes data.records:read and schema.bases:read, with access to the bases (or sign in below)"),
                Field("base_id", "Base ID", required=False, placeholder="appXXXXXXXXXXXXXX", help="Only this base (otherwise every base the token can read)"),
                *catalog_specs._signin("An OAuth integration from airtable.com/create/oauth (scopes data.records:read, schema.bases:read)"),
                Field("scope", "OAuth scopes", required=False, default="data.records:read schema.bases:read",
                      help="Requested at Sign in; add data.records:write for table exports (a personal access token needs that scope too)"),
            ],
            AirtableConnector,
            schemas=False,
            endpoint=lambda config: ("api.airtable.com", 443),
            oauth=OAuthApp(lambda v: "https://airtable.com/oauth2/v1/authorize", lambda v: "https://airtable.com/oauth2/v1/token",
                           scope="data.records:read schema.bases:read", scope_field="scope", client_auth="auto"),
        ),
    ),
    (
        None,
        ConnectorSpec(
            "salesforce",
            "Salesforce",
            "apps",
            "sObjects read with SOQL; table exports create or upsert records (REST API)",
            [
                Field("url", "My Domain URL", placeholder="https://yourcompany.my.salesforce.com",
                      help="Setup → My Domain (sandboxes: https://yourcompany--sandbox.sandbox.my.salesforce.com)"),
                Field("client_id", "Consumer key", required=False, help="Of a connected app (or External Client App) with the OAuth scopes api and refresh_token"),
                Field("client_secret", "Consumer secret", "password", secret=True, required=False,
                      help="With the consumer key alone (no Sign in), the app's client credentials flow is used"),
                Field("refresh_token", "Refresh token", "password", secret=True, required=False, help="Filled by Sign in (or paste one)"),
            ],
            SalesforceConnector,
            schemas=False,
            endpoint=lambda config: (urlparse(str(config.get("url") or "")).hostname, 443),
            oauth=OAuthApp(lambda v: f"{str(v.get('url') or '').rstrip('/')}/services/oauth2/authorize",
                           lambda v: f"{str(v.get('url') or '').rstrip('/')}/services/oauth2/token", scope="api refresh_token", client_auth="body"),
        ),
    ),
    (
        None,
        ConnectorSpec(
            "hubspot",
            "HubSpot",
            "apps",
            "CRM objects and custom objects; table exports create or upsert records (CRM API v3)",
            [
                Field("token", "Private app access token", "password", secret=True, required=False,
                      help="Settings → Integrations → Private apps (scopes crm.objects.*.read, and .write for table exports), or sign in below"),
                *catalog_specs._signin("A public app from developers.hubspot.com (redirect URL below)"),
                Field("scope", "OAuth scopes", required=False,
                      default="oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write",
                      help="Requested at Sign in"),
            ],
            HubSpotConnector,
            schemas=False,
            endpoint=lambda config: ("api.hubapi.com", 443),
            oauth=OAuthApp(lambda v: "https://app.hubspot.com/oauth/authorize", lambda v: "https://api.hubapi.com/oauth/v1/token",
                           scope_field="scope", client_auth="body", pkce=False),
        ),
    ),
]

# existing connectors that are in the catalog
_CATALOG_IDS = {"redshift": "aws-redshift", "bigquery": "bigquery"}

def _complete(s: ConnectorSpec, slug: Optional[str]) -> ConnectorSpec:
    """Attach the catalog reference and capabilities to a spec."""
    for k, v in catalog.reference(slug).items():
        setattr(s, k, v)
    f = s.factory if isinstance(s.factory, type) else None
    features = set()
    if f and issubclass(f, SqlConnector) and s.exports:
        features.add("Table exports")
        s.export_kind = "table"
    if f and issubclass(f, RecordConnector) and f.exports_records:
        # records created (or upserted) through the application's write API (exports.py)
        features.add("Table exports")
        s.export_kind = "records"
    if f and issubclass(f, FileConnector):
        features |= {"Media sets", "File exports"}
    if f and issubclass(f, SapConnector):
        # with the Palantir SAP add-on: BAPI write-back and DMS documents (sap_tools.py)
        features |= {"Webhooks", "Media sets"}
    if s.oauth or (f and getattr(f, "oauth_based", False)) or (f and issubclass(f, RestConnector) and (f.auth == "oauth2" or f.oauth is not RestConnector.oauth)):
        features.add("OAuth 2.0 authentication")
    s.capabilities = catalog.capabilities(slug, s.available, features)
    return s


for _s in SPECS:
    _complete(_s, _CATALOG_IDS.get(_s.id))
for _slug, _s in [*_IMPLEMENTED, *catalog_specs.SPECS]:
    SPECS.append(_complete(_s, _slug))

_BY_ID = {s.id: s for s in SPECS}


def spec(kind: str) -> ConnectorSpec:
    s = _BY_ID.get(kind)
    if not s:
        raise ConnectorError(f'Unknown database type "{kind}"')
    return s


def open_connector(kind: str, config: dict, secrets: dict) -> DatabaseConnector:
    s = spec(kind)
    if not s.available:
        raise ConnectorError(f"{s.name} connections are not available yet")
    missing = s.missing(config, secrets)
    if missing:
        raise ConnectorError(f"Missing: {', '.join(missing)}")
    what = f"This {s.name} connection"
    with _egress_scope(what):
        connector = s.factory(config, secrets)  # type: ignore[misc]
    connector.spec = s
    _scope_methods(connector, what)
    return connector


@contextlib.contextmanager
def _egress_scope(what: str) -> Iterator[None]:
    try:
        import network
    except ImportError:  # outside the API server (no policies)
        yield
        return
    try:
        with network.egress_scope(what):
            yield
    except network.EgressDenied as e:  # callers handle connector errors
        raise ConnectorError(str(e)) from None


def _scope_methods(connector: DatabaseConnector, what: str) -> None:
    """Run each of the connector's methods (and the batches its generators yield) in an egress
    scope, so every host it reaches — not only the configured one — is checked against egress
    policies (network.py)."""

    def scoped(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        def call(*args: Any, **kwargs: Any) -> Any:
            with _egress_scope(what):
                r = fn(*args, **kwargs)
            return _scoped_iter(r) if isinstance(r, types.GeneratorType) else r

        return call

    def _scoped_iter(it: Iterator[Any]) -> Iterator[Any]:
        try:
            while True:
                with _egress_scope(what):
                    try:
                        v = next(it)
                    except StopIteration:
                        return
                yield v
        finally:
            with _egress_scope(what):
                it.close()

    for name in dir(type(connector)):
        if name.startswith("_") or isinstance(inspect.getattr_static(connector, name), (property, staticmethod, classmethod)):
            continue
        fn = getattr(connector, name, None)
        if inspect.ismethod(fn):
            setattr(connector, name, scoped(fn))
