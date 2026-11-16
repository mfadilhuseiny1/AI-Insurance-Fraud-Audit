"""Connection forms of the catalog connectors (apps.py, odata.py, netsuite.py, dbs.py).

Each entry is (catalog slug, ConnectorSpec): the fields follow the vendor's connection docs (what
its sign-in needs), `endpoint` names the host egress policies must allow, and `oauth` turns on the
"Sign in" button for providers whose docs use the authorization code flow.
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlparse

from . import apps, dbs, netsuite, odata, sap
from .base import ConnectorSpec, Field, OAuthApp


def _host(host: str, port: int = 443):  # noqa: ANN202
    return lambda config: (host, port)


def _url_host(key: str = "url", default: str = ""):  # noqa: ANN202
    def endpoint(config: dict) -> tuple[Optional[str], Optional[int]]:
        u = urlparse(str(config.get(key) or default))
        return u.hostname, u.port or (80 if u.scheme == "http" else 443)

    return endpoint


def _netsuite_host(config: dict) -> tuple[Optional[str], Optional[int]]:
    return f"{netsuite.account_host(config.get('account_id') or 'account')}.suitetalk.api.netsuite.com", 443


def _secret(name: str, label: str, required: bool = True, help: str = "", textarea: bool = False) -> Field:
    return Field(name, label, "textarea" if textarea else "password", secret=True, required=required, help=help)


_OAUTH_CLIENT = [
    Field("client_id", "Client ID"),
    _secret("client_secret", "Client secret"),
]


def _signin(help: str = "") -> list[Field]:
    """Client of the user's OAuth app + the token the Sign in button fills."""
    return [
        Field("client_id", "OAuth client ID", required=False, help=help),
        _secret("client_secret", "OAuth client secret", required=False),
        _secret("refresh_token", "Refresh token", required=False, help="Filled by Sign in (or paste one)"),
    ]


def _odata_fields(url_ph: str, services_ph: str = "", services_default: str = "", catalog: bool = False, sap_client: bool = False, user_help: str = "", sap: bool = False) -> list[Field]:
    f = [Field("url", "URL", placeholder=url_ph)]
    if catalog:
        f.append(Field("gateway_catalog", "List services from the Gateway catalog", "bool", required=False, default=True,
                       help="Reads /sap/opu/odata/IWFND/CATALOGSERVICE;v=2 (needs authorization for the catalog service)"))
    f.append(Field("service_urls", "OData services", "textarea", required=not (catalog or sap), default=services_default or None, placeholder=services_ph,
                   help="One service path (or URL) per line; each service is a database, its entity sets are tables"))
    if sap_client:
        f.append(Field("sap_client", "SAP client", required=False, placeholder="100"))
    f += [
        Field("auth_type", "Authentication", "select", default="Basic",
              options=["Basic", *(["OAuth 2.0 (named user)"] if sap else []), "OAuth 2.0 client credentials", "Bearer token", "None"],
              help="OAuth 2.0 (named user): sign in below so SAP applies that user's authorizations" if sap else ""),
        Field("user", "Username", required=False, help=user_help),
        _secret("password", "Password", required=False),
        Field("token_url", "Token URL", required=False, help="OAuth 2.0 only (named user default: <URL>/sap/bc/sec/oauth2/token)" if sap else "OAuth 2.0 client credentials only"),
        Field("client_id", "Client ID", required=False, help="Named user: the OAuth 2.0 client ID from SOAUTH2 (the technical user)" if sap else ""),
        _secret("client_secret", "Client secret", required=False, help="Named user: that client user's password" if sap else ""),
        Field("scope", "Scope", required=False, default="/PALANTIR/SRV_0001" if sap else None,
              help="The OAuth 2.0 scope ID assigned in SOAUTH2 (add-on write-back: /PALANTIR/SRV_0001; OData: the service's scope)" if sap else ""),
        _secret("token", "Bearer token", required=False),
    ]
    if sap:
        f += [
            _secret("refresh_token", "Refresh token", required=False, help="Named user: filled by Sign in"),
            Field("use_addon", "Palantir SAP add-on", "bool", required=False, default=False,
                  help="The Palantir Foundry Connector 2.0 for SAP Applications is installed: BAPI write-back, function modules as tables, DMS documents, resource checks"),
            Field("addon_url", "Add-on URL", required=False, placeholder="https://s4.example.com:44300/sap/palantir", help="Default: <URL>/sap/palantir"),
            Field("function_tables", "Function tables", "textarea", required=False,
                  placeholder='BAPI_COMPANYCODE_GETLIST -> COMPANYCODE_LIST\nBAPI_MATERIAL_GETLIST -> MATNRLIST {"MAXROWS": 1000}',
                  help="Add-on: function modules read as tables — FUNCTION -> OUTPUT_TABLE, optionally with JSON inputs (called without commit)"),
            Field("dms_filters", "DMS document filters", required=False, placeholder="DOCUMENTTYPE=CPT, FILEFORMAT=pdf", help="Add-on: filters of the SAP DMS documents table"),
            Field("row_filters", "Sync filters", "textarea", required=False,
                  placeholder="A_SalesOrder: SalesOrganization eq '1010'\n*: CreationDate ge datetime'[ADDDAY([TODAY],-30)]'",
                  help="Per entity set (or * for all): an OData $filter always applied, with dynamic keywords [TODAY], [CURRENTYEAR], [FIRSTDAYOFMONTH], [ADDDAY(d,n)], [ADDMONTH(d,n)], …"),
            Field("masking", "Sensitive fields", "textarea", required=False,
                  placeholder="A_BusinessPartner.TaxNumber1 = sha256\nA_BusinessPartner.PhoneNumber = mask:*:\\d(?=\\d{4})\nA_BusinessPartner.BirthDate = hide",
                  help="EntitySet.Field = hide | md5 | sha1 | sha256 | mask:* | mask:# | mask:clear (optionally :regex); add \"new\" to write FIELD_HASH / FIELD_MASKED instead"),
            Field("timestamp_columns", "Add sync timestamp columns", "bool", required=False, default=False,
                  help="Adds /PALANTIR/TIMESTAMP (sync run time) and /PALANTIR/ROWNO (record order) for removing duplicates downstream"),
        ]
    return f


# SAP NetWeaver AS ABAP OAuth 2.0 server (transaction SOAUTH2), named-user sign-in
_SAP_OAUTH = OAuthApp(
    lambda v: f"{str(v['url']).rstrip('/')}/sap/bc/sec/oauth2/authorize",
    lambda v: str(v.get("token_url") or "").strip() or f"{str(v['url']).rstrip('/')}/sap/bc/sec/oauth2/token",
    scope_field="scope", client_auth="basic", pkce=False,
)


def _start(default_days: str = "") -> Field:
    return Field("start_date", "Read from", required=False, placeholder="2024-01-01", help=f"Earliest date of the first sync{default_days}")


SPECS: list[tuple[str, ConnectorSpec]] = [
    # -- databases --
    ("apache-hive", ConnectorSpec(
        "apache-hive", "Apache Hive", "warehouse", "HiveServer2 (Thrift) data warehouse",
        [
            Field("host", "Host", placeholder="hive.example.com"),
            Field("port", "Port", "number", default=10000),
            Field("database", "Database", required=False, default="default"),
            Field("auth_mode", "Authentication", "select", default="NONE", options=["NONE", "LDAP", "CUSTOM", "NOSASL"]),
            Field("user", "Username", required=False),
            _secret("password", "Password", required=False),
        ],
        dbs.HiveConnector, schemas=False, exports=False,
    )),
    ("apache-phoenix", ConnectorSpec(
        "apache-phoenix", "Apache Phoenix", "sql", "SQL over HBase through the Phoenix Query Server",
        [
            Field("url", "Query Server URL", placeholder="http://phoenix.example.com:8765/"),
            Field("authentication", "Authentication", "select", default="BASIC", options=["BASIC", "DIGEST", "SPNEGO"]),
            Field("user", "Username", required=False),
            _secret("password", "Password", required=False),
        ],
        dbs.PhoenixConnector, exports=False,
    )),
    ("apache-hbase", ConnectorSpec(
        "apache-hbase", "Apache HBase", "nosql", "Wide-column tables through the HBase REST server",
        [
            Field("url", "REST server URL", placeholder="http://hbase.example.com:8080"),
            Field("user", "Username", required=False),
            _secret("password", "Password", required=False),
        ],
        dbs.HBaseConnector, schemas=False,
    )),
    ("azure-cosmos-db", ConnectorSpec(
        "azure-cosmos-db", "Azure Cosmos DB", "nosql", "NoSQL API containers",
        [
            Field("url", "Account endpoint", placeholder="https://myaccount.documents.azure.com:443/"),
            _secret("key", "Primary or read-only key"),
            Field("database", "Database", required=False, help="Only this database (otherwise all)"),
        ],
        dbs.CosmosConnector, schemas=False,
    )),
    ("azure-table-storage", ConnectorSpec(
        "azure-table-storage", "Azure Table Storage", "nosql", "Entities of Azure Storage tables",
        [
            Field("account", "Storage account", placeholder="mystorageaccount"),
            _secret("account_key", "Account key", required=False, help="Shared Key Lite authentication"),
            _secret("sas_token", "SAS token", required=False, help="Instead of the account key: a SAS with table read and list"),
            Field("url", "Table endpoint", required=False, placeholder="https://mystorageaccount.table.core.windows.net"),
        ],
        dbs.AzureTableConnector, schemas=False,
        endpoint=lambda c: (urlparse(c["url"]).hostname, urlparse(c["url"]).port or 443) if c.get("url") else (f"{c.get('account')}.table.core.windows.net", 443),
    )),
    # -- business applications --
    ("act!-crm", ConnectorSpec(
        "act-crm", "Act! CRM", "apps", "Contacts, companies, opportunities and activities (Act! Web API)",
        [
            Field("url", "Act! Web API URL", default="https://apius.act.com/act.web.api",
                  help="Act! Premium Cloud: https://apius.act.com/act.web.api (apiuk / apiau / apieu); on premises: http://<server>/act.web.api"),
            Field("act_database", "Act! database"),
            Field("user", "Username"),
            _secret("password", "Password"),
        ],
        apps.ActCrmConnector, schemas=False,
    )),
    ("act-on", ConnectorSpec(
        "act-on", "Act-On", "apps", "Contact lists (Act-On REST API)",
        [
            Field("url", "API URL", default="https://api.actonsoftware.com", help="EU accounts: https://api-eu.actonsoftware.com"),
            Field("token_url", "Token URL", default="https://restapi.actonsoftware.com/token"),
            *_OAUTH_CLIENT,
            Field("user", "Act-On username"),
            _secret("password", "Act-On password"),
        ],
        apps.ActOnConnector, schemas=False,
    )),
    ("activecampaign", ConnectorSpec(
        "activecampaign", "ActiveCampaign", "apps", "Contacts, deals, lists and campaigns (API v3)",
        [
            Field("url", "API URL", placeholder="https://youraccount.api-us1.com", help="Settings → Developer → API Access"),
            _secret("token", "API key"),
        ],
        apps.ActiveCampaignConnector, schemas=False,
    )),
    ("adobe-analytics", ConnectorSpec(
        "adobe-analytics", "Adobe Analytics", "apps", "Report suites, components and daily metrics (Analytics 2.0 API)",
        [
            *_OAUTH_CLIENT,
            Field("company_id", "Global company ID", required=False, help="Found from the discovery service when empty"),
            Field("rsid", "Report suite ID", required=False, help="Needed for dimensions, metrics and the daily report"),
            Field("metrics", "Report metrics", required=False, default="metrics/visits,metrics/pageviews,metrics/visitors"),
            _start(" (default: 90 days ago)"),
            Field("scope", "Scopes", required=False, default="openid,AdobeID,additional_info.projectedProductContext"),
        ],
        apps.AdobeAnalyticsConnector, schemas=False, endpoint=_host("analytics.adobe.io"),
    )),
    ("adobe-commerce", ConnectorSpec(
        "adobe-commerce", "Adobe Commerce", "apps", "Products, orders and customers (Magento REST API)",
        [
            Field("url", "Store URL", placeholder="https://shop.example.com", help="…/rest/V1 is added; give a full …/rest/<store>/V1 URL for one store view"),
            _secret("token", "Integration access token", help="System → Integrations → an integration's access token"),
        ],
        apps.AdobeCommerceConnector, schemas=False,
    )),
    ("asana", ConnectorSpec(
        "asana", "Asana", "apps", "Workspaces, projects and tasks",
        [
            _secret("token", "Personal access token", required=False, help="Or sign in with an OAuth app below"),
            *_signin("An app from the Asana developer console (redirect URL below)"),
        ],
        apps.AsanaConnector, schemas=False, endpoint=_host("app.asana.com"),
        oauth=OAuthApp(lambda v: "https://app.asana.com/-/oauth_authorize", lambda v: "https://app.asana.com/-/oauth_token", scope="", client_auth="body"),
    )),
    ("adp", ConnectorSpec(
        "adp", "ADP", "erp", "Workers and departments (ADP Workforce Now API)",
        [
            *_OAUTH_CLIENT,
            _secret("certificate", "Client certificate (PEM)", textarea=True, help="The mutual TLS certificate ADP issued for the API client"),
            _secret("private_key", "Private key (PEM)", textarea=True),
            Field("url", "API URL", required=False, default="https://api.adp.com"),
            Field("token_url", "Token URL", required=False, default="https://accounts.adp.com/auth/oauth/v2/token"),
        ],
        apps.AdpConnector, schemas=False, endpoint=_url_host("url", "https://api.adp.com"),
    )),
    ("authorize-net", ConnectorSpec(
        "authorize-net", "Authorize.Net", "erp", "Settled batches, transactions and subscriptions",
        [
            Field("api_login_id", "API login ID"),
            _secret("transaction_key", "Transaction key"),
            Field("sandbox", "Sandbox", "bool", required=False, default=False),
            _start(" (default: a year ago)"),
        ],
        apps.AuthorizeNetConnector, schemas=False,
        endpoint=lambda c: ("apitest.authorize.net" if c.get("sandbox") else "api.authorize.net", 443),
    )),
    ("avalara", ConnectorSpec(
        "avalara", "Avalara", "erp", "Companies, transactions and tax codes (AvaTax REST v2)",
        [
            Field("user", "Account ID or username"),
            _secret("password", "License key or password"),
            Field("sandbox", "Sandbox", "bool", required=False, default=False),
        ],
        apps.AvalaraConnector, schemas=False,
        endpoint=lambda c: ("sandbox-rest.avatax.com" if c.get("sandbox") else "rest.avatax.com", 443),
    )),
    ("azure-active-directory", ConnectorSpec(
        "azure-active-directory", "Azure Active Directory", "apps", "Microsoft Entra ID users, groups and devices (Microsoft Graph)",
        [Field("tenant_id", "Tenant ID"), *_OAUTH_CLIENT],
        apps.AzureAdConnector, schemas=False, endpoint=_host("graph.microsoft.com"),
    )),
    ("azure-data-catalog", ConnectorSpec(
        "azure-data-catalog", "Azure Data Catalog", "apps", "Registered data assets",
        [Field("tenant_id", "Tenant ID"), *_OAUTH_CLIENT, Field("catalog", "Catalog", required=False, default="DefaultCatalog")],
        apps.AzureDataCatalogConnector, schemas=False, endpoint=_host("api.azuredatacatalog.com"),
    )),
    ("azure-devops", ConnectorSpec(
        "azure-devops", "Azure DevOps", "apps", "Projects, repositories, builds, pull requests and work items",
        [Field("organization", "Organization", placeholder="myorg"), _secret("token", "Personal access token", help="Read scopes for the data to sync")],
        apps.AzureDevOpsConnector, schemas=False, endpoint=_host("dev.azure.com"),
    )),
    ("basecamp", ConnectorSpec(
        "basecamp", "Basecamp", "apps", "Projects, people, to-dos and messages (Basecamp 4 API)",
        [Field("account_id", "Account ID", help="The number in https://3.basecamp.com/<account id>/"), *_signin("An app registered at launchpad.37signals.com/integrations")],
        apps.BasecampConnector, schemas=False, endpoint=_host("3.basecampapi.com"),
        oauth=OAuthApp(
            lambda v: "https://launchpad.37signals.com/authorization/new",
            lambda v: "https://launchpad.37signals.com/authorization/token?type=web_server",
            pkce=False, extra={"type": "web_server"},
        ),
    )),
    ("bigcommerce", ConnectorSpec(
        "bigcommerce", "BigCommerce", "apps", "Products, orders and customers",
        [Field("store_hash", "Store hash", help="From the API path https://api.bigcommerce.com/stores/<store hash>/"), _secret("token", "Access token", help="A store-level API account with read-only scopes")],
        apps.BigCommerceConnector, schemas=False, endpoint=_host("api.bigcommerce.com"),
    )),
    ("blackbaud-raisers-edge-nxt", ConnectorSpec(
        "blackbaud-raisers-edge-nxt", "Blackbaud Raisers Edge NXT", "apps", "Constituents, gifts and campaigns (SKY API)",
        [_secret("subscription_key", "SKY API subscription key", help="From your SKY developer account"), *_signin("A SKY application's ID and secret (redirect URL below)")],
        apps.BlackbaudConnector, schemas=False, endpoint=_host("api.sky.blackbaud.com"),
        oauth=OAuthApp(lambda v: "https://oauth2.sky.blackbaud.com/authorization", lambda v: "https://oauth2.sky.blackbaud.com/token", client_auth="basic", pkce=False),
    )),
    ("bugzilla", ConnectorSpec(
        "bugzilla", "Bugzilla", "apps", "Bugs and products (REST API)",
        [Field("url", "Bugzilla URL", placeholder="https://bugzilla.example.com"), _secret("token", "API key", required=False, help="Preferences → API Keys (anonymous when empty)")],
        apps.BugzillaConnector, schemas=False,
    )),
    ("acumatica", ConnectorSpec(
        "acumatica", "Acumatica", "erp", "DACs and generic inquiries over OData v4",
        [*_odata_fields("https://mycompany.acumatica.com", services_ph="/t/MyTenant/api/odata/dac\n/t/MyTenant/api/odata/gi",
                        user_help="An Acumatica user (with the tenant when needed: admin@MyTenant)"),
         Field("endpoint", "Contract-based endpoint", required=False, default="Default/24.200.001", help="For table exports: <endpoint name>/<version>"),
         Field("export_entities", "Export entities", "textarea", required=False, placeholder="Customer\nVendor\nStockItem",
               help="Entities of the contract-based REST API that take table exports (one per line); records are created or updated on their keys"),
         Field("tenant", "Tenant", required=False, help="The tenant to sign in to (contract-based REST)"),
         Field("branch", "Branch", required=False)],
        odata.AcumaticaConnector, schemas=False,
    )),
    # -- NetSuite --
    ("netsuite-suiteql-jdbc", ConnectorSpec(
        "netsuite-suiteql", "NetSuite SuiteQL", "erp", "Oracle NetSuite tables through SuiteQL (REST)",
        [
            Field("account_id", "Account ID", placeholder="1234567 or 1234567_SB1"),
            Field("consumer_key", "Consumer key", required=False, help="Token-based authentication: an integration record's consumer key and secret…"),
            _secret("consumer_secret", "Consumer secret", required=False),
            Field("token_id", "Token ID", required=False, help="…and an access token's ID and secret"),
            _secret("token_secret", "Token secret", required=False),
            *_signin("Or OAuth 2.0: an integration record with the authorization code grant (scope REST web services)"),
        ],
        netsuite.SuiteQLConnector, schemas=False, endpoint=_netsuite_host,
        oauth=OAuthApp(
            lambda v: f"https://{netsuite.account_host(v['account_id'])}.app.netsuite.com/app/login/oauth2/authorize.nl",
            lambda v: f"https://{netsuite.account_host(v['account_id'])}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
            scope="rest_webservices", client_auth="basic",
        ),
    )),
    ("netsuite-suitetalk-jdbc", ConnectorSpec(
        "netsuite-suitetalk", "NetSuite SuiteTalk", "erp", "Oracle NetSuite records through the REST record service",
        [
            Field("account_id", "Account ID", placeholder="1234567 or 1234567_SB1"),
            Field("consumer_key", "Consumer key", required=False),
            _secret("consumer_secret", "Consumer secret", required=False),
            Field("token_id", "Token ID", required=False),
            _secret("token_secret", "Token secret", required=False),
            *_signin("Or OAuth 2.0 (scope REST web services)"),
        ],
        netsuite.SuiteTalkConnector, schemas=False, endpoint=_netsuite_host,
        oauth=OAuthApp(
            lambda v: f"https://{netsuite.account_host(v['account_id'])}.app.netsuite.com/app/login/oauth2/authorize.nl",
            lambda v: f"https://{netsuite.account_host(v['account_id'])}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
            scope="rest_webservices", client_auth="basic",
        ),
    )),
    ("netsuite-suiteanalytics", ConnectorSpec(
        "netsuite-suiteanalytics", "NetSuite SuiteAnalytics", "erp", "SuiteAnalytics Connect (NetSuite2.com) over ODBC",
        [
            Field("account_id", "Account ID"),
            Field("role_id", "Role ID", help="Internal ID of the role with SuiteAnalytics Connect permission"),
            Field("user", "Username (email)"),
            _secret("password", "Password"),
            Field("driver", "ODBC driver name", required=False, default="NetSuite Drivers 64bit"),
            Field("port", "Port", "number", required=False, default=1708),
        ],
        netsuite.SuiteAnalyticsConnector, schemas=False, exports=False,
        endpoint=lambda c: (f"{netsuite.account_host(c.get('account_id') or 'account')}.connect.api.netsuite.com", int(c.get("port") or 1708)),
    )),
    # -- SAP --
    ("sap-erp", ConnectorSpec(
        "sap-erp", "SAP ERP", "sap", "SAP ECC and S/4HANA through SAP Gateway OData services",
        _odata_fields("https://s4.example.com:44300", services_ph="/sap/opu/odata/sap/API_BUSINESS_PARTNER", catalog=True, sap_client=True, sap=True),
        sap.SapConnector, schemas=False, oauth=_SAP_OAUTH,
    )),
    ("sap-slt", ConnectorSpec(
        "sap-slt", "SAP SLT", "sap", "SLT-replicated tables exposed as ODP OData services",
        _odata_fields("https://slt.example.com:44300", services_ph="/sap/opu/odata/sap/ZSLT_ODP_SRV", sap_client=True, sap=True),
        sap.SapConnector, schemas=False, oauth=_SAP_OAUTH,
    )),
    ("sap-custom-source", ConnectorSpec(
        "sap-custom-source", "SAP (Custom source)", "sap", "Any SAP OData v2 / v4 service",
        _odata_fields("https://sap.example.com", services_ph="/sap/opu/odata/sap/ZMY_SERVICE_SRV", sap_client=True, sap=True),
        sap.SapConnector, schemas=False, oauth=_SAP_OAUTH,
    )),
    ("sap-business-one", ConnectorSpec(
        "sap-business-one", "SAP Business One", "sap", "Service Layer (OData)",
        [
            Field("url", "Service Layer URL", placeholder="https://b1server:50000/b1s/v2"),
            Field("company_db", "Company database", placeholder="SBODEMOUS"),
            Field("user", "Username"),
            _secret("password", "Password"),
        ],
        odata.BusinessOneConnector, schemas=False,
    )),
    ("sap-bydesign", ConnectorSpec(
        "sap-bydesign", "SAP ByDesign", "sap", "Custom and analytics OData services",
        _odata_fields("https://my123456.sapbydesign.com", services_ph="/sap/byd/odata/cust/v1/khcustomer\n/sap/byd/odata/analytics/ds/Crmopprtnu.svc"),
        odata.ODataConnector, schemas=False,
    )),
    ("sap-cloud-for-customer", ConnectorSpec(
        "sap-cloud-for-customer", "SAP Cloud for Customer", "sap", "C4C OData API",
        _odata_fields("https://my123456.crm.ondemand.com", services_default="/sap/c4c/odata/v1/c4codataapi"),
        odata.ODataConnector, schemas=False,
    )),
    ("sap-successfactors", ConnectorSpec(
        "sap-successfactors", "SAP SuccessFactors", "sap", "SuccessFactors OData API",
        _odata_fields("https://api4.successfactors.com", services_default="/odata/v2", user_help="user@companyId"),
        odata.ODataConnector, schemas=False,
    )),
    ("sap-hana-xsa", ConnectorSpec(
        "sap-hana-xsa", "SAP HANA XSA", "sap", "SAP HANA databases and XSA (HDI) containers",
        [
            Field("host", "Host", placeholder="xxxx.hana.prod-eu10.hanacloud.ondemand.com"),
            Field("port", "Port", "number", default=443, help="HANA Cloud: 443; on premises: 3<instance>15 (or 3<instance>13 for SYSTEMDB)"),
            Field("database", "Tenant database", required=False),
            Field("user", "Username"),
            _secret("password", "Password"),
            Field("ssl", "TLS", "bool", required=False, default=True),
        ],
        dbs.HanaConnector,
    )),
    ("sap-ariba-procurement", ConnectorSpec(
        "sap-ariba-procurement", "SAP Ariba Procurement", "sap", "Operational Reporting for Procurement views",
        [
            Field("realm", "Realm", placeholder="mycompany-T"),
            *_OAUTH_CLIENT,
            _secret("api_key", "Application key (apiKey)"),
            Field("url", "API URL", required=False, default="https://openapi.ariba.com/api", help="Your data center's openapi host (US default)"),
            Field("token_url", "Token URL", required=False, default="https://api.ariba.com/v2/oauth/token"),
            _start(" (default: a year ago)"),
        ],
        apps.AribaConnector, schemas=False, endpoint=_url_host("url", "https://openapi.ariba.com/api"),
    )),
    ("sap-concur", ConnectorSpec(
        "sap-concur", "SAP Concur", "sap", "Expense reports, entries and invoices (v3.0 APIs)",
        [
            Field("token_host", "Data center", "select", default="https://us.api.concursolutions.com",
                  options=["https://us.api.concursolutions.com", "https://us2.api.concursolutions.com", "https://eu.api.concursolutions.com",
                           "https://eu2.api.concursolutions.com", "https://cn.api.concurcdc.cn", "https://emea.api.concursolutions.com"]),
            *_signin("A Concur app's client ID and secret; the refresh token from Sign in or a company request token exchange"),
        ],
        apps.ConcurConnector, schemas=False, endpoint=_url_host("token_host", "https://us.api.concursolutions.com"),
        oauth=OAuthApp(lambda v: f"{v.get('token_host') or 'https://us.api.concursolutions.com'}/oauth2/v0/authorize",
                       lambda v: f"{v.get('token_host') or 'https://us.api.concursolutions.com'}/oauth2/v0/token", pkce=False),
    )),
    ("sap-fieldglass", ConnectorSpec(
        "sap-fieldglass", "SAP Fieldglass", "sap", "Download connectors (REST API integration)",
        [
            Field("url", "Fieldglass URL", placeholder="https://www.fieldglass.net"),
            Field("user", "Integration user"),
            _secret("password", "Password"),
            _secret("application_key", "Application key (x-ApplicationKey)"),
            Field("connectors", "Download connectors", "textarea", placeholder="fg_worker_download\nfg_time_sheet_download", help="One connector name per line; each is a table"),
            Field("parameters", "Connector parameters", required=False, help="Comma-separated values for __p1, __p2, …"),
        ],
        apps.FieldglassConnector, schemas=False,
    )),
    ("sap-businessobjects-bi", ConnectorSpec(
        "sap-businessobjects-bi", "SAP BusinessObjects BI", "sap", "Web Intelligence reports, documents and universes",
        [
            Field("url", "RESTful web service URL", placeholder="https://bobj.example.com:6405/biprws"),
            Field("user", "Username"),
            _secret("password", "Password"),
            Field("auth_type", "Authentication", "select", default="secEnterprise", options=["secEnterprise", "secLDAP", "secWinAD", "secSAPR3"]),
            Field("max_documents", "Documents to list", "number", required=False, default=50),
        ],
        apps.BusinessObjectsConnector, schemas=False,
    )),
]

for _slug, _s in SPECS:
    assert re.fullmatch(r"[a-z0-9-]+", _s.id), _s.id
