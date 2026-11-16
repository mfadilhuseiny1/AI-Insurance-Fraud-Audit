"""Single sign-on: OpenID Connect (Google, Microsoft Entra ID, Okta, any OIDC provider) and SAML 2.0.

Providers are configured in .env.local (see .env.example); one appears on the sign-in page when its keys are set:

  Google             BLUESANDAI_SSO_GOOGLE_CLIENT_ID, BLUESANDAI_SSO_GOOGLE_CLIENT_SECRET
  Microsoft Entra ID BLUESANDAI_SSO_MICROSOFT_CLIENT_ID, _CLIENT_SECRET, _TENANT (a tenant id or domain; "organizations"
                     for any work account)
  Okta               BLUESANDAI_SSO_OKTA_ISSUER (https://<org>.okta.com or …/oauth2/default), _CLIENT_ID, _CLIENT_SECRET
  Any OIDC provider  BLUESANDAI_SSO_OIDC_ISSUER, _CLIENT_ID, _CLIENT_SECRET, _NAME (the button's label)
  SAML 2.0           BLUESANDAI_SSO_SAML_IDP_SSO_URL, _IDP_ENTITY_ID, _IDP_CERT (PEM text or a file path), _NAME

The redirect (callback) URLs to register with the provider are {API}/api/auth/sso/<provider>/callback for OIDC and
{API}/api/auth/sso/saml/acs for SAML (SP metadata: {API}/api/auth/sso/saml/metadata), where {API} is
BLUESANDAI_API_PUBLIC_URL — the API's address as the browser reaches it (default http://localhost:8000).

OIDC: authorization code flow with PKCE, state and nonce; the ID token comes straight from the provider's token
endpoint over TLS and its RS256 / ES256 signature is checked against the provider's keys (JWKS), with issuer,
audience, expiry and nonce. SAML: the response or assertion must be signed by the IdP certificate (signxml), for our
entity id (audience) and ACS URL, within its validity window, answering our request.

Accounts: a sign-in matches the user it was linked to before (provider + subject), else the user with the same
verified email (an invited user accepts the invitation this way), else — with "Create accounts on first sign-in"
on (Control Panel → Security), for the allowed email domains — a new user with the default role. Two-factor of this
app is not asked after single sign-on: the identity provider handles it.

Signed SAML requests: AuthnRequests and logout messages are signed with the service provider's key (RSA-SHA256): in
the query string for the HTTP-Redirect binding (SAMLRequest, RelayState, SigAlg, as the SAML bindings spec says), as
an enveloped XML signature for HTTP-POST (BLUESANDAI_SSO_SAML_IDP_BINDING=post). The key and certificate are
BLUESANDAI_SSO_SAML_SP_KEY / _SP_CERT (PEM text or file paths), else generated once and kept in the sign-in store
(the key sealed with secretbox); the SP metadata lists the certificate. BLUESANDAI_SSO_SAML_SIGN_REQUESTS=0 leaves
AuthnRequests unsigned (logout messages are always signed).

Single logout: POST /api/auth/sso/logout ends this browser's session first, then answers where the browser goes next —
the IdP's SLO endpoint with a signed LogoutRequest (SAML, BLUESANDAI_SSO_SAML_IDP_SLO_URL) or the provider's
end_session_endpoint with id_token_hint (OIDC, when its discovery document lists one). /api/auth/sso/saml/slo takes
the IdP's LogoutResponse and IdP-initiated LogoutRequests (both bindings): a request must be signed by the IdP
certificate, from its entity id, recent, never seen before; it ends the sessions of that NameID (and SessionIndex)
and is answered with a signed LogoutResponse (to BLUESANDAI_SSO_SAML_IDP_SLO_RESPONSE_URL, default the SLO URL).
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import secrets
import threading
import time
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote_plus, unquote_plus, urlencode
from xml.sax.saxutils import escape as _x
from xml.sax.saxutils import quoteattr as _qa

import requests
from fastapi import Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

import auth
import auth_store
import mailer
import secretbox

OIDC = {
    "google": {"name": "Google", "issuer": lambda: "https://accounts.google.com", "prefix": "BLUESANDAI_SSO_GOOGLE"},
    "microsoft": {"name": "Microsoft", "issuer": lambda: f"https://login.microsoftonline.com/{mailer.env('BLUESANDAI_SSO_MICROSOFT_TENANT', 'organizations')}/v2.0",
                  "prefix": "BLUESANDAI_SSO_MICROSOFT"},
    "okta": {"name": "Okta", "issuer": lambda: mailer.env("BLUESANDAI_SSO_OKTA_ISSUER").rstrip("/"), "prefix": "BLUESANDAI_SSO_OKTA"},
    "oidc": {"name": None, "issuer": lambda: mailer.env("BLUESANDAI_SSO_OIDC_ISSUER").rstrip("/"), "prefix": "BLUESANDAI_SSO_OIDC"},
}
STATE_SECONDS = 600
_discovery: dict[str, tuple[float, dict]] = {}
_jwks: dict[str, tuple[float, dict]] = {}


def api_url() -> str:
    return (mailer.env("BLUESANDAI_API_PUBLIC_URL") or "http://localhost:8000").rstrip("/")


def _cfg(provider: str, key: str) -> str:
    return mailer.env(f"{OIDC[provider]['prefix']}_{key}")


def _oidc_ready(provider: str) -> bool:
    return bool(_cfg(provider, "CLIENT_ID") and _cfg(provider, "CLIENT_SECRET") and OIDC[provider]["issuer"]())


def _saml_ready() -> bool:
    return bool(mailer.env("BLUESANDAI_SSO_SAML_IDP_SSO_URL") and mailer.env("BLUESANDAI_SSO_SAML_IDP_CERT"))


def providers() -> list[dict]:
    """The single sign-on buttons: configured providers only."""
    out = []
    for pid, p in OIDC.items():
        if _oidc_ready(pid):
            out.append({"id": pid, "name": p["name"] or mailer.env("BLUESANDAI_SSO_OIDC_NAME") or "Company account", "kind": "oidc",
                        "start": f"{api_url()}/api/auth/sso/{pid}/start"})
    if _saml_ready():
        out.append({"id": "saml", "name": mailer.env("BLUESANDAI_SSO_SAML_NAME") or "Company account (SAML)", "kind": "saml",
                    "start": f"{api_url()}/api/auth/sso/saml/start"})
    return out


def _fail(message: str) -> RedirectResponse:
    return RedirectResponse(f"{auth.web_url()}/login?{urlencode({'sso_error': message})}", status_code=303)


def _safe_next(n: Optional[str]) -> str:
    return n if n and n.startswith("/") and not n.startswith("//") and not n.startswith("/login") else "/"


# -- state (one-time, short-lived; kept with the action tokens) --


def _save_state(record: dict) -> str:
    return auth._action_token("sso_state", "-", STATE_SECONDS, record, replace=False)


def _take_state(state: str) -> dict:
    with auth._lock, auth._db() as con:
        row = con.execute("SELECT kind, expires_at, record FROM action_tokens WHERE token_hash = ?", (auth._sha(state or ""),)).fetchone()
        con.execute("DELETE FROM action_tokens WHERE token_hash = ?", (auth._sha(state or ""),))
    if not row or row[0] != "sso_state" or row[1] < auth._iso():
        raise HTTPException(400, "The sign-in took too long or was already used: start again")
    return json.loads(row[2])


# -- accounts --


def _find_or_create(provider: str, subject: str, email: str, verified: bool, profile: dict) -> dict:
    users = auth._users()
    email_l = (email or "").strip().lower()
    u = next((x for x in users for i in x.get("identities") or [] if i.get("provider") == provider and i.get("subject") == subject), None)
    if not u and email_l and verified:
        u = next((x for x in users if (x.get("email") or "").lower() == email_l), None)
    st = auth.settings()
    if not u:
        if not st["sso_auto_create"]:
            raise HTTPException(403, f"There is no BluesandAI account for {email or subject}: ask an administrator to invite you")
        domains = st["sso_allowed_domains"]
        if not email_l or not verified:
            raise HTTPException(403, "Your identity provider did not share a verified email address")
        if domains and email_l.split("@")[-1] not in domains:
            raise HTTPException(403, f"Accounts from {email_l.split('@')[-1]} cannot sign in here")
        username = email_l
        if any(x["username"] == username for x in users):
            username = f"{email_l.split('@')[0]}-{uuid.uuid4().hex[:4]}"
        u = auth._new_user(username, None, st["sso_default_role"], profile.get("name") or "", first_name=profile.get("given_name") or "",
                           last_name=profile.get("family_name") or "", email=email, sso_only=True)
        auth.audit("user_created", u, f"on first sign-in with {provider}")
    if u.get("disabled"):
        raise HTTPException(403, "This account is deactivated: ask an administrator")
    ids = [i for i in u.get("identities") or [] if not (i.get("provider") == provider and i.get("subject") == subject)]
    u["identities"] = [*ids, {"provider": provider, "subject": subject, "email": email, "linked_at": auth._iso()}]
    if u.get("invited"):
        u.pop("invited", None)
        auth.audit("invitation_accepted", u, f"with {provider}")
    if email and not u.get("email"):
        u["email"] = email
    # identity provider attributes: the claims Control Panel → Security lists, as the provider says now
    claims = [str(c) for c in st.get("sso_attribute_claims") or []]
    if claims:
        raw = {**{str(k).lower(): v for k, v in (profile.get("attributes") or {}).items()}, **{str(k).lower(): v for k, v in profile.items() if k != "attributes"}}
        attrs = dict(u.get("attributes") or {})
        for c in claims:
            v = raw.get(c.lower())
            if v is None:
                attrs.pop(c, None)
            else:
                attrs[c] = ",".join(map(str, v)) if isinstance(v, list) else str(v)
        u["attributes"] = attrs
    auth._save_user(u)
    # groups bound to the identity provider's groups (realms) follow what it says now
    ext = profile.get("groups")
    if ext is None and isinstance(profile.get("roles"), list):
        ext = profile["roles"]
    auth.sync_realm_groups(u["id"], provider, ext if isinstance(ext, list) else None)
    return auth._user(u["id"])


def _finish(request: Request, provider: str, user: dict, next_path: str, sso: Optional[dict] = None) -> RedirectResponse:
    """Start the session; `sso` ({provider, subject, session_index, record}) is what single logout needs later."""
    resp = RedirectResponse(f"{auth.web_url()}{_safe_next(next_path)}", status_code=303)
    auth._start_session(resp, request, user, "full", "sso")
    if sso:
        _remember_session(resp, user, sso)
    auth.audit("sign_in", user, f"via {provider} (single sign-on)", request)
    return resp


# -- sessions started by single sign-on (for single logout), seen logout message ids, the SP signing key --

SSO_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS sso_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, "
    "session_index TEXT, created_at TEXT NOT NULL, record TEXT NOT NULL DEFAULT '{}')",
    "CREATE INDEX IF NOT EXISTS sso_sessions_subject ON sso_sessions (provider, subject)",
    "CREATE TABLE IF NOT EXISTS sso_seen_messages (id_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sso_sp_keys (provider TEXT PRIMARY KEY, key_sealed TEXT NOT NULL, cert_pem TEXT NOT NULL, created_at TEXT NOT NULL)",
)
_tables_for: Optional[tuple] = None
_tables_lock = threading.Lock()


def _store_id() -> tuple:
    return (auth_store.kind(), str(auth.DB_PATH))


def _tables() -> None:
    """Create this module's tables in the sign-in store (once per store and process)."""
    global _tables_for
    if _tables_for == _store_id():
        return
    with _tables_lock:
        if _tables_for != _store_id():
            with auth._db() as con:
                for stmt in SSO_SCHEMA:
                    con.execute(stmt)
            _tables_for = _store_id()


def _session_cookie(resp: Response) -> Optional[str]:
    """The session token _start_session just set on the response."""
    for k, v in resp.raw_headers:
        if k.lower() == b"set-cookie":
            jar: SimpleCookie = SimpleCookie()
            jar.load(v.decode("latin-1"))
            if auth.COOKIE in jar:
                return jar[auth.COOKIE].value
    return None


def _remember_session(resp: Response, user: dict, sso: dict) -> None:
    token = _session_cookie(resp)
    if not token:
        return
    _tables()
    with auth._lock, auth._db() as con:
        # rows of sessions that ended (sign-out, expiry, revoked) go
        con.execute("DELETE FROM sso_sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions)")
        con.execute("INSERT INTO sso_sessions (token_hash, user_id, provider, subject, session_index, created_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (auth._sha(token), user["id"], sso["provider"], sso["subject"], sso.get("session_index"), auth._iso(), json.dumps(sso.get("record") or {})))


def _end_sessions(token_hashes: list[str]) -> int:
    if not token_hashes:
        return 0
    n = 0
    with auth._lock, auth._db() as con:
        for h in token_hashes:
            n += con.execute("DELETE FROM sessions WHERE token_hash = ?", (h,)).rowcount or 0
            con.execute("DELETE FROM sso_sessions WHERE token_hash = ?", (h,))
    return n


def _seen(issuer: str, message_id: str, minutes: int = 30) -> bool:
    """Remember a logout message's ID; True when it was seen before (a replay)."""
    _tables()
    h = auth._sha(f"{issuer}\n{message_id}")
    with auth._lock, auth._db() as con:
        con.execute("DELETE FROM sso_seen_messages WHERE expires_at < ?", (auth._iso(),))
        cur = con.execute("INSERT INTO sso_seen_messages (id_hash, expires_at) VALUES (?, ?) ON CONFLICT (id_hash) DO NOTHING",
                          (h, auth._iso(auth._now() + timedelta(minutes=minutes))))
        return not cur.rowcount


# -- OpenID Connect --


def _discover(provider: str) -> dict:
    issuer = OIDC[provider]["issuer"]()
    hit = _discovery.get(issuer)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    r = requests.get(f"{issuer}/.well-known/openid-configuration", timeout=15)
    r.raise_for_status()
    doc = r.json()
    _discovery[issuer] = (time.time(), doc)
    return doc


def _b64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _verify_jwt(token: str, jwks_uri: str) -> dict:
    """Claims of an RS256 / ES256 JWT whose signature matches a key of the provider's JWKS."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils

    head_b64, body_b64, sig_b64 = token.split(".")
    header = json.loads(_b64(head_b64))
    signed, sig = f"{head_b64}.{body_b64}".encode(), _b64(sig_b64)

    def keys(refresh: bool) -> list[dict]:
        hit = _jwks.get(jwks_uri)
        if refresh or not hit or time.time() - hit[0] > 3600:
            r = requests.get(jwks_uri, timeout=15)
            r.raise_for_status()
            _jwks[jwks_uri] = (time.time(), r.json())
        return _jwks[jwks_uri][1].get("keys") or []

    for refresh in (False, True):
        for k in keys(refresh):
            if header.get("kid") and k.get("kid") != header.get("kid"):
                continue
            try:
                if header.get("alg") == "RS256" and k.get("kty") == "RSA":
                    pub = rsa.RSAPublicNumbers(int.from_bytes(_b64(k["e"]), "big"), int.from_bytes(_b64(k["n"]), "big")).public_key()
                    pub.verify(sig, signed, padding.PKCS1v15(), hashes.SHA256())
                elif header.get("alg") == "ES256" and k.get("kty") == "EC":
                    pub = ec.EllipticCurvePublicNumbers(int.from_bytes(_b64(k["x"]), "big"), int.from_bytes(_b64(k["y"]), "big"), ec.SECP256R1()).public_key()
                    pub.verify(utils.encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")), signed, ec.ECDSA(hashes.SHA256()))
                else:
                    continue
                return json.loads(_b64(body_b64))
            except Exception:  # noqa: BLE001 - try the next key
                continue
    raise HTTPException(401, f"The ID token's signature does not match the provider's keys (alg {header.get('alg')})")


@auth.router.get("/sso/{provider}/start")
def oidc_start(provider: str, next: str = "/") -> Response:  # noqa: A002 - the query parameter's name
    if provider == "saml":
        return saml_start(next)
    if provider not in OIDC or not _oidc_ready(provider):
        return _fail("This sign-in option is not configured")
    try:
        doc = _discover(provider)
    except Exception as e:  # noqa: BLE001
        return _fail(f"Cannot reach the identity provider: {e}")
    verifier = secrets.token_urlsafe(48)
    nonce = secrets.token_urlsafe(16)
    state = _save_state({"provider": provider, "next": _safe_next(next), "verifier": verifier, "nonce": nonce})
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    params = {"response_type": "code", "client_id": _cfg(provider, "CLIENT_ID"), "redirect_uri": f"{api_url()}/api/auth/sso/{provider}/callback",
              "scope": "openid email profile", "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256"}
    if provider in ("google", "microsoft"):
        params["prompt"] = "select_account"
    return RedirectResponse(f"{doc['authorization_endpoint']}?{urlencode(params)}", status_code=303)


def _check_claims(provider: str, claims: dict, nonce: str) -> None:
    issuer = OIDC[provider]["issuer"]()
    iss = claims.get("iss", "")
    multi_tenant = provider == "microsoft" and any(t in issuer + "/" for t in ("/organizations/", "/common/", "/consumers/"))
    if multi_tenant:
        ok_iss = iss.startswith("https://login.microsoftonline.com/") and iss.endswith("/v2.0")
    else:
        ok_iss = iss.rstrip("/") == issuer.rstrip("/") or (provider == "google" and iss == "accounts.google.com")
    aud = claims.get("aud")
    client = _cfg(provider, "CLIENT_ID")
    if not ok_iss:
        raise HTTPException(401, f"The ID token is from {iss}, not {issuer}")
    if client not in (aud if isinstance(aud, list) else [aud]):
        raise HTTPException(401, "The ID token is for another application")
    if int(claims.get("exp") or 0) < time.time() - 60:
        raise HTTPException(401, "The ID token has expired")
    if claims.get("nonce") != nonce:
        raise HTTPException(401, "The ID token does not answer this sign-in (nonce)")


@auth.router.get("/sso/{provider}/callback")
def oidc_callback(provider: str, request: Request, code: str = "", state: str = "", error: str = "", error_description: str = "") -> Response:
    if error:
        return _fail(error_description or error)
    if provider not in OIDC or not _oidc_ready(provider):
        return _fail("This sign-in option is not configured")
    try:
        st = _take_state(state)
        if st.get("provider") != provider:
            raise HTTPException(400, "The sign-in was started with another provider")
        doc = _discover(provider)
        r = requests.post(doc["token_endpoint"], data={"grant_type": "authorization_code", "code": code, "redirect_uri": f"{api_url()}/api/auth/sso/{provider}/callback",
                                                       "client_id": _cfg(provider, "CLIENT_ID"), "client_secret": _cfg(provider, "CLIENT_SECRET"),
                                                       "code_verifier": st["verifier"]}, headers={"accept": "application/json"}, timeout=20)
        if r.status_code != 200:
            raise HTTPException(401, f"The identity provider refused the sign-in: {r.text[:300]}")
        tokens = r.json()
        claims = _verify_jwt(tokens["id_token"], doc["jwks_uri"])
        _check_claims(provider, claims, st["nonce"])
        info = dict(claims)
        if doc.get("userinfo_endpoint") and tokens.get("access_token") and not info.get("email"):
            ui = requests.get(doc["userinfo_endpoint"], headers={"authorization": f"Bearer {tokens['access_token']}"}, timeout=15)
            if ui.ok and ui.json().get("sub") == claims.get("sub"):
                info.update({k: v for k, v in ui.json().items() if k not in info})
        email = info.get("email") or (info.get("preferred_username") if "@" in str(info.get("preferred_username") or "") else "") or ""
        # Microsoft work accounts carry the directory's address without email_verified
        verified = bool(info.get("email_verified")) or provider == "microsoft" or str(info.get("email_verified")).lower() == "true"
        user = _find_or_create(provider, str(claims["sub"]), email, verified, info)
        # the ID token is the id_token_hint of RP-initiated logout
        return _finish(request, OIDC[provider]["name"] or mailer.env("BLUESANDAI_SSO_OIDC_NAME") or provider, user, st.get("next") or "/",
                       {"provider": provider, "subject": str(claims["sub"]), "session_index": claims.get("sid"), "record": {"id_token": tokens["id_token"]}})
    except HTTPException as e:
        auth.audit("sign_in_failed", None, f"{provider}: {e.detail}", request)
        return _fail(str(e.detail))
    except Exception as e:  # noqa: BLE001
        auth.log.exception("single sign-on failed")
        auth.audit("sign_in_failed", None, f"{provider}: {e}", request)
        return _fail(f"Single sign-on failed: {e}")


# -- SAML 2.0 --

SAML_NS = {"samlp": "urn:oasis:names:tc:SAML:2.0:protocol", "saml": "urn:oasis:names:tc:SAML:2.0:assertion"}
EMAIL_ATTRS = ("email", "mail", "emailaddress", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3")
FIRST_ATTRS = ("givenname", "firstname", "first_name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname", "urn:oid:2.5.4.42")
LAST_ATTRS = ("surname", "sn", "lastname", "last_name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname", "urn:oid:2.5.4.4")
# attributes listing the user's groups in the identity provider (realms: auth.sync_realm_groups)
GROUP_ATTRS = ("groups", "group", "memberof", "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups", "http://schemas.xmlsoap.org/claims/group")
NAME_ATTRS = ("displayname", "name", "http://schemas.microsoft.com/identity/claims/displayname", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name")


def sp_entity_id() -> str:
    return mailer.env("BLUESANDAI_SSO_SAML_SP_ENTITY_ID") or f"{api_url()}/api/auth/sso/saml/metadata"


def acs_url() -> str:
    return f"{api_url()}/api/auth/sso/saml/acs"


def _idp_cert() -> str:
    v = mailer.env("BLUESANDAI_SSO_SAML_IDP_CERT")
    if v and "BEGIN CERTIFICATE" not in v and Path(v).is_file():
        v = Path(v).read_text("utf-8")
    v = v.replace("\\n", "\n")
    if "BEGIN CERTIFICATE" not in v:
        v = "-----BEGIN CERTIFICATE-----\n" + v.strip() + "\n-----END CERTIFICATE-----\n"
    return v


def slo_url() -> str:
    return f"{api_url()}/api/auth/sso/saml/slo"


BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
BINDING_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
DS_NS = "http://www.w3.org/2000/09/xmldsig#"
RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
# query-string signature algorithms accepted from the IdP (SHA-1 is refused)
SIG_ALGS = {"http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": ("rsa", "SHA256"), "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384": ("rsa", "SHA384"),
            "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": ("rsa", "SHA512"), "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256": ("ec", "SHA256"),
            "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384": ("ec", "SHA384"), "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512": ("ec", "SHA512")}
SKEW = timedelta(minutes=3)
# how old an IdP's logout message may be (its IssueInstant), on top of the clock skew
LOGOUT_MAX_AGE = timedelta(minutes=5)
MAX_MESSAGE_BYTES = 256 * 1024


def sign_requests() -> bool:
    return mailer.env("BLUESANDAI_SSO_SAML_SIGN_REQUESTS", "1").lower() not in ("0", "false", "no", "off")


def _binding() -> str:
    """How messages go to the IdP: HTTP-Redirect (default) or HTTP-POST."""
    return BINDING_POST if mailer.env("BLUESANDAI_SSO_SAML_IDP_BINDING").lower() in ("post", "http-post", BINDING_POST.lower()) else BINDING_REDIRECT


def _pem_setting(name: str) -> str:
    v = mailer.env(name)
    if v and "-----BEGIN" not in v and Path(v).is_file():
        v = Path(v).read_text("utf-8")
    return v.replace("\\n", "\n").strip()


_sp_cache: dict[tuple, tuple[str, str]] = {}


def _new_keypair() -> tuple[str, str]:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "BluesandAI SAML service provider")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True).sign(key, hashes.SHA256()))
    key_pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    return key_pem, cert.public_bytes(serialization.Encoding.PEM).decode()


def sp_keypair() -> tuple[str, str]:
    """(private key PEM, certificate PEM) the service provider signs with: BLUESANDAI_SSO_SAML_SP_KEY / _SP_CERT when
    set, else a pair generated once and kept in the sign-in store (shared by every API process)."""
    key, cert = _pem_setting("BLUESANDAI_SSO_SAML_SP_KEY"), _pem_setting("BLUESANDAI_SSO_SAML_SP_CERT")
    if key or cert:
        if not (key and cert):
            raise HTTPException(500, "Set both BLUESANDAI_SSO_SAML_SP_KEY and BLUESANDAI_SSO_SAML_SP_CERT (or neither, for a generated pair)")
        return key, cert
    hit = _sp_cache.get(_store_id())
    if hit:
        return hit
    _tables()
    with auth._lock:
        with auth._db() as con:
            row = con.execute("SELECT key_sealed, cert_pem FROM sso_sp_keys WHERE provider = ?", ("saml",)).fetchone()
        if row:
            k = secretbox.unseal(base64.b64decode(row[0])).get("key")
            if k:
                _sp_cache[_store_id()] = (k, row[1])
                return k, row[1]
            auth.log.warning("The SAML signing key cannot be decrypted (BLUESANDAI_SECRET_KEY changed?): a new pair is made; "
                             "give the identity provider the new SP metadata")
        k, c = _new_keypair()
        sealed = base64.b64encode(secretbox.seal({"key": k})).decode()
        with auth._db() as con:
            con.execute("DELETE FROM sso_sp_keys WHERE provider = ? AND key_sealed = ?", ("saml", row[0] if row else ""))
            con.execute("INSERT INTO sso_sp_keys (provider, key_sealed, cert_pem, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (provider) DO NOTHING",
                        ("saml", sealed, c, auth._iso()))
            row = con.execute("SELECT key_sealed, cert_pem FROM sso_sp_keys WHERE provider = ?", ("saml",)).fetchone()
        # another API process may have stored its pair first: everyone uses the stored one
        k = secretbox.unseal(base64.b64decode(row[0])).get("key") or k
        _sp_cache[_store_id()] = (k, row[1])
        return k, row[1]


def _cert_b64(pem: str) -> str:
    return "".join(line for line in pem.strip().splitlines() if "-----" not in line)


@auth.router.get("/sso/saml/metadata")
def saml_metadata() -> Response:
    """Service provider metadata to give the identity provider: the signing certificate, the ACS and SLO endpoints."""
    cert = _cert_b64(sp_keypair()[1])
    xml = (f'<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID={_qa(sp_entity_id())}>'
           f'<md:SPSSODescriptor AuthnRequestsSigned="{"true" if sign_requests() else "false"}" WantAssertionsSigned="true" '
           'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">'
           f'<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="{DS_NS}"><ds:X509Data><ds:X509Certificate>{cert}</ds:X509Certificate>'
           '</ds:X509Data></ds:KeyInfo></md:KeyDescriptor>'
           f'<md:SingleLogoutService Binding="{BINDING_REDIRECT}" Location={_qa(slo_url())}/>'
           f'<md:SingleLogoutService Binding="{BINDING_POST}" Location={_qa(slo_url())}/>'
           '<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>'
           f'<md:AssertionConsumerService Binding="{BINDING_POST}" Location={_qa(acs_url())} index="0" isDefault="true"/>'
           '</md:SPSSODescriptor></md:EntityDescriptor>')
    return Response(xml, media_type="application/samlmetadata+xml")


def _private_key() -> Any:
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    return load_pem_private_key(sp_keypair()[0].encode(), password=None)


def _sign_xml(xml: str, message_id: str) -> str:
    """An enveloped RSA-SHA256 signature (exclusive c14n) over the message, placed after its Issuer (HTTP-POST binding)."""
    from lxml import etree
    from signxml import SignatureMethod, XMLSigner

    root = etree.fromstring(xml.encode(), parser=etree.XMLParser(resolve_entities=False, no_network=True))
    issuer = root.find("saml:Issuer", SAML_NS)
    placeholder = etree.Element(f"{{{DS_NS}}}Signature", Id="placeholder", nsmap={"ds": DS_NS})
    issuer.addnext(placeholder)
    key, cert = sp_keypair()
    signed = XMLSigner(signature_algorithm=SignatureMethod.RSA_SHA256, digest_algorithm="sha256",
                       c14n_algorithm="http://www.w3.org/2001/10/xml-exc-c14n#").sign(
        root, key=key.encode(), cert=cert, reference_uri=f"#{message_id}", id_attribute="ID")
    return etree.tostring(signed).decode()


def _send(url: str, param: str, xml: str, message_id: str, relay: str = "", sign: bool = True) -> Response:
    """Send a SAML message (param SAMLRequest / SAMLResponse) to the IdP through the browser, signed unless `sign` is off."""
    if _binding() == BINDING_POST:
        body = _sign_xml(xml, message_id) if sign else xml
        fields = f'<input type="hidden" name="{param}" value="{html.escape(base64.b64encode(body.encode()).decode())}"/>'
        if relay:
            fields += f'<input type="hidden" name="RelayState" value="{html.escape(relay)}"/>'
        page = (f'<!doctype html><html><head><meta charset="utf-8"><title>Continuing…</title></head><body onload="document.forms[0].submit()">'
                f'<form method="post" action="{html.escape(url)}">{fields}<noscript><button type="submit">Continue</button></noscript></form></body></html>')
        return HTMLResponse(page, headers={"cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; form-action *"})
    return RedirectResponse(_redirect_url(url, param, xml, relay, sign), status_code=303)


def _redirect_url(url: str, param: str, xml: str, relay: str = "", sign: bool = True) -> str:
    """HTTP-Redirect binding: the DEFLATEd message in the query string; the signature covers SAMLRequest (or
    SAMLResponse), RelayState and SigAlg exactly as they appear in the URL (SAML bindings 3.4.4.1)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    deflated = zlib.compress(xml.encode())[2:-4]
    q = f"{param}={quote_plus(base64.b64encode(deflated).decode())}"
    if relay:
        q += f"&RelayState={quote_plus(relay)}"
    if sign:
        q += f"&SigAlg={quote_plus(RSA_SHA256)}"
        sig = _private_key().sign(q.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
        q += f"&Signature={quote_plus(base64.b64encode(sig).decode())}"
    return f"{url}{'&' if '?' in url else '?'}{q}"


def _instant() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def saml_start(next_path: str = "/") -> Response:
    if not _saml_ready():
        return _fail("SAML sign-in is not configured")
    request_id = "_" + uuid.uuid4().hex
    sso = mailer.env("BLUESANDAI_SSO_SAML_IDP_SSO_URL")
    xml = (f'<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{request_id}" '
           f'Version="2.0" IssueInstant="{_instant()}" Destination={_qa(sso)} '
           f'ProtocolBinding="{BINDING_POST}" AssertionConsumerServiceURL={_qa(acs_url())}>'
           f'<saml:Issuer>{_x(sp_entity_id())}</saml:Issuer><samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>'
           '</samlp:AuthnRequest>')
    relay = _save_state({"provider": "saml", "next": _safe_next(next_path), "request_id": request_id})
    try:
        return _send(sso, "SAMLRequest", xml, request_id, relay, sign=sign_requests())
    except HTTPException as e:
        return _fail(str(e.detail))


def _saml_time(v: Optional[str]) -> Optional[datetime]:
    if not v:
        return None
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


def parse_saml_response(saml_response: str, request_id: Optional[str]) -> dict:
    """Check a SAMLResponse (base64 XML) and return {subject, email, first, last, name}."""
    from lxml import etree
    from signxml import XMLVerifier

    raw = base64.b64decode(saml_response)
    root = etree.fromstring(raw, parser=etree.XMLParser(resolve_entities=False, no_network=True))
    status = root.find("samlp:Status/samlp:StatusCode", SAML_NS)
    if status is not None and not status.get("Value", "").endswith(":Success"):
        raise HTTPException(401, f"The identity provider refused the sign-in ({status.get('Value', '').rsplit(':', 1)[-1]})")
    try:
        verified = XMLVerifier().verify(raw, x509_cert=_idp_cert()).signed_xml
    except Exception as e:  # noqa: BLE001
        raise HTTPException(401, f"The SAML response is not signed by the configured identity provider: {e}") from None
    tag = etree.QName(verified).localname
    if tag == "Assertion":
        assertion = verified
    else:
        assertion = verified.find("saml:Assertion", SAML_NS)
        if assertion is None:
            raise HTTPException(401, "The signed SAML response holds no assertion")
    if root.get("InResponseTo") and request_id and root.get("InResponseTo") != request_id:
        raise HTTPException(401, "The SAML response does not answer this sign-in")
    issuer = assertion.findtext("saml:Issuer", namespaces=SAML_NS)
    want_issuer = mailer.env("BLUESANDAI_SSO_SAML_IDP_ENTITY_ID")
    if want_issuer and issuer != want_issuer:
        raise HTTPException(401, f"The assertion is from {issuer}, not {want_issuer}")
    now = datetime.now(timezone.utc)
    skew = timedelta(minutes=3)
    cond = assertion.find("saml:Conditions", SAML_NS)
    if cond is not None:
        nb, na = _saml_time(cond.get("NotBefore")), _saml_time(cond.get("NotOnOrAfter"))
        if (nb and now + skew < nb) or (na and now - skew >= na):
            raise HTTPException(401, "The SAML assertion is outside its validity window (check the server clocks)")
        audiences = [a.text for a in cond.findall("saml:AudienceRestriction/saml:Audience", SAML_NS)]
        if audiences and sp_entity_id() not in audiences:
            raise HTTPException(401, f"The SAML assertion is for {', '.join(a or '' for a in audiences)}, not {sp_entity_id()}")
    for scd in assertion.findall("saml:Subject/saml:SubjectConfirmation/saml:SubjectConfirmationData", SAML_NS):
        if scd.get("Recipient") and scd.get("Recipient") != acs_url():
            raise HTTPException(401, "The SAML assertion is for another address (Recipient)")
        if scd.get("InResponseTo") and request_id and scd.get("InResponseTo") != request_id:
            raise HTTPException(401, "The SAML assertion does not answer this sign-in")
        na = _saml_time(scd.get("NotOnOrAfter"))
        if na and now - skew >= na:
            raise HTTPException(401, "The SAML assertion has expired")
    name_id = assertion.find("saml:Subject/saml:NameID", SAML_NS)
    subject = (name_id.text or "").strip() if name_id is not None else ""
    attrs: dict[str, str] = {}
    every: dict[str, Any] = {}
    groups: Optional[list[str]] = None
    for a in assertion.findall("saml:AttributeStatement/saml:Attribute", SAML_NS):
        v = a.find("saml:AttributeValue", SAML_NS)
        if v is not None and v.text:
            attrs[(a.get("Name") or "").lower()] = v.text.strip()
        vals = [x.text.strip() for x in a.findall("saml:AttributeValue", SAML_NS) if x.text and x.text.strip()]
        if vals:
            every[a.get("Name") or ""] = vals if len(vals) > 1 else vals[0]
            if a.get("FriendlyName"):
                every[a.get("FriendlyName")] = every[a.get("Name") or ""]
        if (a.get("Name") or "").lower() in GROUP_ATTRS:
            groups = (groups or []) + [x.text.strip() for x in a.findall("saml:AttributeValue", SAML_NS) if x.text and x.text.strip()]
    pick = lambda names: next((attrs[n.lower()] for n in names if n.lower() in attrs), "")  # noqa: E731
    email = pick(EMAIL_ATTRS) or (subject if "@" in subject else "")
    if not subject:
        raise HTTPException(401, "The SAML assertion has no subject")
    # what a LogoutRequest names later: the NameID as the IdP qualified it, and the IdP's session
    name_id_attrs = {k: name_id.get(k) for k in ("Format", "NameQualifier", "SPNameQualifier") if name_id.get(k)}
    authn = assertion.find("saml:AuthnStatement", SAML_NS)
    session_index = authn.get("SessionIndex") if authn is not None else None
    return {"subject": subject, "email": email, "given_name": pick(FIRST_ATTRS), "family_name": pick(LAST_ATTRS), "name": pick(NAME_ATTRS), "groups": groups, "attributes": every,
            "name_id_attrs": name_id_attrs, "session_index": session_index}


@auth.router.post("/sso/saml/acs")
def saml_acs(request: Request, SAMLResponse: str = Form(...), RelayState: str = Form("")) -> Response:  # noqa: N803 - SAML's field names
    try:
        st = _take_state(RelayState) if RelayState else None
        if not st:
            raise HTTPException(400, "Start the sign-in from the BluesandAI sign-in page")
        info = parse_saml_response(SAMLResponse, st.get("request_id"))
        user = _find_or_create("saml", info["subject"], info["email"], True, info)
        return _finish(request, mailer.env("BLUESANDAI_SSO_SAML_NAME") or "SAML", user, st.get("next") or "/",
                       {"provider": "saml", "subject": info["subject"], "session_index": info.get("session_index"),
                        "record": {"name_id_attrs": info.get("name_id_attrs") or {}}})
    except HTTPException as e:
        auth.audit("sign_in_failed", None, f"saml: {e.detail}", request)
        return _fail(str(e.detail))
    except Exception as e:  # noqa: BLE001
        auth.log.exception("SAML sign-in failed")
        return _fail(f"SAML sign-in failed: {e}")


# -- single logout --


def _idp_slo_url() -> str:
    return mailer.env("BLUESANDAI_SSO_SAML_IDP_SLO_URL")


def _verify_redirect(query: str, param: str) -> tuple[bytes, dict[str, str]]:
    """The XML of a message sent with the HTTP-Redirect binding whose query-string signature matches the IdP
    certificate (checked over the parameters exactly as received), and the decoded parameters."""
    from cryptography import x509
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, padding

    raw: dict[str, str] = {}
    for piece in query.split("&"):
        if not piece:
            continue
        k, _, v = piece.partition("=")
        k = unquote_plus(k)
        if k in raw:
            raise HTTPException(400, f"The SAML message repeats {k}")
        raw[k] = v
    if param not in raw:
        raise HTTPException(400, f"The SAML message has no {param}")
    if not raw.get("Signature") or not raw.get("SigAlg"):
        raise HTTPException(401, "The SAML logout message is not signed")
    alg = SIG_ALGS.get(unquote_plus(raw["SigAlg"]))
    if not alg:
        raise HTTPException(401, f"The SAML message's signature algorithm is not accepted: {unquote_plus(raw['SigAlg'])}")
    signed = "&".join(f"{k}={raw[k]}" for k in (param, "RelayState", "SigAlg") if k in raw).encode("ascii", "replace")
    try:
        sig = base64.b64decode(unquote_plus(raw["Signature"]), validate=True)
        pub = x509.load_pem_x509_certificate(_idp_cert().encode()).public_key()
        digest = getattr(hashes, alg[1])()
        if alg[0] == "rsa":
            pub.verify(sig, signed, padding.PKCS1v15(), digest)
        else:
            pub.verify(sig, signed, ec.ECDSA(digest))
    except (InvalidSignature, ValueError, TypeError, AttributeError):
        raise HTTPException(401, "The SAML logout message's signature does not match the identity provider's certificate") from None
    try:
        d = zlib.decompressobj(-15)
        xml = d.decompress(base64.b64decode(unquote_plus(raw[param])), MAX_MESSAGE_BYTES)
        if d.unconsumed_tail:
            raise ValueError("too large")
    except (ValueError, zlib.error):
        raise HTTPException(400, "The SAML message cannot be read") from None
    return xml, {k: unquote_plus(v) for k, v in raw.items()}


def _verify_post(b64: str) -> bytes:
    """The signed element of a message sent with the HTTP-POST binding (enveloped XML signature by the IdP)."""
    from lxml import etree
    from signxml import XMLVerifier

    try:
        raw = base64.b64decode(b64)
    except ValueError:
        raise HTTPException(400, "The SAML message cannot be read") from None
    if len(raw) > MAX_MESSAGE_BYTES:
        raise HTTPException(400, "The SAML message is too large")
    root = etree.fromstring(raw, parser=etree.XMLParser(resolve_entities=False, no_network=True))
    if root.find(f"{{{DS_NS}}}Signature") is None:
        raise HTTPException(401, "The SAML logout message is not signed")
    try:
        verified = XMLVerifier().verify(raw, x509_cert=_idp_cert()).signed_xml
    except Exception as e:  # noqa: BLE001
        raise HTTPException(401, f"The SAML logout message is not signed by the configured identity provider: {e}") from None
    # the signature must cover the whole message, not an element inside it
    if etree.QName(verified).localname != etree.QName(root).localname or verified.get("ID") != root.get("ID"):
        raise HTTPException(401, "The SAML logout message's signature does not cover the message")
    return etree.tostring(verified)


def _logout_message(xml: bytes, want: str) -> Any:
    """Parse and check a verified LogoutRequest / LogoutResponse: its kind, issuer, destination, age and ID (replays)."""
    from lxml import etree

    root = etree.fromstring(xml, parser=etree.XMLParser(resolve_entities=False, no_network=True))
    if etree.QName(root).localname != want or etree.QName(root).namespace != SAML_NS["samlp"]:
        raise HTTPException(400, f"Expected a SAML {want}")
    issuer = (root.findtext("saml:Issuer", namespaces=SAML_NS) or "").strip()
    want_issuer = mailer.env("BLUESANDAI_SSO_SAML_IDP_ENTITY_ID")
    if want_issuer and issuer != want_issuer:
        raise HTTPException(401, f"The SAML {want} is from {issuer or 'an unnamed issuer'}, not {want_issuer}")
    if root.get("Destination") and root.get("Destination") != slo_url():
        raise HTTPException(401, f"The SAML {want} is for another address ({root.get('Destination')})")
    now = datetime.now(timezone.utc)
    try:
        issued = _saml_time(root.get("IssueInstant"))
        not_after = _saml_time(root.get("NotOnOrAfter"))
    except ValueError:
        raise HTTPException(400, f"The SAML {want} has an unreadable time") from None
    if not issued or issued > now + SKEW or issued < now - SKEW - LOGOUT_MAX_AGE:
        raise HTTPException(401, f"The SAML {want} has expired or is not valid yet (check the server clocks)")
    if not_after and now - SKEW >= not_after:
        raise HTTPException(401, f"The SAML {want} has expired")
    if not root.get("ID"):
        raise HTTPException(400, f"The SAML {want} has no ID")
    if _seen(issuer, root.get("ID")):
        raise HTTPException(401, f"The SAML {want} was already used (replay)")
    return root


def _logout_response_xml(in_response_to: str, status: str = "Success") -> tuple[str, str]:
    rid = "_" + uuid.uuid4().hex
    dest = mailer.env("BLUESANDAI_SSO_SAML_IDP_SLO_RESPONSE_URL") or _idp_slo_url()
    xml = (f'<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{rid}" '
           f'Version="2.0" IssueInstant="{_instant()}" Destination={_qa(dest)} InResponseTo={_qa(in_response_to)}>'
           f'<saml:Issuer>{_x(sp_entity_id())}</saml:Issuer>'
           f'<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:{status}"/></samlp:Status></samlp:LogoutResponse>')
    return xml, rid


def _idp_logout(request: Request, xml: bytes, relay: str) -> Response:
    """An IdP-initiated LogoutRequest (verified): end the sessions of its NameID (and SessionIndex), answer a LogoutResponse."""
    root = _logout_message(xml, "LogoutRequest")
    name_id = root.find("saml:NameID", SAML_NS)
    if name_id is None or not (name_id.text or "").strip():
        raise HTTPException(400, "The SAML LogoutRequest names no user (an encrypted NameID is not supported)")
    subject = name_id.text.strip()
    indexes = [(x.text or "").strip() for x in root.findall("samlp:SessionIndex", SAML_NS) if (x.text or "").strip()]
    _tables()
    with auth._db() as con:
        rows = con.execute("SELECT token_hash, user_id, session_index FROM sso_sessions WHERE provider = ? AND subject = ?", ("saml", subject)).fetchall()
    hit = [r for r in rows if not indexes or r[2] in indexes]
    n = _end_sessions([r[0] for r in hit])
    for uid in {r[1] for r in hit}:
        try:
            auth.audit("sign_out", auth._user(uid), f"single logout from the identity provider ({n} session{'' if n == 1 else 's'})", request)
        except HTTPException:
            pass
    if not hit:
        auth.audit("sign_out", None, f"single logout from the identity provider for {subject}: no session here", request, username=subject)
    out_xml, rid = _logout_response_xml(root.get("ID"))
    dest = mailer.env("BLUESANDAI_SSO_SAML_IDP_SLO_RESPONSE_URL") or _idp_slo_url()
    if not dest:
        resp: Response = JSONResponse({"signed_out": n})
    else:
        resp = _send(dest, "SAMLResponse", out_xml, rid, relay)
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


def _logout_answer(xml: bytes, relay: str) -> Response:
    """The IdP's LogoutResponse to our LogoutRequest (the session here ended already)."""
    root = _logout_message(xml, "LogoutResponse")
    st = _take_state(relay) if relay else None
    if not st or st.get("provider") != "saml_logout" or root.get("InResponseTo") != st.get("request_id"):
        raise HTTPException(401, "The SAML LogoutResponse does not answer a sign-out started here")
    code = root.find("samlp:Status/samlp:StatusCode", SAML_NS)
    if code is None or not code.get("Value", "").endswith(":Success"):
        return _fail(f"You are signed out of BluesandAI, but the identity provider did not end its session ({(code.get('Value', '') if code is not None else '').rsplit(':', 1)[-1]})")
    return RedirectResponse(f"{auth.web_url()}/login?{urlencode({'signed_out': '1'})}", status_code=303)


def _slo(request: Request, binding: str, saml_request: str, saml_response: str, relay: str) -> Response:
    param = "SAMLRequest" if saml_request else "SAMLResponse"
    try:
        if not _saml_ready():
            raise HTTPException(404, "SAML single sign-on is not configured")
        if not (saml_request or saml_response):
            raise HTTPException(400, "Expected a SAMLRequest or SAMLResponse")
        if binding == "redirect":
            xml, params = _verify_redirect(request.url.query, param)
            relay = params.get("RelayState", "")
        else:
            xml = _verify_post(saml_request or saml_response)
        return _idp_logout(request, xml, relay) if saml_request else _logout_answer(xml, relay)
    except HTTPException as e:
        auth.audit("sign_out_failed", None, f"saml {param}: {e.detail}", request)
        if saml_response:
            return _fail(str(e.detail))
        return JSONResponse({"detail": e.detail}, status_code=e.status_code)
    except Exception as e:  # noqa: BLE001
        auth.log.exception("SAML single logout failed")
        auth.audit("sign_out_failed", None, f"saml {param}: {e}", request)
        return JSONResponse({"detail": "The SAML logout message cannot be read"}, status_code=400)


@auth.router.get("/sso/saml/slo")
def saml_slo_redirect(request: Request, SAMLRequest: str = "", SAMLResponse: str = "", RelayState: str = "") -> Response:  # noqa: N803
    """Single logout, HTTP-Redirect binding: the IdP's LogoutRequest (IdP-initiated) or LogoutResponse."""
    return _slo(request, "redirect", SAMLRequest, SAMLResponse, RelayState)


@auth.router.post("/sso/saml/slo")
def saml_slo_post(request: Request, SAMLRequest: str = Form(""), SAMLResponse: str = Form(""), RelayState: str = Form("")) -> Response:  # noqa: N803
    """Single logout, HTTP-POST binding."""
    return _slo(request, "post", SAMLRequest, SAMLResponse, RelayState)


def _saml_logout_request(row: tuple) -> Optional[str]:
    """Where the browser goes to end the IdP session of a SAML session (a signed LogoutRequest); None without an SLO URL."""
    url = _idp_slo_url()
    if not url:
        return None
    _, _, subject, session_index, record = row
    attrs = (json.loads(record or "{}").get("name_id_attrs")) or {}
    rid = "_" + uuid.uuid4().hex
    name_attrs = "".join(f" {k}={_qa(v)}" for k, v in attrs.items() if k in ("Format", "NameQualifier", "SPNameQualifier"))
    xml = (f'<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{rid}" '
           f'Version="2.0" IssueInstant="{_instant()}" Destination={_qa(url)} '
           f'NotOnOrAfter="{(datetime.now(timezone.utc) + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")}">'
           f'<saml:Issuer>{_x(sp_entity_id())}</saml:Issuer><saml:NameID{name_attrs}>{_x(subject)}</saml:NameID>'
           + (f'<samlp:SessionIndex>{_x(session_index)}</samlp:SessionIndex>' if session_index else "")
           + '</samlp:LogoutRequest>')
    relay = _save_state({"provider": "saml_logout", "request_id": rid})
    if _binding() == BINDING_POST:
        # the browser fetches the auto-submitting form from us (the state token is the one-time key)
        page = _action_state({"kind": "saml_post", "url": url, "xml": _sign_xml(xml, rid), "relay": relay})
        return f"{api_url()}/api/auth/sso/saml/post/{page}"
    return _redirect_url(url, "SAMLRequest", xml, relay)


def _action_state(record: dict) -> str:
    return auth._action_token("sso_post", "-", 120, record, replace=False)


@auth.router.get("/sso/saml/post/{token}")
def saml_post_page(token: str) -> Response:
    """The auto-submitting form of a signed message for the HTTP-POST binding (one use, two minutes)."""
    with auth._lock, auth._db() as con:
        row = con.execute("SELECT kind, expires_at, record FROM action_tokens WHERE token_hash = ?", (auth._sha(token),)).fetchone()
        con.execute("DELETE FROM action_tokens WHERE token_hash = ?", (auth._sha(token),))
    if not row or row[0] != "sso_post" or row[1] < auth._iso():
        return _fail("The sign-out link expired: you are signed out of BluesandAI")
    rec = json.loads(row[2])
    fields = (f'<input type="hidden" name="SAMLRequest" value="{html.escape(base64.b64encode(rec["xml"].encode()).decode())}"/>'
              f'<input type="hidden" name="RelayState" value="{html.escape(rec["relay"])}"/>')
    page = (f'<!doctype html><html><head><meta charset="utf-8"><title>Signing out…</title></head><body onload="document.forms[0].submit()">'
            f'<form method="post" action="{html.escape(rec["url"])}">{fields}<noscript><button type="submit">Continue</button></noscript></form></body></html>')
    return HTMLResponse(page, headers={"cache-control": "no-store"})


def _oidc_logout(row: tuple) -> Optional[str]:
    """The provider's end_session_endpoint with id_token_hint (RP-initiated logout), when its discovery lists one."""
    provider = row[1]
    if provider not in OIDC or not _oidc_ready(provider):
        return None
    try:
        doc = _discover(provider)
    except Exception:  # noqa: BLE001 - the session here has ended anyway
        auth.log.warning("cannot reach %s for single logout", provider)
        return None
    end = doc.get("end_session_endpoint")
    if not end:
        return None
    params = {"client_id": _cfg(provider, "CLIENT_ID"),
              "post_logout_redirect_uri": mailer.env("BLUESANDAI_SSO_POST_LOGOUT_URL") or f"{auth.web_url()}/login"}
    id_token = json.loads(row[4] or "{}").get("id_token")
    if id_token:
        params = {"id_token_hint": id_token, **params}
    return f"{end}{'&' if '?' in end else '?'}{urlencode(params)}"


@auth.router.post("/sso/logout")
def sso_logout(request: Request) -> Response:
    """Sign out here and at the identity provider: this browser's session ends first, then {"redirect": url} says where
    the browser goes to end the provider's session (null when the session was not a single sign-on one, or the
    provider has no logout endpoint)."""
    cookie = request.cookies.get(auth.COOKIE)
    redirect: Optional[str] = None
    if cookie:
        h = auth._sha(cookie)
        _tables()
        with auth._db() as con:
            row = con.execute("SELECT token_hash, provider, subject, session_index, record FROM sso_sessions WHERE token_hash = ?", (h,)).fetchone()
            urow = con.execute("SELECT user_id FROM sessions WHERE token_hash = ?", (h,)).fetchone()
        ended = _end_sessions([h])
        if urow and ended:
            try:
                auth.audit("sign_out", auth._user(urow[0]), "with single logout" if row else "", request)
            except HTTPException:
                pass
        # only a live session may start the provider's logout (a stale cookie must not replay it)
        if row and ended:
            try:
                redirect = _saml_logout_request(row) if row[1] == "saml" else _oidc_logout(row)
            except Exception:  # noqa: BLE001 - the session here has ended anyway
                auth.log.exception("single logout request failed")
    resp = JSONResponse({"signed_out": True, "redirect": redirect})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp
