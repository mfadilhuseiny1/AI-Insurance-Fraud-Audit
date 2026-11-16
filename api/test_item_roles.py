"""Role grants on folders and files (auth.granted_operations): a role granted on a folder of a Project adds to the
Project's roles for everything inside it, never takes access away, and leaves markings and an application's Project
scope in force. The stages of the BPJS data are folders of one Project; "Keamanan & Akses" (aip/akses.py) grants Siap
Analisis to the national team this way.

Real stores: the Files tree in PostgreSQL (BLUESANDAI_DATABASE_URL; a "(test)" Project removed afterwards) and the
sign-in store in a temporary SQLite file.

    python -m pytest test_item_roles.py -q
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # the vendored `unstructured` (as server.py does)
os.environ["BLUESANDAI_AUTH_STORE"] = "sqlite"
os.environ.setdefault("BLUESANDAI_AUTH", "on")

from fastapi import HTTPException  # noqa: E402

import auth  # noqa: E402
import db  # noqa: E402
import mailer  # noqa: E402

URL = os.environ.get("BLUESANDAI_DATABASE_URL") or mailer.env("BLUESANDAI_DATABASE_URL")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@unittest.skipUnless(URL, "needs BLUESANDAI_DATABASE_URL (the Files tree)")
class ItemRoles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        auth.configure(Path(cls.tmp.name))
        db.init(URL)
        tag = uuid.uuid4().hex[:8]
        cls.ids = {k: f"t{tag}{k}" for k in ("project", "gold", "raw", "klaim", "arsip")}
        rows = [("project", None, "project", f"Akses folder (test {tag})"), ("gold", "project", "folder", "gold"), ("raw", "project", "folder", "raw"),
                ("klaim", "gold", "file", "klaim.parquet"), ("arsip", "raw", "file", "arsip.dta")]
        for k, parent, kind, name in rows:
            db.drive_insert({"id": cls.ids[k], "parent_id": cls.ids[parent] if parent else None, "kind": kind, "name": name, "size_bytes": 10 if kind == "file" else 0,
                             "content_type": None, "stored_in": None, "created_at": _now(), "updated_at": _now(), "created_by": "u-owner"})
        with auth._db() as con:
            con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, 'user', 'u-owner', 'owner')", (cls.ids["project"],))
            con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, 'group', 'g-tim', 'discoverer')", (cls.ids["project"],))
            con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, 'user', 'u-penuh', 'viewer')", (cls.ids["project"],))
            con.execute("INSERT INTO groups (id, record) VALUES ('g-tim', ?)", ('{"id": "g-tim", "name": "Tim akses (test)", "members": []}',))
        auth._roles_cache.clear()
        auth._project_cache.clear()

    @classmethod
    def tearDownClass(cls):
        db.drive_delete(cls.ids["project"], _now())
        cls.tmp.cleanup()

    def setUp(self):
        with auth._db() as con:
            con.execute("DELETE FROM item_roles")
            con.execute("DELETE FROM item_markings")
        auth._grants_reset()
        auth._cache.clear()
        auth._file_cache.clear()

    def p(self, uid: str = "u-tim", groups: tuple = ("g-tim",), **kw) -> dict:
        return {"id": uid, "username": uid, "role": "user", "groups": list(groups), "markings": [], "service": False, **kw}

    def grant(self, key: str, t: str, who: str, role: str) -> None:
        with auth._db() as con:
            con.execute("INSERT INTO item_roles (item_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)", (self.ids[key], t, who, role))
        auth._grants_reset()

    def test_a_discoverer_reads_nothing_until_a_folder_is_granted(self):
        p = self.p()
        self.assertFalse(auth.has_operation(self.ids["klaim"], "read", p))
        self.assertTrue(auth.has_operation(self.ids["klaim"], "discover", p))
        self.grant("gold", "group", "g-tim", "viewer")
        self.assertTrue(auth.has_operation(self.ids["klaim"], "read", p))  # inside the granted folder
        self.assertTrue(auth.has_operation(self.ids["gold"], "read", p))
        self.assertFalse(auth.has_operation(self.ids["arsip"], "read", p))  # another stage stays closed
        self.assertFalse(auth.has_operation(self.ids["project"], "read", p))  # the Project itself too
        self.assertFalse(auth.has_operation(self.ids["klaim"], "edit", p))

    def test_a_file_grant_opens_that_file_only(self):
        p = self.p("u-dewi", ())
        self.grant("arsip", "user", "u-dewi", "viewer")
        self.assertTrue(auth.has_operation(self.ids["arsip"], "read", p))
        self.assertFalse(auth.has_operation(self.ids["raw"], "read", p))
        self.assertFalse(auth.has_operation(self.ids["klaim"], "read", p))

    def test_check_item_follows_the_grant(self):
        p = self.p()
        self.grant("gold", "group", "g-tim", "viewer")
        token = auth._principal.set(p)
        try:
            auth.check_item({"id": self.ids["klaim"]})
            with self.assertRaises(HTTPException) as e:
                auth.check_item({"id": self.ids["arsip"]})
            self.assertEqual(e.exception.status_code, 403)
        finally:
            auth._principal.reset(token)

    def test_a_grant_never_takes_access_away(self):
        self.grant("gold", "group", "g-tim", "discoverer")
        full = self.p("u-penuh", ("g-tim",))
        self.assertTrue(auth.has_operation(self.ids["klaim"], "read", full))  # the Project's Viewer role still holds

    def test_markings_and_app_scope_still_bind(self):
        self.grant("gold", "group", "g-tim", "viewer")
        auth._set_item(self.ids["klaim"], own=["mk-rahasia"])
        auth._cache.clear()
        self.assertFalse(auth.has_operation(self.ids["klaim"], "read", self.p()))
        self.assertTrue(auth.has_operation(self.ids["klaim"], "read", self.p(markings=["mk-rahasia"])))
        self.assertFalse(auth.has_operation(self.ids["klaim"], "read", self.p(markings=["mk-rahasia"], project_scope=["another-project"])))

    def test_lineage_names_the_grant(self):
        import lineage

        self.grant("gold", "group", "g-tim", "viewer")
        status, why = lineage.access_of(f"dataset:{self.ids['klaim']}", {"kind": "dataset", "item_id": self.ids["klaim"], "size": 10}, self.p(), "read")
        self.assertEqual((status, why), ("view", "Viewer on gold"))
        status, why = lineage.access_of(f"dataset:{self.ids['arsip']}", {"kind": "dataset", "item_id": self.ids["arsip"], "size": 10}, self.p(), "read")
        self.assertEqual(status, "no_access")

    def test_owners_grant_on_folders_not_on_the_project(self):
        owner = self.p("u-owner", ())
        token = auth._principal.set(owner)
        try:
            view = auth.set_item_roles(self.ids["gold"], auth.RolesIn(roles=[auth.RoleIn(principal_type="group", principal_id="g-tim", role="viewer")]), None)
            self.assertEqual([(r["principal_id"], r["role"]) for r in view["roles"]], [("g-tim", "viewer")])
            below = auth._item_roles_view(self.ids["klaim"])
            self.assertEqual([(r["item"], r["role"]) for r in below["from_folders"]], [("gold", "viewer")])
            with self.assertRaises(HTTPException):
                auth.set_item_roles(self.ids["project"], auth.RolesIn(roles=[]), None)
        finally:
            auth._principal.reset(token)
        token = auth._principal.set(self.p())  # a Discoverer cannot grant
        try:
            with self.assertRaises(HTTPException) as e:
                auth.set_item_roles(self.ids["gold"], auth.RolesIn(roles=[]), None)
            self.assertEqual(e.exception.status_code, 403)
        finally:
            auth._principal.reset(token)


if __name__ == "__main__":
    unittest.main()
