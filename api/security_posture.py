"""Enterprise security and Infrastructure security (Security & Governance docs 14 and 15): the platform's security
posture, checked against the reference's best practices from live data, with the actions that fix what can be
fixed here and attestations for the controls only people can check (physical access, disks, hosts, backups…).

Enterprise security (protecting identity, tokens, phishing, monitoring):
  strong MFA (enrolment of administrators and users, enforcement), periodic re-authentication (session lifetime and
  idle timeout), single sign-on and password login, password policy, service accounts (Developer Console service
  users: a named owner and a periodic review; tokens rotated), inactive accounts (unused for 30 days), personal API
  tokens (no expiry, older than 90 days, unused), token spills (platform tokens found by code scanning), ingress
  allowlists, audit log monitoring (readers or exports, detections).
Infrastructure security (self-hosted installation, data connector, malicious files, vulnerabilities, recovery):
  data in transit (HTTPS address, TLS on the SQL endpoint), secrets encrypted at rest, egress controls, data
  connector agents (heartbeats, token age), executable files in Files, code scanning coverage, and attestations
  (physical access, full-disk encryption, server hardening, host security, privileged access through bastions,
  patching within 30 days, encrypted backups and an annual restore test, security bulletins subscription, an
  incident contact).

A check is pass, warn, fail or manual (an attestation); attestations record who confirmed a control, when, a note and
evidence (a Files item), and go stale after their period. Every change is written to audit.3.

Mounted by server.py under /api/security-posture (administrators).
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import audit3
import auth

router = APIRouter(prefix="/api/security-posture", tags=["security-posture"])
DIR = Path("data/security_posture")
_lock = threading.RLock()
EXECUTABLE = re.compile(r"\.(exe|dll|msi|bat|cmd|ps1|vbs|scr|com|jar|sh|apk|app|dmg|so)$", re.I)

# attestations: id -> (title, doc section, how often it must be re-confirmed, in days)
ATTESTATIONS: dict[str, tuple[str, str, str, int]] = {
    "physical_access": ("Physical access to servers is restricted, time-bound and documented", "infrastructure", "Physical access", 365),
    "disk_encryption": ("Full-disk encryption (AES-128/256, keys in an HSM) on every server and storage device", "infrastructure", "Data at rest", 365),
    "tls_certificate": ("A trusted certificate (90 days to 1 year), TLS 1.2+ only, strong cipher suites (ECDHE with AES-GCM or ChaCha20-Poly1305)",
                        "infrastructure", "Data in transit", 90),
    "network_segmentation": ("The installation is in a dedicated network segment: deny inbound by default, allowlisted ports and subnets, no public exposure without IDS / WAF",
                             "infrastructure", "Network segmentation", 365),
    "network_monitoring": ("Intrusion detection, firewalls, DLP and network security logs cover the installation", "infrastructure", "Network security", 365),
    "server_hardening": ("Servers are hardened (CIS / NIST) on a supported operating system", "infrastructure", "Server hardening", 365),
    "patching": ("Critical vulnerabilities on hosts and the platform are patched within 30 days", "infrastructure", "Application patching", 30),
    "host_security": ("Host audit logs are collected; host IDS and DLP run", "infrastructure", "Host security", 365),
    "privileged_access": ("Infrastructure is reached only through bastion hosts, with MFA", "infrastructure", "Privileged access", 365),
    "backups": ("Encrypted full-disk backups (at least the platform's metadata) are stored durably / offline", "infrastructure", "Backups", 30),
    "restore_test": ("The backup and restore process was tested", "infrastructure", "Backups", 365),
    "antimalware": ("Workstations and servers run up-to-date antimalware with real-time detection; browsers' malware protection is on",
                    "infrastructure", "Malicious files", 365),
    "security_bulletins": ("Someone receives security bulletins and acts on them", "infrastructure", "Monitoring for vulnerabilities", 365),
    "dependency_review": ("Packages used in user-authored code are reviewed for known vulnerabilities", "infrastructure", "Vulnerabilities in user-authored code", 90),
    "connector_hosts": ("Data connector hosts are segmented, egress-allowlisted, hardened and patched", "infrastructure", "Protecting the data connector", 365),
    "zero_trust": ("Access depends on identity and device health (conditional access, device posture) at the identity provider", "enterprise", "Zero trust", 365),
    "idp_mfa_strength": ("The identity provider requires strong MFA (FIDO2 / hardware or OTP tokens; no SMS, email or security questions)", "enterprise",
                         "Strong MFA", 365),
    "phishing_training": ("Users are trained on password hygiene and recognizing the platform's real domain and emails", "enterprise", "Operational security", 365),
}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "security_posture"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="seconds")


def _parse(v: Optional[str]) -> Optional[datetime]:
    if not v:
        return None
    try:
        t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _state() -> dict:
    s = audit3._read(DIR / "state.json", {})
    s.setdefault("attestations", {})
    s.setdefault("reviews", {})
    s.setdefault("contact", "")
    return s


def _save(s: dict) -> None:
    audit3._write(DIR / "state.json", s)


def _check(cid: str, title: str, status: str, detail: str, section: str, action: Optional[dict] = None, items: Optional[list] = None) -> dict:
    return {"id": cid, "title": title, "status": status, "detail": detail, "section": section, "action": action, "items": items or []}


def _attestation(aid: str) -> dict:
    title, area, section, days = ATTESTATIONS[aid]
    a = _state()["attestations"].get(aid)
    if not a:
        return _check(f"attest:{aid}", title, "manual", "Not confirmed yet: check it and record the attestation.", section, {"kind": "attest", "id": aid})
    at = _parse(a["at"])
    due = at + timedelta(days=days) if at else None
    stale = due is not None and due < _now()
    status = "warn" if stale or a.get("status") == "partial" else "fail" if a.get("status") == "no" else "pass"
    detail = f"{'Confirmed' if a.get('status') == 'yes' else 'Partly in place' if a.get('status') == 'partial' else 'Not in place'} by {a['by']} on {a['at'][:10]}"
    detail += f" — re-confirm by {due.date().isoformat()}" if due else ""
    if stale:
        detail += " (overdue)"
    if a.get("note"):
        detail += f". {a['note']}"
    return {**_check(f"attest:{aid}", title, status, detail, section, {"kind": "attest", "id": aid}), "attestation": a}


def _users() -> list[dict]:
    return [u for u in auth._users() if not u.get("disabled")]


def _service_users() -> list[dict]:
    out = []
    try:
        import developer_console as dc

        for m in dc._all():
            uid = m.get("service_user_id")
            if uid:
                try:
                    u = auth._user(uid)
                except HTTPException:
                    continue
                out.append({"user": u, "app": m})
    except Exception:  # noqa: BLE001
        pass
    return out


def _tokens() -> list[dict]:
    with auth._db() as con:
        rows = con.execute("SELECT id, user_id, record FROM tokens").fetchall()
    out = []
    for tid, uid, rec in rows:
        r = json.loads(rec)
        out.append({"id": tid, "user_id": uid, **{k: r.get(k) for k in ("name", "created_at", "expires_at", "last_used_at")}})
    return out


# ------------------------------------------------------------------------------------------------
# enterprise security
# ------------------------------------------------------------------------------------------------


def _hosting_check() -> dict:
    """Developer Console websites run their scripts on the hosting origin: it must not share a site (registrable
    domain) with the platform, or a hosted page could act with a visitor's session."""
    from urllib.parse import urlparse

    api, host = urlparse(auth.api_public_url()).hostname or "", urlparse(auth.hosting_url()).hostname or ""
    site = lambda h: h if h in ("localhost",) or h.replace(".", "").isdigit() else ".".join(h.split(".")[-2:])  # noqa: E731
    local = api in ("localhost", "127.0.0.1")
    ok = host and site(host) != site(api)
    return _check("hosting_origin", "Hosted websites are served from a separate site", "pass" if ok else ("warn" if local else "fail"),
                  (f"Developer Console websites are served from {auth.hosting_url()}, a different site than the platform ({auth.api_public_url()})." if ok
                   else f"Hosted websites share the site {site(api)} with the platform: set BLUESANDAI_HOSTING_URL to an address on another registrable domain."),
                  "Protecting tokens and API keys", {"kind": "link", "href": "/developer-console", "label": "Developer Console"})


def enterprise() -> list[dict]:
    s = auth.settings()
    users = _users()
    admins = [u for u in users if u.get("role") == "admin"]
    svc_ids = {x["user"]["id"] for x in _service_users()}
    people = [u for u in users if u["id"] not in svc_ids]
    checks = []
    no_mfa_admins = [u for u in admins if not u.get("mfa_enabled")]
    checks.append(_check("mfa_admins", "Administrators use multi-factor authentication",
                         "pass" if s.get("mfa_required_admins") or s.get("mfa_required_all") else "fail" if no_mfa_admins else "warn",
                         ("Required for administrators. " if s.get("mfa_required_admins") or s.get("mfa_required_all") else "Not required: turn on \"Require two-factor for administrators\". ")
                         + f"{len(admins) - len(no_mfa_admins)} of {len(admins)} administrators enrolled.", "Strong MFA",
                         {"kind": "link", "href": "/control-panel?section=security", "label": "Security settings"},
                         [{"id": u["id"], "name": u["username"]} for u in no_mfa_admins]))
    enrolled = [u for u in people if u.get("mfa_enabled")]
    sso_only = [u for u in people if u.get("sso_only") or u.get("identities")]
    checks.append(_check("mfa_all", "Every user has strong multi-factor authentication",
                         "pass" if s.get("mfa_required_all") else "warn",
                         f"{len(enrolled)} of {len(people)} people use the platform's authenticator codes; {len(sso_only)} sign in with single sign-on (MFA at the identity provider)."
                         + ("" if s.get("mfa_required_all") else " Requiring two-factor for everyone is recommended."), "Strong MFA",
                         {"kind": "link", "href": "/control-panel?section=security", "label": "Security settings"}))
    checks.append(_attestation("idp_mfa_strength"))
    hours = int(s.get("session_days") or 1) * 24
    idle = int(s.get("idle_timeout_minutes") or 0)
    checks.append(_check("session_lifetime", "Sessions are short-lived (periodic re-authentication)",
                         "pass" if hours <= 24 and 0 < idle <= 120 else "warn" if hours <= 7 * 24 else "fail",
                         f"Sessions last {s.get('session_days')} day(s) (renewed while used); idle timeout {idle or 'off'} minute(s). The reference keeps sessions to about 16 hours.",
                         "Periodic re-authentication", {"kind": "link", "href": "/control-panel?section=security", "label": "Session settings"}))
    pw_ok = int(s.get("password_min_length") or 0) >= 12 and s.get("password_block_common")
    checks.append(_check("password_policy", "Passwords are long, unique and not common",
                         "pass" if pw_ok else "warn", f"Minimum length {s.get('password_min_length')}, common passwords {'blocked' if s.get('password_block_common') else 'allowed'}, "
                         f"history {s.get('password_history')}. Passwordless single sign-on is preferred; at least 12 characters otherwise.", "Credential hygiene",
                         {"kind": "link", "href": "/control-panel?section=security", "label": "Password policy"}))
    providers = auth.sso_providers()
    checks.append(_check("sso", "Identities are managed centrally (single sign-on)", "pass" if providers else "warn",
                         f"{len(providers)} single sign-on provider(s); password sign-in {'on' if s.get('password_login', True) else 'off (administrators only)'}.", "Single sign-on",
                         {"kind": "link", "href": "/control-panel?section=sso", "label": "Single sign-on"}))
    checks.append(_attestation("zero_trust"))
    # service accounts
    reviews = _state()["reviews"]
    svc = _service_users()
    stale_reviews = [x for x in svc if not reviews.get(x["user"]["id"]) or (_parse(reviews[x["user"]["id"]]["at"]) or _now()) < _now() - timedelta(days=90)]
    checks.append(_check("service_accounts", "Service accounts are documented, owned and reviewed",
                         "pass" if not stale_reviews else "warn",
                         f"{len(svc)} service account(s); {len(stale_reviews)} not reviewed in the last 90 days. Each needs a named owner, a review, and rotation when people leave.",
                         "Service accounts", {"kind": "review"},
                         [{"id": x["user"]["id"], "name": x["user"]["username"], "app": x["app"]["name"], "owner": x["app"].get("created_by"),
                           "reviewed": reviews.get(x["user"]["id"])} for x in svc]))
    cut = _iso(_now() - timedelta(days=30))
    inactive = [u for u in people if (u.get("last_login_at") or u.get("created_at") or "") < cut and not u.get("invited")]
    checks.append(_check("inactive_accounts", "Accounts unused for 30 days are disabled", "pass" if not inactive else "warn",
                         f"{len(inactive)} active account(s) have not signed in for 30 days.", "Account lifecycle", {"kind": "disable_inactive", "days": 30},
                         [{"id": u["id"], "name": u["username"], "last_login_at": u.get("last_login_at")} for u in inactive[:100]]))
    toks = _tokens()
    no_expiry = [t for t in toks if not t.get("expires_at")]
    old = [t for t in toks if (t.get("created_at") or "") < _iso(_now() - timedelta(days=90))]
    unused = [t for t in toks if (t.get("last_used_at") or t.get("created_at") or "") < _iso(_now() - timedelta(days=30))]
    names = {u["id"]: u["username"] for u in auth._users()}
    checks.append(_check("tokens", "Personal API tokens expire and unused ones are revoked",
                         "pass" if not (no_expiry or unused) else "warn",
                         f"{len(toks)} token(s): {len(no_expiry)} never expire, {len(old)} older than 90 days, {len(unused)} unused for 30 days.", "Protecting tokens",
                         {"kind": "revoke_tokens"},
                         [{"id": t["id"], "name": t.get("name"), "user": names.get(t["user_id"], t["user_id"]), "created_at": t.get("created_at"),
                           "expires_at": t.get("expires_at"), "last_used_at": t.get("last_used_at")} for t in toks if t in no_expiry or t in unused][:200]))
    spills = _token_spills()
    checks.append(_check("token_spills", "No platform tokens are committed to code", "pass" if not spills else "fail",
                         f"{len(spills)} token-looking string(s) in the latest code scans." + (" Revoke them and rotate." if spills else ""), "Token spills",
                         {"kind": "link", "href": "/code-scanning", "label": "Code scanning"}, spills[:50]))
    try:
        import network

        ns = network._cache.get("settings") or {}
    except Exception:  # noqa: BLE001
        ns = {}
    checks.append(_check("ingress", "Ingress is restricted to known networks", "pass" if ns.get("enforce_ingress") and ns.get("ingress_cidrs") else "warn",
                         f"Ingress allowlist {'enforced' if ns.get('enforce_ingress') else 'not enforced'} ({len(ns.get('ingress_cidrs') or [])} range(s)).",
                         "Ingress controls", {"kind": "link", "href": "/control-panel?section=network", "label": "Network ingress"}))
    a3 = audit3._settings()
    try:
        import audit_monitor

        dets = [d for d in audit_monitor._config().values() if d["enabled"]]
    except Exception:  # noqa: BLE001
        dets = []
    monitored = bool(a3.get("exports") or any(a3.get("readers", {}).values()))
    checks.append(_check("audit_monitoring", "Audit logs are monitored", "pass" if monitored and dets else "warn",
                         f"{len(dets)} detection(s) on; {len(a3.get('exports') or [])} export dataset(s); "
                         f"{sum(len(v) for v in (a3.get('readers') or {}).values())} audit log reader(s) for a SIEM.", "Monitor audit logs",
                         {"kind": "link", "href": "/security-auditing?tab=delivery", "label": "Security auditing"}))
    checks.append(_attestation("phishing_training"))
    return checks


def _token_spills() -> list[dict]:
    out = []
    try:
        import code_repos

        for rec in code_repos.all_repos():
            chk = next(iter(code_repos._checks(rec["id"])), None)
            for f in ((chk or {}).get("code_scan") or {}).get("findings") or []:
                if "secrets" in f["rule"]:
                    out.append({"repo": rec.get("name"), "file": f["file"], "line": f["line"], "rule": f["rule"]})
    except Exception:  # noqa: BLE001
        pass
    return out


# ------------------------------------------------------------------------------------------------
# infrastructure security
# ------------------------------------------------------------------------------------------------


def infrastructure() -> list[dict]:
    checks = []
    web = auth.web_url()
    checks.append(_check("https", "Users reach the platform over HTTPS", "pass" if web.startswith("https://") else "warn",
                         f"The platform's address is {web}." + ("" if web.startswith("https://") else " Serve it through HTTPS (BLUESANDAI_WEB_URL)."), "Data in transit"))
    sql_tls = bool(os.environ.get("BLUESANDAI_SQL_TLS_CERT"))
    checks.append(_check("sql_tls", "The SQL & BI endpoint uses TLS", "pass" if sql_tls else "warn",
                         "TLS certificate configured." if sql_tls else "BLUESANDAI_SQL_TLS_CERT / _KEY are not set: BI tools connect without TLS.", "Data in transit",
                         {"kind": "link", "href": "/sql-bi", "label": "SQL & BI"}))
    checks.append(_attestation("tls_certificate"))
    key_env = bool(os.environ.get("BLUESANDAI_SECRET_KEY"))
    checks.append(_check("secrets_at_rest", "Credentials and keys are encrypted at rest", "pass" if key_env else "warn",
                         "Connection credentials, Cipher keys and two-factor secrets are sealed (Fernet). " +
                         ("The key comes from BLUESANDAI_SECRET_KEY." if key_env else "The key is a file on the API host (secrets/connections.key): keep it out of backups of the data, or set BLUESANDAI_SECRET_KEY from a secrets manager."),
                         "Data at rest"))
    checks.append(_attestation("disk_encryption"))
    try:
        import network

        ns = network._cache.get("settings") or {}
        policies = network._cache.get("policies") or []
    except Exception:  # noqa: BLE001
        ns, policies = {}, []
    egress = [p for p in policies if p.get("enabled")]
    checks.append(_check("egress", "Outbound connections are allowlisted", "pass" if ns.get("enforce_egress") else "warn",
                         f"Egress {'enforced' if ns.get('enforce_egress') else 'not enforced'}; {len(egress)} allowed destination(s) (direct, private link, agent proxy).",
                         "Egress controls",
                         {"kind": "link", "href": "/control-panel?section=network", "label": "Network egress"}))
    checks.append(_attestation("network_segmentation"))
    checks.append(_attestation("network_monitoring"))
    agents = _agents()
    stale = [a for a in agents if (a.get("token_age_days") or 0) > 180 or (a.get("last_seen_days") is not None and a["last_seen_days"] > 7)]
    checks.append(_check("connector_agents", "Data connector agents are healthy and their tokens rotated", "pass" if not stale else "warn",
                         f"{len(agents)} agent(s); {len(stale)} not seen for a week or with a token older than 180 days.", "Protecting the data connector",
                         {"kind": "link", "href": "/sources?tab=agents", "label": "Data Connection agents"}, agents))
    checks.append(_attestation("connector_hosts"))
    exe = _executables()
    checks.append(_check("executables", "Executable files in Files are reviewed", "pass" if not exe else "warn",
                         f"{len(exe)} executable or script file(s) are stored in Files (uploads are not executed by the platform; scan them with antimalware).",
                         "Malicious files", None, exe[:100]))
    checks.append(_attestation("antimalware"))
    try:
        import code_scanning

        cs = code_scanning._settings()
        covered = cs["enabled"] or cs["always_projects"] or cs["always_repos"]
    except Exception:  # noqa: BLE001
        covered = False
    checks.append(_check("code_scanning", "User-authored code is scanned for vulnerabilities", "pass" if covered else "warn",
                         "Code scanning is " + ("on." if covered else "off: turn it on for the enrollment or the Projects that matter."), "Vulnerabilities in user-authored code",
                         {"kind": "link", "href": "/code-scanning", "label": "Code scanning"}))
    checks.append(_hosting_check())
    checks.append(_dependency_check())
    checks.append(_attestation("dependency_review"))
    for aid in ("server_hardening", "patching", "host_security", "privileged_access", "physical_access", "security_bulletins"):
        checks.append(_attestation(aid))
    checks += _backup_checks()
    contact = _state()["contact"]
    checks.append(_check("incident_contact", "Security incidents have a contact", "pass" if contact else "warn",
                         f"Report incidents to {contact}." if contact else "Set who users report security concerns to.", "Reporting security concerns", {"kind": "contact"}))
    return checks


# -- the platform's own dependencies against the OSV vulnerability database (osv.dev) --

OSV_BATCH = "https://api.osv.dev/v1/querybatch"
DEPENDENCY_SCAN_DAYS = 30


def platform_dependencies() -> list[dict]:
    """The packages the platform runs on: requirements.txt (PyPI, pinned) and web/package-lock.json (npm)."""
    root = Path(__file__).resolve().parent.parent
    out: list[dict] = []
    req = root / "requirements.txt"
    if req.exists():
        for line in req.read_text("utf-8").splitlines():
            line = line.split("#", 1)[0].split(";", 1)[0].strip()
            if "==" in line:
                name, ver = line.split("==", 1)
                out.append({"ecosystem": "PyPI", "name": name.strip().split("[", 1)[0], "version": ver.strip()})
    lock = root / "web" / "package-lock.json"
    if lock.exists():
        try:
            pk = json.loads(lock.read_text("utf-8")).get("packages") or {}
        except ValueError:
            pk = {}
        seen = set()
        for path, meta in pk.items():
            if not path or not meta.get("version"):
                continue
            name = path.rsplit("node_modules/", 1)[-1]
            if (name, meta["version"]) not in seen:
                seen.add((name, meta["version"]))
                out.append({"ecosystem": "npm", "name": name, "version": meta["version"]})
    return out


def scan_dependencies(post: Any = None) -> dict:
    """Ask OSV which of the platform's packages have known vulnerabilities (package names and versions are sent,
    nothing else). `post` replaces the HTTP call (tests)."""
    deps = platform_dependencies()
    if post is None:
        import requests

        def post(body: dict) -> dict:  # noqa: F811
            r = requests.post(OSV_BATCH, json=body, timeout=60)
            r.raise_for_status()
            return r.json()
    vulnerable = []
    for i in range(0, len(deps), 1000):
        chunk = deps[i:i + 1000]
        res = post({"queries": [{"package": {"ecosystem": d["ecosystem"], "name": d["name"]}, "version": d["version"]} for d in chunk]})
        for d, r in zip(chunk, res.get("results") or []):
            ids = [v["id"] for v in (r or {}).get("vulns") or []]
            if ids:
                vulnerable.append({**d, "id": f"{d['ecosystem']}:{d['name']}@{d['version']}", "advisories": ", ".join(ids[:8]) + (" …" if len(ids) > 8 else "")})
    s = _state()
    s["dependency_scan"] = {"at": _iso(), "packages": len(deps), "vulnerable": vulnerable}
    _save(s)
    return s["dependency_scan"]


def _dependency_check() -> dict:
    scan = _state().get("dependency_scan")
    title, section = "The platform's own packages have no known vulnerabilities", "Monitoring for vulnerabilities"
    action = {"kind": "dependency_scan", "label": "Check against OSV"}
    if not scan:
        return _check("dependency_scan", title, "warn", "Not checked yet: check the platform's Python and npm packages against the OSV database.", section, action)
    at = _parse(scan["at"])
    old = not at or at < _now() - timedelta(days=DEPENDENCY_SCAN_DAYS)
    n = len(scan.get("vulnerable") or [])
    status = "fail" if n else "warn" if old else "pass"
    detail = (f"{n} of {scan['packages']} packages have known vulnerabilities (checked {scan['at'][:10]}): update them." if n
              else f"None of {scan['packages']} packages has a known vulnerability (checked {scan['at'][:10]})." + (" Check again: it is over 30 days old." if old else ""))
    return _check("dependency_scan", title, status, detail, section, action, scan.get("vulnerable") or [])


@router.post("/dependencies/scan")
def post_dependency_scan() -> dict:
    """Check the platform's packages against OSV now (administrators)."""
    auth.require_admin()
    try:
        out = scan_dependencies()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"OSV could not be reached: {e}") from None
    auth.audit("dependency_scan", None, f"{len(out['vulnerable'])} vulnerable of {out['packages']}")
    return out


def _backup_checks() -> list[dict]:
    """Backups and restore tests from the platform's own backups (backups.py), else the attestations."""
    import backups

    s = backups.settings()
    last, ver = backups.last_ok("runs"), backups.last_ok("verifications")
    action = {"kind": "link", "href": "/control-panel?section=backups", "label": "Backups"}
    out = []
    if not s["enabled"] and not last:
        out.append(_attestation("backups"))
    else:
        age = (_now() - (_parse(last["at"]) or _now())).total_seconds() / 3600 if last else None
        ok = last and age is not None and age <= 2 * float(s["interval_hours"]) + 1
        out.append(_check("backups", "Encrypted backups of the platform are taken regularly", "pass" if ok else "fail",
                          (f"Last backup {last['at'][:16]} ({'with' if last.get('database') else 'without'} the database), every {s['interval_hours']} h, "
                           f"keeping {s['keep']} in {s['folder']}." if last else "Scheduled, but no backup has succeeded yet.")
                          + ("" if s["enabled"] else " The schedule is off."), "Backups", action))
    if ver:
        fresh = (_now() - (_parse(ver["at"]) or _now())).days <= 365
        out.append(_check("restore_test", "The backup and restore process was tested", "pass" if fresh else "warn",
                          f"Restore test {ver['at'][:10]}: {ver.get('files')} files, auth store intact"
                          + (f", {ver['database_objects']} database objects readable" if ver.get("database_objects") else "") + ".", "Backups", action))
    else:
        out.append(_attestation("restore_test"))
    return out


def _agents() -> list[dict]:
    out = []
    try:
        import dc_agents

        for item, rec in dc_agents._agents():
            seen = _parse(rec.get("last_seen"))
            made = _parse(rec.get("token_rotated_at") or rec.get("created_at"))
            out.append({"id": item["id"], "name": item["name"].removesuffix(".agent"), "host": rec.get("host"), "last_seen": rec.get("last_seen"),
                        "last_seen_days": (_now() - seen).days if seen else None, "token_age_days": (_now() - made).days if made else None})
    except Exception:  # noqa: BLE001
        pass
    return out


def _executables() -> list[dict]:
    try:
        import db

        rows = db.drive_query("trashed_at IS NULL AND kind = 'file' AND name ~* %s", (r"\.(exe|dll|msi|bat|cmd|ps1|vbs|scr|com|apk|dmg)$",), limit=500)
    except Exception:  # noqa: BLE001
        return []
    return [{"id": r["id"], "name": r["name"], "size": r.get("size_bytes")} for r in rows if EXECUTABLE.search(r["name"])]


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


def _summary(checks: list[dict]) -> dict:
    counts = {k: sum(1 for c in checks if c["status"] == k) for k in ("pass", "warn", "fail", "manual")}
    scored = [c for c in checks if c["status"] != "manual"]
    score = round(100 * sum(1 if c["status"] == "pass" else 0.5 if c["status"] == "warn" else 0 for c in scored) / max(1, len(scored)))
    return {"checks": checks, "counts": counts, "score": score, "at": _iso()}


@router.get("/enterprise")
def get_enterprise() -> dict:
    auth.require_admin()
    return _summary(enterprise())


@router.get("/infrastructure")
def get_infrastructure() -> dict:
    auth.require_admin()
    return _summary(infrastructure())


class AttestIn(BaseModel):
    status: str = Field(pattern="^(yes|partial|no)$")
    note: str = Field("", max_length=2000)
    evidence: Optional[str] = None  # a Files item


@router.put("/attestations/{aid}")
def attest(aid: str, req: AttestIn) -> dict:
    p = auth.require_admin()
    if aid not in ATTESTATIONS:
        raise HTTPException(404, "unknown control")
    if req.evidence:
        import drive

        drive._item(req.evidence)
    with _lock:
        s = _state()
        prev = s["attestations"].get(aid)
        s["attestations"][aid] = {"status": req.status, "note": req.note, "evidence": req.evidence, "by": p.get("username"), "at": _iso(),
                                  "history": ([{k: prev[k] for k in ("status", "by", "at", "note") if k in prev}] + (prev.get("history") or []))[:20] if prev else []}
        _save(s)
    audit3.emit("SECURITY_POSTURE_ATTEST", ["appConfigUpdate"], {"updatedAppConfigIds": [aid], "updateAppConfigDescription": f"{req.status}: {req.note[:200]}"},
                product="security-posture")
    return _attestation(aid)


class ReviewIn(BaseModel):
    note: str = Field("", max_length=2000)
    owner: Optional[str] = None


@router.put("/service-accounts/{uid}/review")
def review(uid: str, req: ReviewIn) -> dict:
    p = auth.require_admin()
    auth._user(uid)
    with _lock:
        s = _state()
        s["reviews"][uid] = {"at": _iso(), "by": p.get("username"), "note": req.note, "owner": req.owner}
        _save(s)
    audit3.emit("SECURITY_POSTURE_REVIEW", ["managementUsers"], {"managedUserIds": [uid]}, product="security-posture")
    return s["reviews"][uid]


class RevokeIn(BaseModel):
    token_ids: list[str] = Field(min_length=1)


@router.post("/tokens/revoke")
def revoke_tokens(req: RevokeIn) -> dict:
    """Revoke personal API tokens (stale or never-expiring ones, chosen by an administrator)."""
    auth.require_admin()
    with auth._lock, auth._db() as con:
        for t in req.token_ids:
            con.execute("DELETE FROM tokens WHERE id = ?", (t,))
    auth.audit("session_revoked", None, f"{len(req.token_ids)} API token(s) revoked from Enterprise security")
    return {"revoked": len(req.token_ids)}


class DisableIn(BaseModel):
    user_ids: list[str] = Field(min_length=1)


@router.post("/users/disable")
def disable_users(req: DisableIn) -> dict:
    """Deactivate accounts unused for a long time (administrators choose which)."""
    p = auth.require_admin()
    done = 0
    for uid in req.user_ids:
        if uid == p.get("id"):
            continue
        u = auth._user(uid)
        u["disabled"] = True
        auth._save_user(u)
        with auth._lock, auth._db() as con:
            con.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
        auth.audit("user_deactivated", u, "inactive for 30 days (Enterprise security)")
        done += 1
    return {"disabled": done}


class ContactIn(BaseModel):
    contact: str = Field(max_length=300)


@router.put("/contact")
def set_contact(req: ContactIn) -> dict:
    auth.require_admin()
    with _lock:
        s = _state()
        s["contact"] = req.contact.strip()
        _save(s)
    return {"contact": s["contact"]}


@router.get("/contact")
def get_contact() -> dict:
    """Who to report security concerns to (every user may see it)."""
    auth.require_user()
    return {"contact": _state()["contact"]}
