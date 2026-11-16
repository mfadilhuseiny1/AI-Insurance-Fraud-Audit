"""Audit logs in the audit.3 schema (Security & Governance → Security auditing).

Every auditable event is one structured log line (the audit.3 schema of the reference docs): `categories` (at least
one of CATEGORIES), `requestFields` / `resultFields` named by those categories, `entities` (every resource the
event names), `uid`, `orgId`, `sid`, `tokenId`, `traceId`, `origins` / `sourceOrigin`, `userAgent`, `product`,
`service`, `name` (PRODUCT_ENDPOINT in caps), `result` (SUCCESS, UNAUTHORIZED, ERROR), `time`, `eventId`,
`logEntryId`, `sequenceId`, `producerType`, `environment`, `host`, `stack`, `productVersion` and `users`
(only `uid` is filled, as in the reference pipeline).

Where the lines come from:
- middleware(): every API request made by a user (and visits of share links) is classified by RULES into
  categories — Files downloads are `dataExport` with the downloaded size, uploads `dataImport`, dataset and object
  reads `dataLoad` / `ontologyDataLoad`, searches `dataSearch`, actions `ontologyDataTransform`, builds and
  function runs `codeExecution`, LLM calls `llmInference`, share links `dataShareCreate` / `dataShareDisable` /
  `dataShare`, and any other change `appConfigCreate` / `appConfigUpdate` / `appConfigDelete`. GETs that match no
  rule are not logged (reading application configuration is low signal and very frequent).
- auth.audit(): the sign-in log (sign-ins, failures, tokens, users, groups, markings, roles) is written here as well,
  through AUTH_EVENTS; a request that wrote such a line is not logged a second time by the middleware.
- emit(): other modules (checkpoints, approvals, Cipher, Sensitive Data Scanner…) log their own events.

Storage is append-only: data/audit3/logs/<org>/<YYYYMMDD>/<HHMM>.jsonl, one file per organization and 5-minute
window (users without an organization go to "default"). A window's file is a log file once the window has ended.

Delivery (reference: "Audit delivery"):
- SIEM ingestion: GET /api/v2/audit/organizations/{org}/logFiles?startDate=&endDate=&pageToken=&pageSize= lists the
  log files ({data: [{id, startTime, endTime, size}], nextPageToken} — the token is always returned and resumes
  after the last file seen, so polling neither misses nor repeats files); GET …/logFiles/{id}/content returns the
  file (JSON lines). Callers: administrators, users given the organization's "audit log reader" permission
  (Control Panel → Audit logs), and Developer Console applications with audit-read access (`api:audit-read` scope)
  whose user is one of those.
- Export to a dataset: Control Panel → Audit logs → Create export dataset (audit.3, or audit.2 for the sign-in log
  kept before audit.3), a folder and name, markings (the organization's marking by default), a start date filter and
  a retention policy in days (max 730, counted from when lines were added). New lines are appended every
  EXPORT_INTERVAL seconds as APPEND transactions; exports can be paused and resumed. `date` is a column.

Mounted by server.py: `router` (/api/audit) and `siem` (/api/v2/audit).
"""

from __future__ import annotations

import base64
import contextvars
import io
import json
import logging
import os
import re
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth

log = logging.getLogger("bluesandai.audit3")
router = APIRouter(prefix="/api/audit", tags=["audit"])
siem = APIRouter(prefix="/api/v2/audit", tags=["audit"])

DIR = Path("data/audit3")
WINDOW = 300  # seconds per log file
EXPORT_INTERVAL = 300
HOST = socket.gethostname()
ENVIRONMENT = os.environ.get("BLUESANDAI_ENVIRONMENT", "bluesandai")
VERSION = "1.0"
DEFAULT_ORG = "default"
_lock = threading.RLock()
_req: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("audit3_request", default=None)
_org_cache: dict[str, tuple[float, Optional[str]]] = {}
_started = False

# the audit.3 categories of the reference ("Audit log categories"): request fields, result fields
CATEGORIES: dict[str, tuple[tuple[str, ...], tuple[str, ...], str]] = {
    "apiGatewayRequest": (("operationNames",), (), "A request to an API gateway."),
    "appConfigAccess": (("accessedAppConfigIds", "accessAppConfigDescription"), (), "Load application-specific configuration."),
    "appConfigCreate": (("createAppConfigDescription",), ("createdAppConfigIds",), "Create application-specific configuration."),
    "appConfigDelete": (("deletedAppConfigIds", "deleteAppConfigDescription"), (), "Delete application-specific configuration."),
    "appConfigSearch": (("appConfigSearchQuery",), ("appConfigSearchResults",), "Search for application-specific configuration."),
    "appConfigUpdate": (("updatedAppConfigIds", "updateAppConfigDescription"), (), "Update application-specific configuration."),
    "assetFileLoadV2": (("fileIdentifier",), ("fileLoadResponse",), "Loads a file from an asset coordinate or content addressable storage."),
    "auditDataRedact": (("requestedAuditEventIds", "organizationRid", "startDate", "endDate", "redactionReason"),
                        ("redactionRequestId", "redactedAuditEventIds", "missingAuditEventIds", "redactedLineCount"), "Redaction of audit data after a data spill."),
    "auditDataShareCreate": (("shareTargets",), ("shareIds",), "Creation of shares of audit data."),
    "auditDataTransform": (("transformTarget", "transformDescriptions"), ("transformDestination",), "Transform a resource that contains audit data."),
    "authenticationCheck": (("authenticationCheckTargets",), ("authenticationCheckResult", "authenticationCheckResultMessage"), "Checks authentication status, such as token validation."),
    "authorizationCheck": (("authorizationCheckTargets", "authorizationCheckOperations"),
                           ("authorizationCheckSucceededTargets", "authorizationCheckFailedTargets", "authorizationCheckResultMessage"), "Checks authorization status, like checking permissions."),
    "bulkDataImport": (("bulkImportedFiles",), ("bulkImportDestinations",), "Bulk imports to the platform."),
    "cancelCodeExecution": (("cancelledExecutedResources", "cancelledExecutedResourceEnvironment"), (), "Cancellation of an existing code execution."),
    "codeExecution": (("executedResourceEnvironment",), ("executedResources",), "Occurrence of code execution."),
    "configureInfra": (("configureInfraTargets",), ("configureInfraRequestId",), "A user configures some infrastructure."),
    "containerLaunch": (("requestedContainerIdsToLaunch",), ("launchedContainerIds",), "Preparation of a compute environment."),
    "containerLoad": (("requestedContainerLoadIds",), ("loadedContainerLoadIds",), "Load of a compute environment."),
    "containerSearch": (("containerSearchQuery",), ("containerSearchResults",), "Search of compute environments."),
    "containerStop": (("stoppedContainerIds", "containerStopReason"), (), "Shutdown of a compute environment."),
    "createInfra": (("createInfraTargets",), ("createdInfraResources",), "A user creates some infrastructure."),
    "dataCreate": (("createdResources",), (), "Addition of a new entry of data into the platform."),
    "dataDelete": (("deletedResources",), (), "Deletion of data, at any granularity."),
    "dataExport": (("downloadedResources",), ("downloadedSize",), "Export of data from the platform, such as a download."),
    "dataImport": (("importedFilename", "importedFileType", "importParentResourceId"), ("importResourceId", "importedSize"), "Imports to the platform from outside."),
    "dataLoad": (("loadedResources",), (), "Loading of data to be returned to a user."),
    "dataMerge": (("resourcesToMerge",), ("mergedResult",), "Combination of two data sources into one."),
    "dataPromote": (("promotionDestinations", "promotionDescription", "promotedResources"), (), "Promotion of data to an external system."),
    "dataSearch": (("dataSearchQuery", "dataSearchContext"), ("dataSearchResults",), "Searches of datasets, objects or other data."),
    "dataShareCreate": (("dataShareCreateId", "dataShareCreateTargets"), (), "Creation of a share of data, such as a share link."),
    "dataShareDisable": (("dataShareDisableId", "dataShareDisableTargets"), (), "Deactivation of a share of data."),
    "dataShare": (("dataShareId", "dataShareTargets", "dataShareReason"), (), "Discretionary share of data (for example, a visited share link)."),
    "dataTransform": (("transformTargets", "transformDescription"), (), "Transform one or more data resources."),
    "dataUpdate": ((), (), "Updates of data (catch-all)."),
    "inApplicationContext": (("applicationRid",), (), "The request was initiated from a third-party application."),
    "infraLogsAccess": (("infraLogsAccessTarget",), ("infraLogsAccessRequestId",), "A user requests logs from an infrastructure resource."),
    "internal": ((), (), "Catch-all for internal events."),
    "llmInference": (("llmInferenceContext", "llmInferenceInputs"), ("llmInferenceResponses", "llmInferenceResponseContext"), "Runs a prompt through a language model."),
    "logicAccess": (("accessedLogicResources",), (), "Access of logic, such as viewing an analysis."),
    "logicCreate": ((), ("createdLogicResources",), "Creation of new logic."),
    "logicDelete": (("deletedLogicResources",), (), "Deletion of logic."),
    "logicSearch": (("logicSearchQuery",), ("logicSearchResults",), "Search of some logic."),
    "logicUpdate": (("updatedLogicResources",), (), "An update to existing logic, such as a push to a repository."),
    "managementGroups": (("groupPatches",), (), "Changes to group membership."),
    "managementPermissions": (("resourcesWithPermissionsChanges", "permissionChangeContext"), (), "Anything that changes permissions on the platform."),
    "managementUsers": (("managedUserIds",), (), "Changes to what users exist or their personal information."),
    "managementTokens": (("managedTokens",), (), "Token management, such as enabling, disabling or revoking tokens."),
    "managementMarkings": (("markingPatches",), (), "Anything that modifies access to mandatory controls."),
    "metaDataAccess": (("accessedMetaDataResources", "accessedMetaDataDescription"), (), "Loading of metadata."),
    "metaDataCreate": (("createdMetaDataDescription",), ("createdMetaDataResources",), "Creation of metadata."),
    "metaDataDelete": (("deletedMetaDataResources", "deletedMetaDataDescription"), (), "Deletion of metadata."),
    "metaDataSearch": (("metaDataSearchQuery",), ("metaDataSearchResults",), "Search of metadata."),
    "metaDataUpdate": (("updatedMetaDataResources", "updatedMetaDataDescription"), (), "Updating of metadata."),
    "monitorAccess": (("accessedMonitorResources", "accessedMonitorDescription"), (), "Access of a monitor."),
    "monitorCreate": (("createdMonitorDescription",), ("createdMonitorResources",), "Creation of a monitor."),
    "monitorDelete": (("deletedMonitorResources", "deletedMonitorDescription"), (), "Deletion of a monitor."),
    "monitorRun": (("runMonitorTargets",), (), "Execution of a monitor."),
    "monitorSearch": (("monitorSearchQuery",), ("monitorSearchResults",), "Searching for a monitor."),
    "monitorUpdate": (("updatedMonitorResources", "updatedMonitorDescription"), (), "Update of a monitor."),
    "oauth2InitiateAuthFlow": (("oauth2InitiateAuthFlowUser", "oauth2InitiateAuthClientId"), (), "Start of an OAuth 2.0 authorization code flow."),
    "onBehalfOf": (("onBehalfOfUserIds",), (), "The request was made on behalf of other users."),
    "ontologyDataLoad": (("ontologyDataLoadContext", "requestedOntologyDataResources"), ("loadedOntologyDataResources",), "Loading of ontology data."),
    "ontologyDataTransform": (("ontologyDataTransformTargets", "ontologyDataTransformContext", "ontologyDataTransformDescription"),
                              ("transformedOntologyDataResources",), "Modification of ontology data through edits."),
    "ontologyDataSearch": (("ontologyDataSearchContext", "searchedOntologyLogicResources"), ("ontologyDataSearchResults",), "Search of ontology data."),
    "ontologyLogicAccess": (("requestedOntologyLogicResources",), ("loadedOntologyLogicResources",), "Access of ontology logic, such as an object set."),
    "ontologyLogicCreate": (("createOntologyLogicContext",), ("createdOntologyLogicResources",), "Creation of ontology logic."),
    "ontologyLogicDelete": (("deleteOntologyLogicContext",), ("deletedOntologyLogicResources",), "Deletion of ontology logic."),
    "ontologyLogicUpdate": (("updateOntologyLogicContext",), ("updatedOntologyLogicResources",), "Update of ontology logic."),
    "ontologyMetaDataCreate": ((), ("createdOntologyMetaDataResources",), "Creation of ontology metadata."),
    "ontologyMetaDataDelete": (("deletedOntologyMetaDataResources",), (), "Deletion of ontology metadata."),
    "ontologyMetaDataLoad": (("requestedOntologyMetaDataResources",), ("loadedOntologyMetaDataResources",), "Loading of ontology metadata."),
    "ontologyMetaDataSearch": (("ontologyMetaDataSearchedResources", "ontologyMetaDataSearchContext"), ("ontologyMetaDataSearchResults",), "Search of ontology metadata."),
    "ontologyMetaDataUpdate": (("updatedOntologyMetaDataResources",), (), "Modification of ontology metadata."),
    "passThrough": (("passThroughRequestParams",), ("passThroughResponseParams",), "Parameters determined at runtime by an external system."),
    "requestAccess": (("accessedRequestIds", "accessedRequestDescription"), (), "The loading of a request."),
    "requestApprove": (("approvedRequestIds", "approveRequestUserId"), (), "Approving a request, or part of one."),
    "requestCancel": (("canceledRequestIds",), (), "Canceling a request."),
    "requestCreate": (("createdRequestAffectedResources", "createdRequestDescription"), ("createdRequestIds",), "The creation of a request, such as an access request or checkpoint."),
    "requestDisapprove": (("disapprovedRequestIds", "disapproveRequestUserId"), (), "Disapproving a request."),
    "requestExecute": (("executedRequestIds",), ("executeRequestAffectedResources",), "Executing the action associated with a request."),
    "requestSearch": (("requestSearchQuery",), ("requestSearchResults",), "Searching for requests."),
    "requestUpdate": (("updatedRequestIds", "updatedRequestDescription"), (), "The update of an existing request."),
    "restartInfra": (("restartedResources",), (), "Restarts some infrastructure."),
    "reviewInfraAction": (("reviewInfraActionRequestId", "reviewInfraActionUser"), ("reviewInfraActionWasApproved",), "A user approves or denies an infrastructure action."),
    "secretCreate": (("createdSecretType",), ("createdSecretIdentifiers",), "Create a secret."),
    "secretDeprecate": (("deprecatedSecretIdentifier",), (), "Mark a secret as deprecated."),
    "secretLoad": (("loadedSecretIdentifiers",), (), "Retrieve a secret from the backing store."),
    "secretUse": (("usedSecretOperation", "usedSecretIdentifiers"), (), "Use a secret through a backend endpoint."),
    "tokenAccess": ((), ("accessedTokens",), "Accessing a previously generated token."),
    "tokenGeneration": (("generateTokensDescription",), ("generatedTokens",), "Generation of a new token."),
    "tokenRevoke": (("revokeTokensDescription",), ("revokedTokens",), "Deletion of tokens."),
    "upgradeInfra": (("upgradedResources",), (), "Some infrastructure was upgraded."),
    "userJustify": (("userJustifyId", "userJustification"), (), "A user specifies a purpose justification for an action."),
    "userLogin": ((), ("loginUserId",), "Login events of users."),
    "userLogout": (("logoutUserId",), (), "Logout events of users."),
}

# the sign-in log (auth.audit) as audit.3 categories
AUTH_EVENTS: dict[str, tuple[str, ...]] = {
    "sign_in": ("userLogin", "authenticationCheck"), "sign_in_failed": ("authenticationCheck",), "sign_out": ("userLogout",),
    "setup": ("managementUsers",), "user_created": ("managementUsers",), "user_invited": ("managementUsers",), "user_deleted": ("managementUsers",),
    "user_deactivated": ("managementUsers",), "invitation_accepted": ("managementUsers",), "password_changed": ("managementUsers",),
    "password_reset": ("managementUsers",), "password_reset_requested": ("managementUsers",), "password_expired": ("authenticationCheck",),
    "mfa_enabled": ("managementUsers",), "mfa_disabled": ("managementUsers",), "mfa_reset": ("managementUsers",), "mfa_recovery_codes": ("managementUsers",),
    "mfa_recovery_used": ("authenticationCheck",), "token_created": ("tokenGeneration",), "session_revoked": ("tokenRevoke",),
    "signed_out_everywhere": ("tokenRevoke",), "group_created": ("managementGroups",), "group_updated": ("managementGroups",),
    "group_deleted": ("managementGroups",), "organization_created": ("managementUsers",), "organization_deleted": ("managementUsers",),
    "markings_changed": ("managementPermissions",), "project_roles_changed": ("managementPermissions",), "settings_changed": ("appConfigUpdate",),
    "iceberg_settings_changed": ("appConfigUpdate",), "cipher_license_created": ("secretCreate",), "cipher_encrypt_key": ("secretUse",),
    "cipher_decrypt_key": ("secretUse",),
}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "audit3"
    (DIR / "logs").mkdir(parents=True, exist_ok=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, path)


# ------------------------------------------------------------------------------------------------
# writing log lines
# ------------------------------------------------------------------------------------------------


def org_of(uid: Optional[str]) -> Optional[str]:
    """The organization a user belongs to (cached for a minute); None for service users and unknown users."""
    if not uid or uid in ("system", "local"):
        return None
    hit = _org_cache.get(uid)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    try:
        org = auth._user(uid).get("organization_id")
    except Exception:  # noqa: BLE001 - a deleted user
        org = None
    _org_cache[uid] = (time.monotonic() + 60, org)
    return org


def _window(t: datetime) -> datetime:
    return t.replace(second=0, microsecond=0, minute=t.minute - t.minute % (WINDOW // 60))


def _file_for(org: str, t: datetime) -> Path:
    w = _window(t)
    return DIR / "logs" / org / w.strftime("%Y%m%d") / f"{w.strftime('%H%M')}.jsonl"


def _entities(fields: Iterable[Any]) -> list[dict]:
    """Resources named in the request and result fields: {"type", "id"} records and resource id strings."""
    out: dict[str, dict] = {}

    def walk(v: Any) -> None:
        if isinstance(v, dict):
            if "id" in v and isinstance(v["id"], str) and ("type" in v or "name" in v):
                out.setdefault(v["id"], {k: v[k] for k in ("type", "id", "name") if k in v})
            else:
                for x in v.values():
                    walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    for f in fields:
        walk(f)
    return list(out.values())


def emit(name: str, categories: Iterable[str], request_fields: Optional[dict] = None, result_fields: Optional[dict] = None,
         result: str = "SUCCESS", product: str = "platform", uid: Optional[str] = None, service: Optional[str] = None,
         event_id: Optional[str] = None) -> dict:
    """Write one audit.3 line (for the request being served, when there is one). Never raises."""
    cats = sorted({c for c in categories if c in CATEGORIES}) or ["internal"]
    ctx = _req.get()
    p = auth.current()
    if uid is None:
        uid = (p or {}).get("id") if p and not p.get("service") else (ctx or {}).get("uid")
    rf, sf = dict(request_fields or {}), dict(result_fields or {})
    line = {
        "categories": cats, "entities": _entities([rf, sf]), "environment": ENVIRONMENT, "eventId": event_id or str(uuid.uuid4()), "host": HOST,
        "logEntryId": str(uuid.uuid4()), "name": name.upper(), "orgId": org_of(uid), "origin": (ctx or {}).get("origin"),
        "origins": (ctx or {}).get("origins") or [], "product": product, "producerType": "SERVER", "productVersion": VERSION,
        "requestFields": rf, "result": result, "resultFields": sf, "sequenceId": str(uuid.uuid4()), "service": service or f"{product}-service",
        "sid": (ctx or {}).get("sid"), "sourceOrigin": (ctx or {}).get("source_origin"), "stack": ENVIRONMENT, "time": _iso(),
        "tokenId": (ctx or {}).get("token_id"), "traceId": (ctx or {}).get("trace_id"), "uid": uid, "userAgent": (ctx or {}).get("user_agent"),
        "users": [{"uid": uid, "userName": None, "firstName": None, "lastName": None, "groups": [], "realm": None}] if uid else [],
    }
    try:
        path = _file_for(line["orgId"] or DEFAULT_ORG, _now())
        with _lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")
        if ctx is not None:
            ctx["emitted"] = True
        for hook in LISTENERS:
            try:
                hook(line)
            except Exception:  # noqa: BLE001 - a listener never blocks auditing
                log.exception("audit listener failed")
    except Exception:  # noqa: BLE001 - auditing never fails the request
        log.exception("audit.3 write failed")
    return line


# functions called with every new line (detections in audit_monitor.py)
LISTENERS: list[Any] = []


def from_auth(event: str, user: Optional[dict], detail: str, username: Optional[str]) -> None:
    """auth.audit() → audit.3."""
    cats = AUTH_EVENTS.get(event, ("appConfigUpdate",))
    target = (user or {}).get("id")
    req: dict[str, Any] = {"description": detail} if detail else {}
    res: dict[str, Any] = {}
    result = "SUCCESS"
    if "userLogin" in cats:
        res["loginUserId"] = target
    if "authenticationCheck" in cats:
        req["authenticationCheckTargets"] = [username or (user or {}).get("username")]
        ok = event not in ("sign_in_failed", "password_expired")
        res.update(authenticationCheckResult=ok, authenticationCheckResultMessage=detail or event)
        result = "SUCCESS" if ok else "UNAUTHORIZED"
    if "userLogout" in cats:
        req["logoutUserId"] = target or (auth.current() or {}).get("id")
    if "managementUsers" in cats:
        req["managedUserIds"] = [target] if target else []
    if "managementGroups" in cats:
        req["groupPatches"] = [{"event": event, "detail": detail}]
    if "managementPermissions" in cats:
        rid = detail.split(":", 1)[0] if ":" in detail else detail
        req.update(resourcesWithPermissionsChanges=[{"type": "resource", "id": rid}], permissionChangeContext=detail)
    if "tokenGeneration" in cats:
        req["generateTokensDescription"] = detail or "personal API token"
        res["generatedTokens"] = [detail] if detail else []
    if "tokenRevoke" in cats:
        req["revokeTokensDescription"] = event
        res["revokedTokens"] = [detail] if detail else []
    if "secretCreate" in cats:
        req["createdSecretType"] = "cipher-license"
        res["createdSecretIdentifiers"] = [detail]
    if "secretUse" in cats:
        req.update(usedSecretOperation=event.split("_")[1], usedSecretIdentifiers=[detail])
    if "appConfigUpdate" in cats:
        req.update(updatedAppConfigIds=[event], updateAppConfigDescription=detail or event)
    # a failed sign-in has no signed-in user: the user it was for (when known) is the uid
    uid = (auth.current() or {}).get("id") if auth.current() and not (auth.current() or {}).get("service") else None
    if event in ("sign_in", "sign_in_failed", "invitation_accepted", "password_reset", "setup"):
        uid = target or uid
    emit(f"AUTH_{event}", cats, req, res, result=result, product="multipass", uid=uid, service="multipass")


# ------------------------------------------------------------------------------------------------
# classifying API requests
# ------------------------------------------------------------------------------------------------

SKIP = re.compile(r"^/api/(auth/(heartbeat|status|me$|policy)|presence/|notifications(/|$)|audit/|v2/audit/|checkpoints/required|"
                  r"dc-hosting/|widget-assets/|listen/|.*?/events$)")
PRODUCTS = {"drive": "files", "dataset-preview": "dataset-preview", "pipeline": "pipeline-builder", "code-repos": "code-repositories",
            "ontology": "ontology", "functions": "functions", "sql": "sql-studio", "sql-bi": "sql-bi", "exports": "data-connection",
            "datasources": "data-connection", "agents": "aip-agent-studio", "v2": "ontology-sdk", "contour": "contour", "quiver-tables": "quiver",
            "fusion": "fusion", "notepad": "notepad", "workshop": "workshop", "slate": "slate", "model-assets": "models",
            "model-deployments": "model-deployments", "media-sets": "media-sets", "lineage": "data-lineage", "auth": "multipass",
            "cipher": "cipher", "checkpoints": "checkpoints", "approvals": "approvals", "sds": "sensitive-data-scanner",
            "data-lifetime": "data-lifetime", "code-scanning": "code-scanning", "compass": "compass"}


def _ids(params: dict) -> list[dict]:
    return [{"type": k.removesuffix("_id") or "resource", "id": str(v)} for k, v in params.items() if v not in (None, "")]


def _query(request: Request) -> str:
    q = request.query_params
    return q.get("q") or q.get("query") or q.get("search") or q.get("term") or ""


# (methods, pattern on the route template, categories, field builder(request, response, params) -> (request fields, result fields))
def _download(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    size: Any = res.headers.get("content-length")
    size = int(size) if size and size.isdigit() and res.status_code == 200 else None
    if size is None and p.get("item_id"):
        # S3 storage answers with a redirect to a presigned URL: the size is the item's
        try:
            import db

            size = (db.drive_get(p["item_id"]) or {}).get("size_bytes")
        except Exception:  # noqa: BLE001
            size = None
    ids = _ids(p) or [{"type": "item", "id": x} for x in (req.query_params.get("ids") or "").split(",") if x]
    return {"downloadedResources": ids}, {"downloadedSize": size}


def _load(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"loadedResources": _ids(p)}, {}


def _search(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"dataSearchQuery": _query(req), "dataSearchContext": [{"path": req.url.path}]}, {"dataSearchResults": []}


def _ontology_load(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    ids = _ids(p)
    return {"ontologyDataLoadContext": req.url.path, "requestedOntologyDataResources": ids}, {"loadedOntologyDataResources": ids}


def _ontology_search(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"ontologyDataSearchContext": req.url.path, "searchedOntologyLogicResources": _ids(p) or [{"type": "query", "id": _query(req) or "*"}]}, \
        {"ontologyDataSearchResults": []}


def _ontology_edit(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"ontologyDataTransformTargets": _ids(p), "ontologyDataTransformDescription": f"{req.method} {req.url.path}"}, \
        {"transformedOntologyDataResources": _ids(p)}


def _import(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"importedFilename": req.headers.get("x-file-name") or "upload", "importedFileType": (req.headers.get("content-type") or "").split(";")[0],
            "importParentResourceId": req.query_params.get("parent_id")}, \
        {"importResourceId": None, "importedSize": int(req.headers["content-length"]) if (req.headers.get("content-length") or "").isdigit() else None}


def _delete(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"deletedResources": _ids(p)}, {}


def _code(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"executedResourceEnvironment": req.url.path}, {"executedResources": _ids(p)}


def _llm(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    # the prompt and the answer are filled in by the middleware (the request body, then the streamed response)
    return {"llmInferenceContext": {"path": req.url.path, **{k: str(v) for k, v in p.items()}}, "llmInferenceInputs": "(not recorded)"}, \
        {"llmInferenceResponses": "(not recorded)", "llmInferenceResponseContext": {"status": res.status_code}}


# LLM content kept in an audit line (each of the prompt and the answer)
LLM_CONTENT_MAX = 8000
_LLM_PROMPT_KEYS = ("messages", "message", "prompt", "question", "query", "input", "inputs", "text", "content", "system", "instruction", "instructions")
_LLM_ANSWER_KEYS = ("answer", "reply", "response", "content", "text", "message", "output", "completion", "choices", "result")


def _llm_text(raw: bytes, keys: tuple[str, ...]) -> Any:
    """The prompt or answer fields of a JSON body (else the text), cut to LLM_CONTENT_MAX characters."""
    txt = raw.decode("utf-8", "replace")
    try:
        body = json.loads(txt)
    except ValueError:
        body = None
    if isinstance(body, dict):
        picked = {k: body[k] for k in keys if body.get(k) not in (None, "", [])}
        if picked:
            txt = json.dumps(picked, ensure_ascii=False, default=str)
    elif "data:" in txt[:200]:
        # server-sent events: the data of the events in order (a streamed answer's tokens joined back into its text)
        txt = "".join(line[6:] if line.startswith("data: ") else line[5:] for line in txt.splitlines() if line.startswith("data:"))
    return txt if len(txt) <= LLM_CONTENT_MAX else txt[:LLM_CONTENT_MAX] + f"… ({len(txt) - LLM_CONTENT_MAX} more characters)"


def _share_create(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"dataShareCreateId": None, "dataShareCreateTargets": _ids(p)}, {}


def _share_disable(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"dataShareDisableId": p.get("token"), "dataShareDisableTargets": _ids(p)}, {}


def _share_visit(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"dataShareId": p.get("token"), "dataShareTargets": _ids({k: v for k, v in p.items() if k != "token"}), "dataShareReason": "visited a share link"}, {}


def _perm(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"resourcesWithPermissionsChanges": _ids(p), "permissionChangeContext": f"{req.method} {req.url.path}"}, {}


def _markings(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"markingPatches": [{"method": req.method, **{k: str(v) for k, v in p.items()}}]}, {}


def _users(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"managedUserIds": [str(p.get("user_id"))] if p.get("user_id") else []}, {}


def _tokens(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"managedTokens": _ids(p)}, {}


def _logic_update(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"updatedLogicResources": _ids(p)}, {}


def _export(req: Request, res: Any, p: dict) -> tuple[dict, dict]:
    return {"downloadedResources": _ids(p) or [{"type": "export", "id": req.url.path}]}, {"downloadedSize": None}


RULES: list[tuple[set[str], re.Pattern, tuple[str, ...], Any]] = [
    ({"GET"}, re.compile(r"^/api/drive/items/\{item_id\}/content$"), ("dataExport",), _download),
    ({"GET"}, re.compile(r"^/api/drive/zip$"), ("dataExport",), _download),
    ({"GET"}, re.compile(r"^/api/dataset-preview/\{item_id\}/download$"), ("dataExport",), _download),
    ({"GET"}, re.compile(r"^/api/drive/shared/\{token\}"), ("dataShare", "dataLoad"), lambda r, s, p: (_share_visit(r, s, p)[0] | _load(r, s, p)[0], {})),
    ({"POST"}, re.compile(r"^/api/drive/items/\{item_id\}/shares$"), ("dataShareCreate",), _share_create),
    ({"DELETE"}, re.compile(r"^/api/drive/shares/\{token\}$"), ("dataShareDisable",), _share_disable),
    ({"POST"}, re.compile(r"^/api/drive/(files|import/.*)$"), ("dataImport",), _import),
    ({"POST"}, re.compile(r"^/api/dataset-preview/\{item_id\}/upload$"), ("dataImport",), _import),
    ({"DELETE"}, re.compile(r"^/api/drive/(items/\{item_id\}|trash)$"), ("dataDelete",), _delete),
    ({"POST"}, re.compile(r"^/api/drive/items/\{item_id\}/trash$"), ("dataDelete",), _delete),
    ({"GET"}, re.compile(r"^/api/drive/search$"), ("dataSearch",), _search),
    ({"GET", "POST"}, re.compile(r"^/api/dataset-preview/\{item_id\}(/rows|/query|/chart)?$"), ("dataLoad",), _load),
    ({"POST"}, re.compile(r"^/api/sql/query$"), ("dataLoad",), _load),
    ({"POST"}, re.compile(r"^/api/sql-bi/query$"), ("dataLoad", "apiGatewayRequest"), lambda r, s, p: ({**_load(r, s, p)[0], "operationNames": ["sql-bi query"]}, {})),
    ({"GET"}, re.compile(r"^/api/ontology/object-types/\{type_id\}/objects(/\{pk\})?$"), ("ontologyDataLoad",), _ontology_load),
    ({"GET"}, re.compile(r"^/api/ontology/object-view/"), ("ontologyDataLoad",), _ontology_load),
    ({"GET", "POST"}, re.compile(r"^/api/v2/ontologies/.*/objects/"), ("ontologyDataLoad", "inApplicationContext"), _ontology_load),
    ({"POST"}, re.compile(r"^/api/ontology/.*(search|explore|aggregate).*$"), ("ontologyDataSearch",), _ontology_search),
    ({"POST"}, re.compile(r"^/api/(ontology/action-types/\{action_id\}/apply(-batch)?|ontology/actions/runs/\{rid\}/revert|v2/ontologies/.*/actions/.*)$"),
     ("ontologyDataTransform",), _ontology_edit),
    ({"POST"}, re.compile(r"^/api/(exports(/\{export_id\}/run)?|exports/.*)$"), ("dataExport",), _export),
    ({"POST"}, re.compile(r"^/api/(code-repos/\{repo_id\}/build|code-repos/\{repo_id\}/schedules/.*/run|pipeline/.*(build|run).*|"
                          r"functions/\{fid\}/execute.*|functions/queries/.*/execute|logic-flows/\{item_id\}/run|ontology/logic/\{logic_id\}/run|"
                          r"ontology/automations/\{auto_id\}/run|code-workbooks/.*/run.*)$"), ("codeExecution",), _code),
    ({"POST"}, re.compile(r"^/api/(functions/llm/chat|agents/.*/(chat|messages|run).*|code-repos/tools/models/chat|pipeline/ai/.*)$"), ("llmInference",), _llm),
    ({"PUT", "POST", "DELETE"}, re.compile(r"^/api/auth/(items/\{item_id\}/markings|projects/\{project_id\}/roles)$"), ("managementPermissions",), _perm),
    ({"POST", "PUT", "DELETE"}, re.compile(r"^/api/auth/markings"), ("managementMarkings",), _markings),
    ({"POST", "PUT", "DELETE"}, re.compile(r"^/api/auth/(users|invitations)"), ("managementUsers",), _users),
    ({"DELETE"}, re.compile(r"^/api/auth/tokens/\{token_id\}$"), ("tokenRevoke",), lambda r, s, p: ({"revokeTokensDescription": "personal API token"}, {"revokedTokens": _ids(p)})),
    ({"POST", "PUT"}, re.compile(r"^/api/code-repos/\{repo_id\}/(files|commit|push).*$"), ("logicUpdate",), _logic_update),
]


_LLM_PATH = re.compile(r"^/api/(functions/llm/chat|agents/.*/(chat|messages|run).*|code-repos/tools/models/chat|pipeline/ai/.*)$")


READ_DEDUPE_S = 60
BODY_SUMMARY_MAX = 256 * 1024
_SECRET_KEY = re.compile(r"pass|secret|token|key|credential|private|cookie|auth", re.I)


def body_summary(raw: bytes) -> Any:
    """What a change sent, for its audit line: the top-level fields of a JSON body, values cut to 200 characters,
    lists and objects summarized, secret-looking fields redacted."""
    data = json.loads(raw or b"null")
    if not isinstance(data, dict):
        return {"body": type(data).__name__}
    out: dict[str, Any] = {}
    for k, v in list(data.items())[:40]:
        if _SECRET_KEY.search(str(k)):
            out[k] = "[redacted]"
        elif isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v[:200] if isinstance(v, str) else v
        elif isinstance(v, list):
            out[k] = f"[{len(v)} item{'s' if len(v) != 1 else ''}]" if len(json.dumps(v, default=str)) > 200 else v
        else:
            out[k] = f"{{{len(v)} field{'s' if len(v) != 1 else ''}}}" if isinstance(v, dict) else str(v)[:200]
    return out
_recent_reads: dict[tuple, float] = {}


def _classify(request: Request, response: Any) -> Optional[tuple[str, tuple[str, ...], dict, dict]]:
    route = request.scope.get("route")
    template = getattr(route, "path", None) or request.url.path
    params = dict(request.path_params or {})
    for methods, pattern, cats, build in RULES:
        if request.method in methods and pattern.search(template):
            if template.endswith("/content") and request.query_params.get("disposition") == "inline":
                cats = ("dataLoad",)
                return template, cats, {"loadedResources": _ids(params)}, {}
            req_f, res_f = build(request, response, params)
            return template, cats, req_f, res_f
    if request.method == "GET":
        # an unclassified read of one resource: metadata access, once a minute per user, route and resource (polling)
        if not params:
            return None
        key = (str((auth.current() or {}).get("id")), template, tuple(sorted(params.items())))
        now = time.time()
        if now - _recent_reads.get(key, 0) < READ_DEDUPE_S:
            return None
        if len(_recent_reads) > 20000:
            _recent_reads.clear()
        _recent_reads[key] = now
        return template, ("metaDataAccess",), {"accessedMetaDataResources": _ids(params), "accessedMetaDataDescription": f"GET {request.url.path}"}, {}
    ids = _ids(params)
    if request.method == "DELETE":
        return template, ("appConfigDelete",), {"deletedAppConfigIds": ids, "deleteAppConfigDescription": f"DELETE {request.url.path}"}, {}
    if request.method == "POST" and not params:
        return template, ("appConfigCreate",), {"createAppConfigDescription": f"POST {request.url.path}"}, {"createdAppConfigIds": []}
    return template, ("appConfigUpdate",), {"updatedAppConfigIds": ids, "updateAppConfigDescription": f"{request.method} {request.url.path}"}, {}


def _product(path: str) -> str:
    seg = path.split("/")[2] if path.count("/") >= 2 else "platform"
    return PRODUCTS.get(seg, seg or "platform")


def _endpoint_name(product: str, method: str, template: str) -> str:
    rest = re.sub(r"\{[^}]+\}", "", template.removeprefix("/api/"))
    rest = re.sub(r"[^A-Za-z0-9]+", "_", rest).strip("_")
    return f"{product}_{method}_{rest}".replace("-", "_").upper()


async def middleware(request: Request, call_next):  # noqa: ANN001, ANN201
    """Audits API requests made by users (runs inside auth.middleware, so the signed-in user is known)."""
    path = request.url.path
    if not path.startswith("/api/") or request.method in ("OPTIONS", "HEAD") or SKIP.match(path):
        return await call_next(request)
    p = auth.current()
    cookie = request.cookies.get(auth.COOKIE)
    bearer = request.headers.get("authorization", "")
    ctx = {"uid": (p or {}).get("id") if p and not p.get("service") else None,
           "origins": [x for x in (request.headers.get("origin"), request.headers.get("x-forwarded-for")) if x],
           "origin": (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or (request.client.host if request.client else None),
           "source_origin": request.client.host if request.client else None, "user_agent": request.headers.get("user-agent"),
           "trace_id": request.headers.get("x-b3-traceid") or uuid.uuid4().hex[:16],
           "sid": auth._session_id(auth._sha(cookie)) if cookie else None,
           "token_id": auth._sha(bearer[7:].strip())[:16] if bearer.lower().startswith("bearer ") else None, "emitted": False}
    llm = request.method == "POST" and _LLM_PATH.search(path)
    if request.method in ("POST", "PUT", "PATCH") and not llm and "json" in (request.headers.get("content-type") or "") \
            and int(request.headers.get("content-length") or 0) <= BODY_SUMMARY_MAX:
        try:
            ctx["body_summary"] = body_summary(await request.body())
        except Exception:  # noqa: BLE001
            pass
    if llm:
        try:
            ctx["llm_inputs"] = _llm_text(await request.body(), _LLM_PROMPT_KEYS)
        except Exception:  # noqa: BLE001
            pass
    token = _req.set(ctx)
    try:
        response = await call_next(request)
    finally:
        _req.reset(token)
    try:
        service = p.get("service") if p else False
        anonymous_share = p is None and path.startswith("/api/drive/shared/")
        if ctx["emitted"] or service or (p is None and not anonymous_share):
            return response
        hit = _classify(request, response)
        if not hit:
            return response
        template, cats, req_f, res_f = hit
        if ctx.get("body_summary") and any(c.startswith("appConfig") for c in cats):
            req_f["changedFields"] = ctx["body_summary"]
        if p and str(p.get("scope") or "").startswith("oauth:"):
            cats = (*cats, "inApplicationContext")
            req_f["applicationRid"] = str(p["scope"])[6:]
        status = response.status_code
        result = "SUCCESS" if status < 400 else "UNAUTHORIZED" if status in (401, 403) else "ERROR"
        product = _product(path)

        def write() -> None:
            token = _req.set(ctx)
            try:
                emit(_endpoint_name(product, request.method, template), cats, req_f, {**res_f, "status": status}, result=result, product=product)
            finally:
                _req.reset(token)

        if "llmInference" in cats and ctx.get("llm_inputs") is not None:
            req_f["llmInferenceInputs"] = ctx["llm_inputs"]
        if "llmInference" in cats and hasattr(response, "body_iterator"):
            # the answer (JSON or a stream): written when the response has been sent
            inner = response.body_iterator

            async def tee():  # noqa: ANN202
                buf: list[bytes] = []
                size = 0
                try:
                    async for chunk in inner:
                        b = chunk if isinstance(chunk, (bytes, bytearray)) else str(chunk).encode()
                        if size < LLM_CONTENT_MAX * 4:
                            buf.append(bytes(b))
                            size += len(b)
                        yield chunk
                finally:
                    try:
                        res_f["llmInferenceResponses"] = _llm_text(b"".join(buf), _LLM_ANSWER_KEYS)
                        write()
                    except Exception:  # noqa: BLE001
                        log.exception("audit.3 LLM line failed")

            response.body_iterator = tee()
            return response
        write()
    except Exception:  # noqa: BLE001 - auditing never fails the request
        log.exception("audit.3 classification failed")
    return response


# ------------------------------------------------------------------------------------------------
# reading log lines
# ------------------------------------------------------------------------------------------------


def _orgs_on_disk() -> list[str]:
    root = DIR / "logs"
    return sorted(p.name for p in root.iterdir() if p.is_dir()) if root.exists() else []


def _files(org: str, start: datetime, end: datetime) -> list[tuple[datetime, Path]]:
    """Log files of an organization whose window starts in [start, end)."""
    out = []
    root = DIR / "logs" / org
    if not root.exists():
        return out
    for day in sorted(root.iterdir()):
        try:
            d = datetime.strptime(day.name, "%Y%m%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if d + timedelta(days=1) <= start or d >= end:
            continue
        for f in sorted(day.glob("*.jsonl")):
            t = datetime.strptime(day.name + f.stem, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
            if start <= t < end or (t < start < t + timedelta(seconds=WINDOW)):
                out.append((t, f))
    return out


def lines(start: datetime, end: datetime, orgs: Optional[list[str]] = None) -> Iterable[dict]:
    for org in orgs or _orgs_on_disk():
        for _t, f in _files(org, start, end):
            try:
                with f.open(encoding="utf-8") as fh:
                    for raw in fh:
                        try:
                            line = json.loads(raw)
                        except ValueError:
                            continue
                        if start.isoformat() <= line["time"].replace("Z", "+00:00") < end.isoformat():
                            yield line
            except FileNotFoundError:
                continue


def _parse_time(v: Optional[str], default: datetime) -> datetime:
    if not v:
        return default
    try:
        t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, f"not a date or time: {v}") from None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def matches(line: dict, categories: Optional[list[str]] = None, uid: Optional[str] = None, product: Optional[str] = None,
            result: Optional[str] = None, text: str = "", resource: Optional[str] = None) -> bool:
    if categories and not set(categories) & set(line.get("categories") or []):
        return False
    if uid and line.get("uid") != uid:
        return False
    if product and line.get("product") != product:
        return False
    if result and line.get("result") != result:
        return False
    if resource and resource not in {e.get("id") for e in line.get("entities") or []}:
        return False
    if text and text.lower() not in json.dumps(line, default=str).lower():
        return False
    return True


@router.get("/categories")
def categories() -> list[dict]:
    auth.require_user()
    return [{"name": k, "request_fields": list(v[0]), "result_fields": list(v[1]), "description": v[2]} for k, v in sorted(CATEGORIES.items())]


@router.get("/events")
def events(start: Optional[str] = None, end: Optional[str] = None, categories: str = "", uid: Optional[str] = None, product: Optional[str] = None,
           result: Optional[str] = None, q: str = "", resource: Optional[str] = None, org: Optional[str] = None, limit: int = 200) -> dict:
    """audit.3 lines, newest first, filtered by time first (the reference's performance note), then categories."""
    _require_reader(org)
    t1 = _parse_time(end, _now() + timedelta(minutes=1))
    t0 = _parse_time(start, t1 - timedelta(days=1))
    cats = [c for c in categories.split(",") if c]
    out = [x for x in lines(t0, t1, [org] if org else None) if matches(x, cats, uid, product, result, q, resource)]
    out.sort(key=lambda x: x["time"], reverse=True)
    names = _user_names({x.get("uid") for x in out[:limit]})
    return {"total": len(out), "events": [{**x, "userName": names.get(x.get("uid"))} for x in out[: max(1, min(limit, 2000))]],
            "start": t0.isoformat(), "end": t1.isoformat()}


def _user_names(uids: set) -> dict:
    """Downstream enrichment of uids with user names (audit.3 lines carry only the uid)."""
    out = {}
    try:
        for u in auth._users():
            if u["id"] in uids:
                out[u["id"]] = u.get("display_name") or u["username"]
    except Exception:  # noqa: BLE001
        pass
    return out


@router.get("/summary")
def summary(days: int = 7, org: Optional[str] = None) -> dict:
    """Counts by category, product, result and day over the last days."""
    _require_reader(org)
    t1 = _now()
    t0 = t1 - timedelta(days=max(1, min(days, 90)))
    by_cat: dict[str, int] = {}
    by_product: dict[str, int] = {}
    by_result: dict[str, int] = {}
    by_day: dict[str, int] = {}
    users: set = set()
    total = 0
    for x in lines(t0, t1, [org] if org else None):
        total += 1
        for c in x.get("categories") or []:
            by_cat[c] = by_cat.get(c, 0) + 1
        by_product[x.get("product") or "?"] = by_product.get(x.get("product") or "?", 0) + 1
        by_result[x.get("result") or "?"] = by_result.get(x.get("result") or "?", 0) + 1
        by_day[x["time"][:10]] = by_day.get(x["time"][:10], 0) + 1
        if x.get("uid"):
            users.add(x["uid"])
    return {"total": total, "users": len(users), "categories": by_cat, "products": by_product, "results": by_result, "days": by_day,
            "start": t0.isoformat(), "end": t1.isoformat()}


# ------------------------------------------------------------------------------------------------
# who may read audit logs
# ------------------------------------------------------------------------------------------------


def _settings() -> dict:
    s = _read(DIR / "settings.json", {})
    s.setdefault("readers", {})  # org -> [user ids] with "Create datasets with audit logs for the organization"
    s.setdefault("exports", [])
    return s


def can_read(p: Optional[dict], org: Optional[str]) -> bool:
    if not auth.enabled():
        return True
    if not p or p.get("service"):
        return bool(p and p.get("service"))
    if p.get("role") == "admin":
        return True
    readers = _settings()["readers"]
    return p.get("id") in (readers.get(org or "", []) if org else [u for v in readers.values() for u in v])


def _require_reader(org: Optional[str]) -> dict:
    p = auth.require_user()
    if not can_read(p, org):
        raise HTTPException(403, "Reading audit logs needs the organization's audit log reader permission (Control Panel → Audit logs)")
    return p


class ReadersIn(BaseModel):
    users: list[str]


@router.get("/organizations")
def organizations() -> list[dict]:
    """Organizations with their audit log readers (and "default": users without an organization)."""
    auth.require_admin()
    readers = _settings()["readers"]
    orgs = [{"id": DEFAULT_ORG, "name": "Users without an organization"}] + [{"id": o["id"], "name": o.get("name") or o["id"]} for o in auth._orgs()]
    return [{**o, "readers": readers.get(o["id"], [])} for o in orgs]


@router.put("/organizations/{org}/readers")
def set_readers(org: str, req: ReadersIn) -> dict:
    auth.require_admin()
    with _lock:
        s = _settings()
        s["readers"][org] = sorted(set(req.users))
        _write(DIR / "settings.json", s)
    emit("AUDIT_SET_READERS", ["managementPermissions"], {"resourcesWithPermissionsChanges": [{"type": "organization", "id": org}],
                                                          "permissionChangeContext": f"audit log readers: {len(req.users)}"}, product="audit")
    return {"org": org, "readers": sorted(set(req.users))}


# ------------------------------------------------------------------------------------------------
# SIEM ingestion: list-log-files / get-log-file-content
# ------------------------------------------------------------------------------------------------


def _org_key(org: str) -> str:
    return org.rsplit(".", 1)[-1] if org.startswith("ri.") else org


def _siem_caller(org: str) -> dict:
    p = auth.current()
    if auth.enabled() and (p is None or p.get("service")):
        raise HTTPException(401, "Authorization: Bearer <access_token> is required")
    scope = str((p or {}).get("scope") or "")
    if scope.startswith("oauth:"):
        import developer_console

        if not developer_console.audit_read(scope[6:]):
            raise HTTPException(403, "the application has no audit-read access (api:audit-read)")
    if not can_read(p, org):
        raise HTTPException(403, "the caller needs the organization's audit log reader permission (Control Panel → Audit logs)")
    return p or {}


def _token(after: str, start: str, end: Optional[str]) -> str:
    return base64.urlsafe_b64encode(json.dumps({"after": after, "start": start, "end": end}).encode()).decode().rstrip("=")


def _untoken(t: str) -> dict:
    try:
        return json.loads(base64.urlsafe_b64decode(t + "=" * (-len(t) % 4)))
    except ValueError:
        raise HTTPException(400, "invalid pageToken") from None


@siem.get("/organizations/{organization}/logFiles")
def list_log_files(organization: str, startDate: Optional[str] = None, endDate: Optional[str] = None, pageToken: Optional[str] = None,  # noqa: N803
                   pageSize: int = 100) -> dict:  # noqa: N803
    """Log files whose 5-minute window has ended, oldest first. nextPageToken is always returned."""
    org = _org_key(organization)
    _siem_caller(org)
    if pageToken:
        t = _untoken(pageToken)
        after, start, end = t.get("after") or "", t["start"], t.get("end")
    else:
        if not startDate:
            raise HTTPException(400, "startDate is required on the first request")
        after, start, end = "", startDate, endDate
    t0 = _parse_time(start, _now())
    t1 = _parse_time(end, _now()) + (timedelta(days=1) if end and len(end) == 10 else timedelta())
    closed = _window(_now())
    rows = []
    for w, f in _files(org, t0, min(t1, closed) if end else closed):
        fid = w.strftime("%Y%m%dT%H%M")
        if fid > after:
            rows.append({"id": fid, "startTime": _iso(w), "endTime": _iso(w + timedelta(seconds=WINDOW)), "size": f.stat().st_size})
    rows = rows[: max(1, min(pageSize, 1000))]
    nxt = rows[-1]["id"] if rows else after
    return {"data": rows, "nextPageToken": _token(nxt, start, end)}


@siem.get("/organizations/{organization}/logFiles/{log_file_id}/content")
def log_file_content(organization: str, log_file_id: str) -> Response:
    org = _org_key(organization)
    _siem_caller(org)
    if not re.fullmatch(r"\d{8}T\d{4}", log_file_id):
        raise HTTPException(404, "log file not found")
    f = DIR / "logs" / org / log_file_id[:8] / f"{log_file_id[9:]}.jsonl"
    if not f.is_file():
        raise HTTPException(404, "log file not found")
    emit("AUDIT_GET_LOG_FILE_CONTENT", ["auditDataShareCreate"], {"shareTargets": [log_file_id]}, {"shareIds": {log_file_id: log_file_id}}, product="audit")
    return Response(f.read_bytes(), media_type="application/x-ndjson")


# ------------------------------------------------------------------------------------------------
# export to a dataset
# ------------------------------------------------------------------------------------------------


class ExportIn(BaseModel):
    org: str = DEFAULT_ORG
    schema_: str = Field("audit.3", alias="schema", pattern="^audit\\.(2|3)$")
    folder_id: str
    name: str = Field(min_length=1, max_length=120)
    markings: Optional[list[str]] = None
    start_date: Optional[str] = None
    retention_days: Optional[int] = Field(None, ge=1, le=730)
    acknowledged: bool = False

    model_config = {"populate_by_name": True}


def _exports() -> list[dict]:
    return _settings()["exports"]


def _save_exports(rows: list[dict]) -> None:
    with _lock:
        s = _settings()
        s["exports"] = rows
        _write(DIR / "settings.json", s)


@router.get("/exports")
def list_exports() -> list[dict]:
    auth.require_admin()
    return _exports()


@router.post("/exports")
def create_export(req: ExportIn) -> dict:
    p = auth.require_admin()
    if not req.acknowledged:
        raise HTTPException(400, "Acknowledge the security implications of an audit log dataset first")
    import drive

    drive._item(req.folder_id, need="editor")
    marks = req.markings if req.markings is not None else ([auth.org_marking(req.org)] if req.org != DEFAULT_ORG else [])
    e = {"id": "ax-" + uuid.uuid4().hex[:10], "org": req.org, "schema": req.schema_, "folder_id": req.folder_id, "name": req.name.strip(),
         "markings": marks, "start_date": req.start_date, "retention_days": req.retention_days, "paused": False, "item_id": None,
         "created_at": _iso(), "created_by": p.get("username"), "last_run": None, "rows": 0, "cursor": None, "error": None}
    _save_exports([*_exports(), e])
    emit("AUDIT_CREATE_EXPORT", ["auditDataShareCreate", "dataCreate"], {"shareTargets": [req.org], "createdResources": [{"type": "audit-export", "id": e["id"]}]},
         {"shareIds": {req.org: e["id"]}}, product="audit")
    threading.Thread(target=run_export, args=(e["id"],), daemon=True).start()
    return e


class ExportChange(BaseModel):
    paused: Optional[bool] = None
    retention_days: Optional[int] = Field(None, ge=1, le=730)


@router.patch("/exports/{export_id}")
def update_export(export_id: str, req: ExportChange) -> dict:
    auth.require_admin()
    rows = _exports()
    e = next((x for x in rows if x["id"] == export_id), None)
    if not e:
        raise HTTPException(404, "export not found")
    if req.paused is not None:
        e["paused"] = req.paused
    if req.retention_days is not None:
        e["retention_days"] = req.retention_days
    _save_exports(rows)
    return e


@router.post("/exports/{export_id}/run")
def run_export_now(export_id: str) -> dict:
    auth.require_admin()
    return run_export(export_id)


def _audit2_rows(since: Optional[str], start_date: Optional[str]) -> list[dict]:
    """The sign-in log (kept before audit.3) in the audit.2 export schema."""
    with auth._db() as con:
        rows = con.execute("SELECT id, at, event, user_id, username, actor, ip, detail FROM audit ORDER BY id").fetchall()
    out = []
    for rid, at, event, uid, username, actor, ip, detail in rows:
        if since and at <= since or start_date and at[:10] < start_date:
            continue
        out.append({"filename": "auth-audit.log", "ip": ip, "name": event.upper(), "request_params": json.dumps({"username": username, "actor": actor,
                    "_categories": list(AUTH_EVENTS.get(event, ()))}), "result": "UNAUTHORIZED" if event == "sign_in_failed" else "SUCCESS",
                    "result_params": json.dumps({"detail": detail}), "sid": None, "time": at, "token_id": None, "trace_id": None, "type": "audit.2",
                    "uid": uid})
    return out


def _flat(line: dict) -> dict:
    return {"time": line["time"], "date": line["time"][:10], "name": line["name"], "categories": line.get("categories") or [], "product": line.get("product"),
            "service": line.get("service"), "result": line.get("result"), "uid": line.get("uid"), "orgId": line.get("orgId"), "sid": line.get("sid"),
            "tokenId": line.get("tokenId"), "traceId": line.get("traceId"), "origin": line.get("origin"), "origins": line.get("origins") or [],
            "sourceOrigin": line.get("sourceOrigin"), "userAgent": line.get("userAgent"), "eventId": line.get("eventId"), "logEntryId": line.get("logEntryId"),
            "sequenceId": line.get("sequenceId"), "host": line.get("host"), "environment": line.get("environment"), "stack": line.get("stack"),
            "producerType": line.get("producerType"), "productVersion": line.get("productVersion"),
            "requestFields": json.dumps(line.get("requestFields") or {}, default=str), "resultFields": json.dumps(line.get("resultFields") or {}, default=str),
            "entities": json.dumps(line.get("entities") or [], default=str), "users": json.dumps(line.get("users") or [], default=str)}


def run_export(export_id: str) -> dict:
    """Append new lines to an export dataset (one APPEND transaction) and apply its retention policy."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    import dataset_versions
    import db
    import drive
    import pipeline_datasets

    rows = _exports()
    e = next((x for x in rows if x["id"] == export_id), None)
    if not e:
        raise HTTPException(404, "export not found")
    if e.get("paused"):
        return e
    now = _iso()
    try:
        if e["schema"] == "audit.2":
            new = _audit2_rows(e.get("cursor"), e.get("start_date"))
            cursor = max([r["time"] for r in new], default=e.get("cursor"))
        else:
            start = _parse_time(e.get("cursor") or e.get("start_date"), _now() - timedelta(days=3650))
            closed = _window(_now())
            new = [_flat(x) for x in lines(start, closed, [e["org"]]) if not e.get("cursor") or x["time"] > e["cursor"]]
            cursor = max([r["time"] for r in new], default=e.get("cursor"))
        for r in new:
            r["ingested_at"] = now
        old: list[dict] = []
        item = db.drive_get(e["item_id"]) if e.get("item_id") else None
        if item and not item.get("trashed_at"):
            data = drive.read_bytes(item)
            old = pq.read_table(io.BytesIO(data)).to_pylist()
        keep = old
        dropped = 0
        if e.get("retention_days"):
            cut = _iso(_now() - timedelta(days=e["retention_days"]))
            keep = [r for r in old if (r.get("ingested_at") or "") >= cut]
            dropped = len(old) - len(keep)
        if not new and not dropped and item:
            e.update(last_run=now, error=None)
            _save_exports(rows)
            return e
        table = pa.Table.from_pylist(keep + new) if keep or new else pa.table({"time": pa.array([], pa.string())})
        buf = io.BytesIO()
        pq.write_table(table, buf)
        data = buf.getvalue()
        fname = e["name"] if e["name"].endswith(".parquet") else f"{e['name']}.parquet"
        if item and not item.get("trashed_at"):
            pipeline_datasets._replace_content(item, data)
        else:
            item = drive._store(e["folder_id"], drive._clean_name(fname), io.BytesIO(data), len(data), pipeline_datasets.PARQUET)
            auth._set_item(item["id"], own=sorted(set(e.get("markings") or [])))
        dataset_versions.record(item["id"], data, "build", {"kind": "audit_export", "id": e["id"], "transaction": "APPEND",
                                                            "appended": len(new), "retention_deleted": dropped})
        e.update(item_id=item["id"], last_run=now, rows=len(keep) + len(new), cursor=cursor, error=None)
    except HTTPException:
        raise
    except Exception as ex:  # noqa: BLE001
        log.exception("audit export %s failed", export_id)
        e.update(last_run=now, error=str(ex)[:500])
    _save_exports(rows)
    return e


def _loop() -> None:
    while True:
        time.sleep(EXPORT_INTERVAL)
        for e in _exports():
            if not e.get("paused"):
                try:
                    run_export(e["id"])
                except Exception:  # noqa: BLE001
                    log.exception("audit export loop")


def startup() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="audit3-exports", daemon=True).start()
