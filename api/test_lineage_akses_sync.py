"""Data Lineage → Permissions agrees with Keamanan & Akses and with what the platform enforces, on the running platform.

For every JKN demo account: each item the Keamanan & Akses matrix rates (GET /api/aip/akses) has the same colour in
Data Lineage (POST /api/lineage/permissions) — readable (view, or an empty dataset it may open) = blue, closed = red —
and, signed in as that account, a sample of the blue items opens and every red one in the sample is refused (datasets,
Nexus objects, portal rows).

No fakes: the real API, real accounts. Needs the API running (BLUESANDAI_E2E_API, default http://localhost:8000) and in
.env.local ADMIN_ACCESS_TOKEN (an administrator's API token: Account → API tokens) or BLUESANDAI_E2E_TOKEN; the
sign-in part also needs BLUESANDAI_DEMO_PASSWORD (the demo.* accounts' password), else it is skipped.
Run: python -m pytest test_lineage_akses_sync.py -v (from api/)."""
import random

import pytest
import requests

from mailer import env

API = env("BLUESANDAI_E2E_API", "http://localhost:8000").rstrip("/")
BLUE = {"view", "no_data"}


@pytest.fixture(scope="module")
def admin() -> requests.Session:
    try:
        requests.get(f"{API}/api/health", timeout=5)
    except requests.RequestException:
        pytest.skip(f"the API is not running at {API}")
    token = env("ADMIN_ACCESS_TOKEN") or env("BLUESANDAI_E2E_TOKEN")
    if not token:
        pytest.skip("ADMIN_ACCESS_TOKEN is not set in .env.local")
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {token}"
    if s.get(f"{API}/api/aip/akses", timeout=900).status_code != 200:
        pytest.skip("the admin token was refused")
    return s


@pytest.fixture(scope="module")
def matrix(admin: requests.Session) -> dict:
    m = admin.get(f"{API}/api/aip/akses", params={"segar": "true"}, timeout=900).json()
    if not m.get("peran"):
        pytest.skip("the access scheme is not built (POST /api/aip/akses/bangun)")
    return m


@pytest.fixture(scope="module")
def nodes(admin: requests.Session) -> dict:
    return {n["id"]: n for n in admin.get(f"{API}/api/lineage/graph", timeout=900).json()["nodes"]}


def _items(row: dict) -> dict:
    return {it["id"]: it for t in row["tahap"].values() for it in t["items"]}


def test_lineage_colours_match_the_access_matrix(admin: requests.Session, matrix: dict, nodes: dict) -> None:
    differ = []
    for row in matrix["peran"]:
        items = _items(row)
        body = [{"id": i, **{k: nodes[i].get(k) for k in ("kind", "item_id", "repo_id", "size", "missing")}} for i in items if i in nodes]
        got = admin.post(f"{API}/api/lineage/permissions", json={"user_id": row["id"], "type": "read", "nodes": body}, timeout=900).json()["nodes"]
        for i, it in items.items():
            lineage = got.get(i, {}).get("status")
            # blue or red only: the lineage never leaves a rated item gray for an administrator
            assert lineage in ("view", "no_access"), (row["username"], it["nama"], lineage)
            if (it["status"] in BLUE) != (lineage == "view"):
                differ.append((row["username"], it["nama"], it["status"], lineage))
    assert not differ, differ


def _opens(s: requests.Session, nid: str, n: dict) -> bool:
    kind, rid = nid.split(":", 1)
    if kind == "dataset":
        return s.get(f"{API}/api/pipeline/datasets/{n.get('item_id') or rid}/table", params={"limit": 1}, timeout=300).status_code == 200
    if kind == "object_type":
        r = s.get(f"{API}/api/ontology/object-types/{rid}/objects", params={"limit": 1}, timeout=300)
        return r.status_code == 200 and bool(r.json().get("objects") or r.json().get("data"))
    r = s.get(f"{API}/api/restricted-views/{rid}/rows", params={"limit": 1}, timeout=300)
    return r.status_code == 200 and bool(r.json().get("rows"))


def test_blue_opens_and_red_is_refused_signed_in_as_each_account(matrix: dict, nodes: dict) -> None:
    password = env("BLUESANDAI_DEMO_PASSWORD")
    if not password:
        pytest.skip("BLUESANDAI_DEMO_PASSWORD is not set")
    rng = random.Random(7)
    wrong = []
    for row in matrix["peran"]:
        s = requests.Session()
        assert s.post(f"{API}/api/auth/login", json={"username": row["username"], "password": password}, timeout=60).status_code == 200, row["username"]
        # files that can be read as a table (the Arsip Sumber stage is folders of .dta files), objects, portal rows
        items = [it for it in _items(row).values() if it["id"] in nodes and (it["id"].split(":", 1)[0] in ("object_type", "restricted_view")
                 or (it["id"].startswith("dataset:") and (nodes[it["id"]].get("path") or [""])[1:2] != ["raw"]))]
        blue = [it for it in items if it["status"] in BLUE]
        red = [it for it in items if it["status"] == "no_access"]
        for it in rng.sample(blue, min(4, len(blue))) + rng.sample(red, min(4, len(red))):
            if _opens(s, it["id"], nodes[it["id"]]) != (it["status"] in BLUE):
                wrong.append((row["username"], it["nama"], it["status"]))
    assert not wrong, wrong
