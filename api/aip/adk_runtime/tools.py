"""The tools of the AIP agents, built per run and per agent.

A domain agent's object tools reach only the object types of its group: asked about another agent's type, a tool
answers which agent owns it (the orchestrator delegates by object). Every call leaves a receipt event (arguments,
the API call made, row count, time, the app it can be opened in), so each step can be checked in the UI, and every
table result is kept as a run result (`hasil_id`) the dynamic UI binds to — the model sees a few rows, never the table.
Agents never change data: `usulkan_action` records a proposal a person decides on (the Nexus action runs as that person).
"""

from __future__ import annotations

import contextvars
import json
import re
import threading
import time
from typing import Any, Callable, Optional

from aip import semantik as S
from aip.adk_runtime.platform import Platform, emit

MAX_CALLS = 10  # tool calls per agent per run: room for a senior analysis (rank, share, comparison), still a hard stop
ROWS_FOR_MODEL = 5
ROWS_KEPT = 500
PROPS_FOR_MODEL = 14  # an object as the model reads it (_brief): measures and the kind of indication first
CLAIMS_TYPE = "Klaim Berisiko (BPJS)"  # the rule-screened claims (aip/semantik.py T_KLAIM): estimasi_kerugian_klaim reads them
# the agent whose tool is running, per call: many agents' tools run at once in the consultancy (threads and tasks)
_CURRENT: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("aip_tool_agent", default=None)


class Toolbox:
    """The run's shared state for tools: the platform, the agent catalogue, results and counters."""

    def __init__(self, platform: Platform, catalogue: dict):
        self.p = platform
        self.agents = {a["key"]: a for a in catalogue["agents"]}
        self.types = {t["id"]: (t, a["key"]) for a in catalogue["agents"] for t in a["object_types"]}
        self.n_results = 0
        self.index: list[dict] = []  # {rid, title, columns, total}: what the UI composer may bind to
        self.calls: dict[str, int] = {}
        self.limits: dict[str, int] = {}  # tool calls an agent may make, when not MAX_CALLS (the consultancy's analysts)
        self.owner_of: dict[str, str] = {}  # a small agent → the domain agent whose objects (and permissions) it works with
        self._rid_lock = threading.Lock()
        self.receipts: dict[str, list[dict]] = {}
        self.seen: dict[str, list[dict]] = {}  # what each agent's tools answered it (a validator's evidence)
        self._functions: Optional[list[dict]] = None
        self._labels: dict[str, dict[str, str]] = {}
        self.rows: dict[str, list[dict]] = {}  # every result's rows, for the screen (adk_runtime/screens.py)
        self.pasted: dict[str, str] = {}  # a claim pasted into the question → the hasil_id of its /verify answer (it is not in the data)
        self.quoted = ""  # what the consultancy wrote that a chat answer may repeat as its finding (the audit pack): its figures count as read
        # Blu 3.0's reading scope (aip/blu3.py lingkup, set by adk_runtime/firm.py): {"tipe": the type holding every claim, "boleh":
        # the claim ids an agent may read row by row (Klaim Berisiko and the control sample), "kontrol": the control sample's ids}
        self.lingkup: Optional[dict] = None
        self._agent: Optional[str] = None  # the agent whose tool is running
        # set by the runtime (main.py): run a nested agent stage, and a model for a sub-agent
        self.spawn: Optional[Callable[..., Any]] = None
        self.llm: Optional[Callable[..., Any]] = None

    # -------------------------------------------------------------------------------------------- helpers

    def type_of(self, agent: str, name: str, any_owner: bool = False) -> dict:
        agent = self.owner_of.get(agent, agent)
        want = (name or "").strip().lower().replace(" (bpjs)", "")
        # the same words in another order or spelled out ("Faskes Profil", "Fasilitas Kesehatan" for Profil Faskes)
        words = lambda s: frozenset(re.sub(r"fasilitas kesehatan", "faskes", re.sub(r"[()/_]", " ", s.lower().replace("(bpjs)", ""))).split())  # noqa: E731
        for match in (lambda t, tid: want in (t["name"].lower().replace(" (bpjs)", ""), (t.get("api_name") or "").lower(), tid.lower()),
                      lambda t, tid: words(t["name"]) == words(want) or words(want) == {"faskes"} and words(t["name"]) == {"profil", "faskes"}):
            for tid, (t, owner) in self.types.items():
                if match(t, tid):
                    if owner != agent and not any_owner:
                        raise PermissionError(f"tipe '{t['name']}' milik {self.agents[owner]['name']}: minta orkestrator mendelegasikan ke agen itu")
                    return t
        mine = [t["name"] for t, owner in self.types.values() if owner == agent or any_owner]
        raise LookupError(f"tipe objek '{name}' tidak dikenal; tipe yang bisa dipakai: {', '.join(mine)}")

    def result(self, title: str, rows: list[dict], object_type: Optional[dict] = None, types: Optional[dict[str, str]] = None,
               meta: Optional[dict] = None) -> str:
        with self._rid_lock:
            self.n_results += 1
            rid = f"r{self.n_results}"
        cols: list[str] = []
        for r in rows[:50]:
            for k in r:
                if k not in cols:
                    cols.append(k)
        # each column's type, so the screen formats a code (kabkota_kode 3213) as a code, not as the number 3.213
        known = {p["api_name"]: p["type"] for p in (object_type or {}).get("properties") or []}
        col_types = {c: (types or {}).get(c) or known.get(c) or ("string" if c in ("_kunci", "_judul") else None) for c in cols}
        emit({"type": "result", "rid": rid, "title": title, "columns": cols, "rows": rows[:ROWS_KEPT], "total": len(rows),
              "types": {c: t for c, t in col_types.items() if t}, "object_type": {"id": object_type["id"], "name": object_type["name"]} if object_type else None,
              # what a ranking groups by: the page drills a row into the audit pack of that narrower scope
              **({"kelompok": meta["group"]} if (meta or {}).get("group") else {})})
        self.index.append({"rid": rid, "title": title, "columns": cols, "total": len(rows), "sample": rows[:3],
                           "meta": {**(meta or {"kind": "other"}), "agent": _CURRENT.get() or self._agent},
                           "types": {c: t for c, t in col_types.items() if t}, "object_type": (object_type or {}).get("name")})
        self.rows[rid] = rows[:ROWS_KEPT]
        return rid

    # ------------------------------------------------------------------------------- names for keys

    def key_type(self, prop: str) -> Optional[dict]:
        """The catalogue type whose primary key is `prop` and whose title is a name, not the key again."""
        return next((t for t, _ in self.types.values() if t["primary_key"] == prop and t.get("title") not in (None, "", t["primary_key"])), None)

    def labels(self, prop: str, keys: list) -> dict[str, str]:
        """Names for keys of `prop` (faskes_profil_id → "FKRTL · Klinik Utama · Swasta · SUBANG"): the titles of the
        objects they identify, one search as the user (who may only see some of them). Auditors read names, not hashes."""
        t = self.key_type(prop)
        keys = [k for k in dict.fromkeys(keys) if k not in (None, "")][:200]
        if not t or not keys:
            return {}
        cache = self._labels.setdefault(prop, {})
        need = [k for k in keys if str(k) not in cache]
        if need:
            try:
                r = self.p.post("/api/ontology/explorer/search", {"object_type_id": t["id"], "filters": [{"property": prop, "op": "in", "value": need}],
                                                                  "limit": len(need), "histograms": False, "resource": "aip"})
                for o in r.get("objects") or []:
                    cache[str(o.get("primary_key"))] = str(o.get("title") or "")
            except Exception:  # noqa: BLE001 - names are a help, never a failure
                pass
            for k in need:
                cache.setdefault(str(k), "")
        return {str(k): cache[str(k)] for k in keys if cache.get(str(k))}

    def geo(self, prop: str, keys: list) -> dict[str, str]:
        """Where each key of `prop` is ("lat,lon"), when a catalogue type keyed or titled by `prop` has a lokasi
        (provinsi → its capital): a ranking by region can then be drawn on the map."""
        t = next((t for t, _ in self.types.values() if prop in (t["primary_key"], t.get("title"))
                  and any(p["api_name"] == "lokasi" for p in t.get("properties") or [])), None)
        keys = [k for k in dict.fromkeys(keys) if k not in (None, "")][:200]
        if not t or not keys:
            return {}
        try:
            r = self.p.post("/api/ontology/explorer/search", {"object_type_id": t["id"], "filters": [{"property": prop, "op": "in", "value": keys}],
                                                              "limit": len(keys), "histograms": False, "resource": "aip"})
        except Exception:  # noqa: BLE001 - a map is a help, never a failure
            return {}
        out = {}
        for o in r.get("objects") or []:
            props = o.get("properties") or {}
            loc = props.get("lokasi")
            if isinstance(loc, dict):
                loc = f"{loc.get('lat')},{loc.get('lon')}"
            if loc and props.get(prop) is not None:
                out[str(props[prop])] = str(loc)
        return out

    def name_columns(self, t: dict, rows: list[dict]) -> dict[str, str]:
        """Adds, to rows of type `t`, the name of each object a key column points to (a column per key, named after the
        target's title property); returns {new column: key column}."""
        added: dict[str, str] = {}
        for p in t.get("properties") or []:
            prop = p["api_name"]
            target = self.key_type(prop)
            if not target or target is t or not any(prop in r for r in rows):
                continue
            col = target["title"] if not any(target["title"] in r for r in rows) else f"{prop}__nama"
            names = self.labels(prop, [r.get(prop) for r in rows])
            if names:
                for r in rows:
                    if str(r.get(prop)) in names:
                        r[col] = names[str(r.get(prop))]
                added[col] = prop
        return added

    def wrap(self, agent: str, name: str, fn: Callable[..., dict], counted: bool = True) -> Callable[..., dict]:
        """The tool the agent calls: counted, timed, its receipt emitted, its errors returned (the model can try another way).
        A final tool (a verdict, a recommendation) is not counted: the reading budget never blocks the conclusion."""
        def call(**kwargs: Any) -> dict:
            n = self.calls.get(agent, 0) + counted
            self.calls[agent] = n
            limit = self.limits.get(agent, MAX_CALLS)
            if counted and n > limit:
                return {"error": f"batas {limit} langkah tercapai: simpulkan sekarang dari hasil yang sudah ada"}
            t0 = time.time()
            self._agent = agent
            token = _CURRENT.set(agent)
            ok, res, receipt = True, {}, {}
            try:
                res, receipt = fn(**kwargs)
            except Exception as e:  # noqa: BLE001 - the agent sees the failure
                ok, res = False, {"error": str(e)[:400]}
            finally:
                _CURRENT.reset(token)
            ev = {"type": "tool", "agent": agent, "tool": name, "args": kwargs, "ok": ok, "ms": int((time.time() - t0) * 1000),
                  "summary": res.get("ringkasan") or res.get("error") or "", **receipt}
            self.receipts.setdefault(agent, []).append(ev)
            self.seen.setdefault(agent, []).append({"tool": name, "args": kwargs, "result": res})
            emit(ev)
            return res
        call.__name__ = name
        call.__doc__ = fn.__doc__
        call.__annotations__ = dict(fn.__annotations__)
        import inspect

        call.__signature__ = inspect.signature(fn)  # type: ignore[attr-defined]
        return call

    def wrap_async(self, agent: str, name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
        """wrap() for a coroutine tool (sub-agents and long jobs: the event loop keeps the other agents running)."""
        async def call(**kwargs: Any) -> dict:
            n = self.calls.get(agent, 0) + 1
            self.calls[agent] = n
            limit = self.limits.get(agent, MAX_CALLS)
            if n > limit:
                return {"error": f"batas {limit} langkah tercapai: simpulkan sekarang dari hasil yang sudah ada"}
            t0 = time.time()
            token = _CURRENT.set(agent)
            ok, res, receipt = True, {}, {}
            try:
                res, receipt = await fn(**kwargs)
            except Exception as e:  # noqa: BLE001 - the agent sees the failure
                ok, res = False, {"error": str(e)[:400]}
            finally:
                _CURRENT.reset(token)
            ev = {"type": "tool", "agent": agent, "tool": name, "args": kwargs, "ok": ok, "ms": int((time.time() - t0) * 1000),
                  "summary": res.get("ringkasan") or res.get("error") or "", **receipt}
            self.receipts.setdefault(agent, []).append(ev)
            self.seen.setdefault(agent, []).append({"tool": name, "args": kwargs, "result": res})
            emit(ev)
            return res
        call.__name__ = name
        call.__doc__ = fn.__doc__
        call.__annotations__ = dict(fn.__annotations__)
        import inspect

        call.__signature__ = inspect.signature(fn)  # type: ignore[attr-defined]
        return call

    def functions(self) -> list[dict]:
        if self._functions is None:
            self._functions = self.p.get("/api/functions")
        return self._functions

    def action_types(self) -> list[dict]:
        if getattr(self, "_actions", None) is None:
            self._actions = self.p.get("/api/ontology/action-types")
        return self._actions


def _filters(filter_json: str) -> list[dict]:
    s = (filter_json or "").strip()
    if not s:
        return []
    try:
        f = json.loads(s)
    except json.JSONDecodeError:
        # the leading JSON of what a model wrote: DeepSeek's call markup trailing it ("…]</｜DSML｜ parameter>", 9 failed
        # reads), two lists side by side, or objects without their brackets
        dec, items, i = json.JSONDecoder(), [], 0
        while i < len(s):
            while i < len(s) and s[i] in " \t\r\n,;":
                i += 1
            if i >= len(s) or s[i] not in "[{":
                break
            v, i = dec.raw_decode(s, i)
            items += v if isinstance(v, list) else [v]
        if not items:
            raise
        f = items
    if isinstance(f, dict):
        f = [f]
    return [{"property": x.get("property") or x.get("properti") or x.get("field") or x.get("kolom"), "op": x.get("op") or x.get("operator") or "eq",
             "value": x.get("value", x.get("nilai")), **({"dimensi": x["dimensi"]} if x.get("dimensi") else {})} for x in f]


# ------------------------------------------------------------------------------------------------
# an agent's arguments checked before the tool runs: a name it reaches for (a key column for a dimension, "Faskes
# Profil" for a type, a semantic filter in an object tool) taken to the one that exists, or refused with what does
# exist — 188 of the 2,269 tool calls of Audit Nasional 1 failed (2026-10-28), most of them on such names
# ------------------------------------------------------------------------------------------------


def _dimension_aliases() -> dict[str, str]:
    """{a name an agent writes: the semantic dimension}: each dimension's own properties (faskes_profil_id → faskes,
    tipe_fkrtl → tipe_faskes) and the words agents used for them."""
    out = {prop: dim for dim, d in S.DIMENSI.items() for prop in d["properti"].values()}
    out.update({"faskes_id": "faskes", "nama_faskes": "faskes", "nama_profil": "faskes", "profil_faskes": "faskes", "tipe": "tipe_faskes",
                "tipe_rs": "tipe_faskes", "kelas_rs": "tipe_faskes", "jenis": "jenis_faskes", "kabkota_kode": "kabkota", "kab_kota": "kabkota",
                "kabupaten": "kabkota", "kota": "kabkota", "provinsi_kode": "provinsi", "kode_inacbg": "inacbg", "icd3": "diagnosis"})
    out.update({d: d for d in S.DIMENSI})
    return out


DIM_ALIAS = _dimension_aliases()
FASKES_ID = re.compile(r"[0-9a-f]{32}")


def _props(t: dict) -> list[str]:
    return [p["api_name"] for p in t.get("properties") or []]


def check_prop(t: dict, prop: Optional[str], what: str) -> Optional[str]:
    """A property name for type `t`: as written when it exists, else the type's own property of the dimension it names
    (tipe → tipe_fkrtl on the claims), else a near spelling; refused with the type's properties when none fits."""
    if not prop:
        return prop
    have = _props(t)
    if prop in have:
        return prop
    # (a facility's name is not its id: nama_profil never becomes faskes_profil_id, a filter on it would match nothing)
    dim = DIM_ALIAS.get(prop.strip().lower()) if prop.strip().lower() not in ("nama_faskes", "nama_profil") else None
    own = S.DIMENSI[dim]["properti"].get(t["name"]) if dim else None
    if own and own in have:
        return own
    import difflib

    near = difflib.get_close_matches(prop, have, n=3, cutoff=0.8)
    if len(near) == 1:
        return near[0]
    if prop in S.UKURAN:
        raise ValueError(f"'{prop}' adalah ukuran lapisan semantik, bukan properti {t['name']}: pakai ukur(ukuran=\"{prop}\", …)")
    raise ValueError(f"{what} '{prop}' tidak ada di {t['name']}" + (f"; mungkin: {', '.join(near)}" if near else "") +
                     f"; properti: {', '.join(have[:40])}")


def check_filters(t: dict, filters: list[dict]) -> list[dict]:
    """Filters for type `t`: a semantic one ({"dimensi": "provinsi", "nilai": …}) becomes the type's property, a property
    name is checked (check_prop); a filter without a property is refused before the API answers 422."""
    out = []
    for f in filters:
        prop = f.get("property")
        if not prop and f.get("dimensi"):
            dim = DIM_ALIAS.get(str(f["dimensi"]).strip().lower())
            prop = S.DIMENSI[dim]["properti"].get(t["name"]) if dim else None
            if not prop:
                raise ValueError(f"filter dimensi '{f['dimensi']}' tidak berlaku untuk {t['name']}: tulis filter properti "
                                 f"[{{\"property\": \"<nama>\", \"op\": \"eq\", \"value\": …}}]; properti: {', '.join(_props(t)[:40])}")
        if not prop:
            raise ValueError(f"filter tanpa 'property': {json.dumps(f, ensure_ascii=False)[:160]}")
        out.append({"property": check_prop(t, prop, "properti filter"), "op": f.get("op") or "eq", "value": f.get("value")})
    return out


def check_measure(ukuran: str, dimensi: str, filters: list[dict], props: Callable[[str], list[str]]) -> tuple[str, list[dict]]:
    """`ukur`'s arguments: the dimension and the dimensions of the filters taken to the semantic layer's names; a property
    filter on a name the measure's type lacks but a dimension covers becomes that dimension's filter; a facility filtered
    by name, not its id, is refused (it matched nothing silently: "risiko_per_1000 per faskes: 0 kelompok"); a dimension
    the measure's type lacks is refused with the measures of the same tag that have it. props(type name) → its properties."""
    u = S.UKURAN.get(ukuran)
    dim = DIM_ALIAS.get((dimensi or "").strip().lower(), (dimensi or "").strip())
    if not u:
        return dim, filters
    tipe, have = u["tipe"], props(u["tipe"])
    if dim and dim in S.DIMENSI and not S.DIMENSI[dim]["properti"].get(tipe):
        alt = [k for k, v in S.UKURAN.items() if S.DIMENSI[dim]["properti"].get(v["tipe"]) and (set(v["tag"]) & set(u["tag"]) or v["properti"] == u["properti"])]
        raise ValueError(f"dimensi '{dim}' tidak berlaku untuk ukuran {ukuran} ({tipe}); ukuran sejenis yang punya dimensi {dim}: "
                         f"{', '.join(alt[:6]) or '-'}; dimensi {ukuran}: {', '.join(k for k, v in S.DIMENSI.items() if tipe in v['properti'])}")
    out = []
    for f in filters:
        f = dict(f)
        if not f.get("dimensi") and f.get("property") and f["property"] not in have and DIM_ALIAS.get(str(f["property"]).lower()):
            f = {"dimensi": DIM_ALIAS[str(f["property"]).lower()], "op": f.get("op"), "nilai": f.get("value", f.get("nilai"))}
        if f.get("dimensi"):
            f["dimensi"] = DIM_ALIAS.get(str(f["dimensi"]).strip().lower(), f["dimensi"])
            v = f.get("nilai", f.get("value"))
            if f["dimensi"] == "faskes" and any(not FASKES_ID.fullmatch(str(x)) for x in (v if isinstance(v, list) else [v])):
                raise ValueError(f"filter faskes memakai faskes_profil_id (32 karakter hex), bukan nama '{str(v)[:60]}': cari id-nya dulu "
                                 "(cari_objek Profil Faskes (BPJS) dengan kata_kunci nama, atau dari hasil yang sudah Anda baca)")
        out.append(f)
    return dim, out


def widen(box: Toolbox, rid: str, limit: int = 50) -> Optional[str]:
    """A search the screen shows as a table but an agent took only a few rows of (1 of 1.093, seen 2026-10-23): the same
    search again with `limit` rows, as a new result. None when the result is whole, not a search, or the search fails."""
    entry = next((e for e in box.index if e["rid"] == rid), None)
    meta = (entry or {}).get("meta") or {}
    body, found = meta.get("body"), meta.get("total") or 0
    if not entry or meta.get("kind") != "objects" or not body or entry["total"] >= min(found, limit):
        return None
    try:
        t = box.type_of("validator", meta["type"], any_owner=True)
        r, _note = _search(box.p, {**body, "limit": limit})
    except Exception:  # noqa: BLE001 - the screen keeps the agent's rows
        return None
    rows = [_flat(o) for o in r.get("objects") or []]
    added = box.name_columns(t, rows)
    return box.result(entry["title"], rows, t, {c: "string" for c in added}, {**meta, "total": r.get("total")})


def _search(p: Platform, body: dict) -> tuple[dict, str]:
    """Explorer search; when exact text filters (eq / in) match nothing, retried once with the values in upper, lower
    and title case (BPJS region names are stored in capitals); a sort on a property the type does not allow is dropped
    rather than failed. Returns the answer and a note of what was changed."""
    sort_note = ""
    try:
        r = p.post("/api/ontology/explorer/search", body)
    except Exception as e:  # noqa: BLE001 - the same search, unsorted (seen 2026-10-23: "Tag is not sortable")
        if "not sortable" not in str(e) or not body.get("sort"):
            raise
        sort_note = f"properti {body['sort']} tidak bisa diurutkan: hasil tanpa urutan (pakai agregasi_objek untuk peringkat)"
        body["sort"] = None
        r = p.post("/api/ontology/explorer/search", body)
    text_eq = [f for f in body.get("filters") or [] if f.get("op") in ("eq", "in") and (isinstance(f.get("value"), str) or
               (isinstance(f.get("value"), list) and all(isinstance(v, str) for v in f["value"])))]
    if r.get("total") or not text_eq:
        return r, sort_note
    for case in (str.upper, str.lower, str.title):
        filters = [{**f, "value": (case(f["value"]) if isinstance(f["value"], str) else [case(v) for v in f["value"]])} if f in text_eq else f
                   for f in body["filters"]]
        r2 = p.post("/api/ontology/explorer/search", {**body, "filters": filters})
        if r2.get("total"):
            body["filters"] = filters
            return r2, f"nilai filter teks disesuaikan ke {case.__name__}: " + ", ".join(f"{f['property']}={f['value']!r}" for f in filters if f.get("op") in ("eq", "in"))
    return r, ""


def _get_object(p: Platform, t: dict, kunci: str) -> tuple[dict, str]:
    """An object by its key. A diagnosis code written with a dot (ICD-10 "A41.9") is stored without it ("A419") or by its
    category ("A41", as the diagnosis objects are): tried in that order. Returns the object and the key that found it."""
    tries = [kunci]
    if re.fullmatch(r"[A-Z]\d{2}(\.?[0-9A-Z]{1,2})?", kunci or ""):
        tries += [k for k in (kunci.replace(".", ""), kunci[:3]) if k not in tries]
    for i, k in enumerate(tries):
        try:
            return p.get(f"/api/ontology/object-types/{t['id']}/objects/{k}"), k
        except Exception as e:  # noqa: BLE001 - the next spelling of the code, or the failure as it was
            if "not found" not in str(e) or i == len(tries) - 1:
                raise
    raise LookupError(kunci)  # (unreachable: the loop returns or raises)


def _elsewhere(box: Toolbox, p: Platform, t: dict, kunci: str) -> list[tuple[dict, dict]]:
    """The other catalogue types holding the key in a property of the key's name: (type, its first such object)."""
    pk = t.get("primary_key")
    seen = []
    for other, _owner in box.types.values():
        if other["id"] == t["id"] or not pk or not any(x.get("api_name") == pk for x in other.get("properties") or []):
            continue
        try:
            r = p.post("/api/ontology/explorer/search", {"object_type_id": other["id"], "filters": [{"property": pk, "op": "eq", "value": kunci}],
                                                          "limit": 1, "histograms": False, "resource": "aip"})
        except Exception:  # noqa: BLE001 - a hint, not the answer
            continue
        if r.get("total"):
            seen.append((other, {**(r.get("objects") or [{}])[0], "total": r["total"]}))
    return seen


def _found_elsewhere(box: Toolbox, p: Platform, t: dict, kunci: str) -> str:
    """Where else a key is: a claim the consultancy tagged (Indikasi Fraud) or the model scored is often not among the
    rule-screened Klaim Berisiko — 48 "not found" reads on 2026-10-23 that the agents could not act on."""
    pk = t.get("primary_key")
    seen = [f"{other['name']} ({pk} = {kunci}, {o['total']} objek)" for other, o in _elsewhere(box, p, t, kunci)]
    if seen:
        return "; kunci ini ada di: " + ", ".join(seen[:4]) + " — baca di sana (cari_objek dengan filter " + pk + ")"
    return f"; {t['name']} hanya memuat sebagian klaim/objek: periksa kunci dan tipenya"


def _pasted_claim(box: Toolbox, kunci: str) -> tuple[dict, dict]:
    """A claim the user pasted is not in the data: its /verify answer instead of a read that cannot find it."""
    rid = box.pasted[kunci]
    return ({"klaim_baru": kunci, "hasil_id": rid, "catatan": f"{kunci} adalah klaim BARU yang ditempel pengguna — tidak ada di data Nexus. "
             f"Hasil pipeline /verify-nya ada di [{rid}]; pakai data hanya untuk pembanding (kode INA-CBG, diagnosis, faskes setipe).",
             "ringkasan": f"{kunci}: klaim baru (tidak di data) — hasil /verify di [{rid}]"}, {"rid": rid})


def _flat(o: dict) -> dict:
    return {"_kunci": o.get("primary_key"), "_judul": o.get("title"), **(o.get("properties") or {})}


_NOISE = {"marking", "klasifikasi", "diperbarui_pada", "dibuat_pada", "run_terakhir"}
_MEASURE = re.compile(r"kerugian|koreksi|biaya|tarif|selisih|klaim|skor|jumlah|nilai|total|rasio|pct|los|readmisi|bertag|peserta")


def _brief(o: dict, sort: Optional[str] = None) -> dict:
    """An object as the model reads it: the sort property, then the measures, then the rest in schema order — the first
    ten in schema order hid estimasi_kerugian_rp (Karantina's 15th) and an answer said the losses could not be shown."""
    same = {o.get("primary_key"), o.get("title")}  # a property repeating the key or the title says nothing new
    props = {k: v for k, v in (o.get("properties") or {}).items()
             if v not in (None, "", []) and k not in _NOISE and not (isinstance(v, (str, int, float)) and v in same)}  # lists are not hashable
    pos = {k: i for i, k in enumerate(props)}
    order = sorted(props, key=lambda k: (k != sort, not (_MEASURE.search(k) and isinstance(props[k], (int, float))),
                                         not re.search(r"jenis_indikasi|tag_label|^modus$", k), pos[k]))
    return {"kunci": o.get("primary_key"), "judul": o.get("title"), **{k: props[k] for k in order[:PROPS_FOR_MODEL]}}


def _values_hint(p: Platform, body: dict) -> dict[str, list]:
    """For a search whose text filters matched nothing: the values each filtered property does have, under the other
    filters (tipe = "rumah sakit" matched nothing; the values are "RS Kelas B", "RS Kelas C" …) — one cheap aggregation
    each, instead of an agent spending its steps guessing."""
    out: dict[str, list] = {}
    filters = body.get("filters") or []
    for f in [f for f in filters if f.get("op") in ("eq", "in") and isinstance(f.get("value"), (str, list))][:2]:
        rest = [g for g in filters if g is not f]
        try:
            r = p.post("/api/ontology/explorer/search", {"object_type_id": body["object_type_id"], "filters": rest, "limit": 1, "histograms": False,
                                                          "resource": "aip", "aggregate": {"metric": "count", "property": None, "group_by": f["property"]}})
        except Exception:  # noqa: BLE001 - a hint, not the answer
            continue
        out[f["property"]] = [g.get("group") for g in ((r.get("aggregation") or {}).get("groups") or [])[:12]]
    return {k: v for k, v in out.items() if v}


# Blu 3.0 (the user, 2026-11-12): ML v3 reads every claim, the agents read its output — Klaim Berisiko and a control sample;
# the type holding every claim answers aggregates only. Real data is hundreds of millions of rows: no agent reads them raw.
SCOPE_TYPE_NOTE = ("Blu 3.0: {tipe} memuat SEMUA klaim (data mentah sebelum saringan ML v3). Baris klaim dibaca dari Klaim Berisiko (BPJS) "
                   "(saringan v3) atau dari sampel kontrol (baca_hasil, hasil_id di brief); tipe ini hanya untuk agregasi_objek / ukur, dan "
                   "detail_objek satu klaim yang ada di Klaim Berisiko atau sampel kontrol.")


def _scope(box: Toolbox, t: Optional[dict] = None) -> Optional[dict]:
    """Blu 3.0's reading scope when it is on (and, given a type, when that type is the one holding every claim)."""
    lk = getattr(box, "lingkup", None)
    return lk if lk and (t is None or t.get("name") == lk["tipe"]) else None


def _claim_in_scope(box: Toolbox, klaim_id: str) -> None:
    """Refuses a claim read row by row outside Blu 3.0's scope (Klaim Berisiko and the control sample)."""
    lk = _scope(box)
    if lk and str(klaim_id).strip() not in lk["boleh"]:
        raise LookupError(f"Blu 3.0: klaim {klaim_id} di luar lingkup baca (bukan Klaim Berisiko, bukan sampel kontrol): ML v3 menilainya "
                          "tidak berisiko. Baca klaim dari Klaim Berisiko (BPJS) atau sampel kontrol; untuk pola di luar itu pakai ukur / agregasi_objek.")


def object_tools(box: Toolbox, agent: str, any_owner: bool = False, read_only: bool = False) -> list[Callable]:
    """The Nexus tools of a domain agent (any_owner: the validator, which re-checks across domains)."""
    p = box.p

    def cari_objek(tipe: str, kata_kunci: str, filter_json: str, urut_berdasarkan: str, urutan: str, batas: int) -> dict:
        """Cari objek Nexus satu tipe. tipe: nama tipe objek (mis. "Klaim Berisiko (BPJS)"). filter_json: daftar filter JSON,
        mis. [{"property": "skor_risiko", "op": "gte", "value": 50}] — op: eq, neq, gt, gte, lt, lte, contains, in, between,
        is_null, not_null. Nama provinsi dan kab/kota tersimpan dalam HURUF BESAR (mis. "SULAWESI SELATAN"). urut_berdasarkan: api_name properti; urutan: asc atau desc; batas: jumlah objek (1–500).
        Isi "" untuk kata_kunci, filter_json atau urut_berdasarkan yang tidak dipakai. Mengembalikan total, objek teratas
        dan hasil_id (tabel lengkap untuk layar)."""
        t = box.type_of(agent, tipe, any_owner)
        if (kata_kunci or "").strip() in box.pasted:
            return _pasted_claim(box, kata_kunci.strip())
        if _scope(box, t):
            raise LookupError(SCOPE_TYPE_NOTE.format(tipe=t["name"]))
        body = {"object_type_id": t["id"], "q": kata_kunci or "", "filters": check_filters(t, _filters(filter_json)),
                "sort": check_prop(t, urut_berdasarkan, "urut_berdasarkan") or None,
                "order": "asc" if urutan == "asc" else "desc", "limit": max(1, min(int(batas or 10), ROWS_KEPT)), "histograms": False, "resource": "aip"}
        r, note = _search(p, body)
        objs = r.get("objects") or []
        rows = [_flat(o) for o in objs]
        added = box.name_columns(t, rows)  # the names of the faskes, kab/kota, INA-CBG … each row points to
        rid = box.result(f"{t['name']}: {kata_kunci or filter_json or 'semua'}", rows, t, {c: "string" for c in added},
                         {"kind": "objects", "type": t["name"], "total": r.get("total"), "filters": body["filters"], "sort": body["sort"], "body": body})
        brief = [{**{c: row[c] for c in added if c in row}, **_brief(o, body["sort"])} for o, row in zip(objs[:ROWS_FOR_MODEL], rows)]
        hint = _values_hint(p, body) if not r.get("total") else {}
        return ({"tipe": t["name"], "total": r.get("total"), "objek": brief, "hasil_id": rid,
                 **({"nilai_tersedia": hint, "catatan_filter": "tidak ada yang cocok: pakai salah satu nilai_tersedia untuk properti itu"} if hint else {}),
                 **({"catatan": note} if note else {}), "ringkasan": f"{t['name']}: {r.get('total')} objek cocok, {len(objs)} diambil" + (f" ({note})" if note else "")},
                {"request": {"endpoint": "POST /api/ontology/explorer/search", "body": body}, "rid": rid, "rows": len(objs),
                 "links": [{"app": "objects", "type_id": t["id"], "type": t["name"]}]})

    def agregasi_objek(tipe: str, metrik: str, properti: str, kelompok: str, filter_json: str) -> dict:
        """Agregasi objek satu tipe: metrik count, sum, avg, min atau max atas properti (api_name; "" untuk count),
        dikelompokkan menurut properti kelompok ("" bila satu angka total), dengan filter_json seperti di cari_objek
        ("" bila tanpa filter). Untuk angka total, rata-rata, peringkat per kelompok."""
        t = box.type_of(agent, tipe, any_owner)
        metrik = (metrik or "count").strip().lower()
        properti, kelompok = check_prop(t, properti, "properti"), check_prop(t, kelompok, "kelompok")
        if _scope(box, t) and kelompok and kelompok in {t.get("primary_key"), "klaim_id", "judul"}:
            raise LookupError(f"Blu 3.0: agregasi per klaim di {t['name']} sama dengan membaca klaim mentah satu per satu; kelompokkan per "
                              "faskes, provinsi, kode atau bulan, atau baca klaimnya dari Klaim Berisiko (BPJS) / sampel kontrol.")
        if metrik in ("sum", "avg", "min", "max") and not properti:
            raise ValueError(f"metrik {metrik} butuh properti angka dari {t['name']}; untuk jumlah objek pakai metrik count")
        body = {"object_type_id": t["id"], "filters": check_filters(t, _filters(filter_json)), "limit": 1, "histograms": False, "resource": "aip",
                "aggregate": {"metric": metrik if metrik in ("count", "sum", "avg", "min", "max") else "count", "property": properti or None,
                              "group_by": kelompok or None}}
        r, note = _search(p, body)
        agg = r.get("aggregation") or {}
        groups = sorted(agg.get("groups") or [], key=lambda g: -(g.get("value") or 0) if isinstance(g.get("value"), (int, float)) else 0)
        names = box.labels(kelompok, [g.get("group") for g in groups[:150]]) if kelompok else {}
        where = box.geo(kelompok, [g.get("group") for g in groups[:150]]) if kelompok else {}
        groups = [{**({"nama": names[str(g.get("group"))]} if str(g.get("group")) in names else {}), **g,
                   **({"lokasi": where[str(g.get("group"))]} if str(g.get("group")) in where else {})} for g in groups]
        kinds = {p["api_name"]: p["type"] for p in t.get("properties") or []}
        rid = box.result(f"{t['name']}: {metrik}({properti or '*'}) per {kelompok or 'semua'}", groups, t,
                         {"group": kinds.get(kelompok or "", "string"), "nama": "string", "value": "double", "count": "integer", "lokasi": "string"},
                         {"kind": "agg", "group": kelompok or None, "metric": metrik, "prop": properti or None, "type": t["name"],
                          "filters": body["filters"]})
        hint = _values_hint(p, body) if not r.get("total") else {}
        return ({"tipe": t["name"], "total_objek": r.get("total"), "metrik": metrik, "properti": properti, "kelompok": kelompok,
                 "hasil": groups[:15], "jumlah_kelompok": len(groups), "hasil_id": rid, **({"catatan": note} if note else {}),
                 **({"nilai_tersedia": hint, "catatan_filter": "tidak ada yang cocok: pakai salah satu nilai_tersedia untuk properti itu"} if hint else {}),
                 "ringkasan": f"{t['name']}: {metrik}({properti or '*'})" + (f" per {kelompok}, {len(groups)} kelompok" if kelompok else f" = {groups[0]['value'] if groups else '-'}")},
                {"request": {"endpoint": "POST /api/ontology/explorer/search", "body": body}, "rid": rid, "rows": len(groups),
                 "links": [{"app": "objects", "type_id": t["id"], "type": t["name"]}]})

    def detail_objek(tipe: str, kunci: str) -> dict:
        """Semua properti satu objek, dari tipe dan kuncinya (primary key)."""
        t = box.type_of(agent, tipe, any_owner)
        if kunci in box.pasted:
            return _pasted_claim(box, kunci)
        moved = ""
        if _scope(box, t):
            _claim_in_scope(box, kunci)
        try:
            o, kunci = _get_object(p, t, kunci)
        except Exception as e:  # noqa: BLE001 - not in this type: where the key is, instead of a bare "not found"
            if "not found" not in str(e):
                raise
            # a claim not among the screened Klaim Berisiko is read from the data type that has it (26 reads of Audit
            # Nasional 1 failed so, 2026-10-28); the consultancy's own records are notes, not the data
            data = [(x, ob) for x, ob in _elsewhere(box, p, t, kunci) if not x["name"].startswith(("Indikasi Fraud", "Karantina"))]
            if not data:
                raise LookupError(f"{kunci} tidak ada di {t['name']}" + _found_elsewhere(box, p, t, kunci)) from None
            if _scope(box, data[0][0]):
                _claim_in_scope(box, kunci)
            moved, (t, o) = f"{kunci} tidak ada di {t['name']}: dibaca dari {data[0][0]['name']}", data[0]
            kunci = str(o.get("primary_key") or kunci)
        props = {k: v for k, v in (o.get("properties") or {}).items() if v not in (None, "", [])}
        box.name_columns(t, [props])  # names next to the keys it points to
        # a result of the run like a search: the answer cites it and code traces its figures (a lookup from one object once
        # cited a missing [r1] and went through the validator and a revision, 86 s instead of 24, 2026-10-24)
        rid = box.result(f"{t['name']} {o.get('title') or kunci}", [{"_kunci": kunci, "_judul": o.get("title"), **props}], t, None,
                         {"kind": "objects", "type": t["name"], "total": 1, "filters": [{"property": t.get("primary_key"), "op": "eq", "value": kunci}]})
        return ({"tipe": t["name"], "kunci": kunci, "judul": o.get("title"), "properti": props, "hasil_id": rid, **({"catatan": moved} if moved else {}),
                 "ringkasan": f"{t['name']} {o.get('title')}" + (f" ({moved})" if moved else "")},
                {"request": {"endpoint": f"GET /api/ontology/object-types/{t['id']}/objects/{kunci}"}, "rid": rid, "rows": 1,
                 "links": [{"app": "object", "type_id": t["id"], "pk": kunci, "type": t["name"]}]})

    def objek_terkait(tipe: str, kunci: str) -> dict:
        """Objek yang tersambung ke satu objek lewat link Nexus (mis. klaim → profil faskes, peserta, kode INA-CBG)."""
        t = box.type_of(agent, tipe, any_owner)
        if kunci in box.pasted:
            return _pasted_claim(box, kunci)
        r = p.get(f"/api/ontology/object-types/{t['id']}/objects/{kunci}/links")
        links = r if isinstance(r, list) else r.get("links") or []
        out = []
        for lk in links[:20]:
            objs = lk.get("objects") or []
            sc = _scope(box)
            if sc and (lk.get("object_type_name") or lk.get("target_type")) == sc["tipe"]:
                objs = [o for o in objs if str(o.get("primary_key")) in sc["boleh"]]
            out.append({"link": lk.get("display_name") or lk.get("name"), "tipe": lk.get("object_type_name") or lk.get("target_type"),
                        "jumlah": lk.get("total", len(objs)), "contoh": [{"kunci": o.get("primary_key"), "judul": o.get("title")} for o in objs[:5]]})
        rid = box.result(f"Link {t['name']} {kunci}", [{k: v for k, v in x.items() if k != "contoh"} for x in out], None, None, {"kind": "other"})
        return ({"tipe": t["name"], "kunci": kunci, "link": out, "hasil_id": rid, "ringkasan": f"{len(out)} link dari {t['name']} {kunci}"},
                {"request": {"endpoint": f"GET /api/ontology/object-types/{t['id']}/objects/{kunci}/links"}, "rid": rid, "rows": len(out),
                 "links": [{"app": "object", "type_id": t["id"], "pk": kunci, "type": t["name"]}]})

    def jalankan_fungsi(nama_fungsi: str, tipe: str, kunci: str) -> dict:
        """Jalankan fungsi Nexus pada satu objek, mis. alasan_risiko_klaim, potensi_kelebihan_bayar, klaim_serupa,
        ringkasan_risiko_profil, ringkasan_risiko_kabkota, klaim_teratas_kabkota."""
        t = box.type_of(agent, tipe, any_owner)
        if _scope(box, t):
            _claim_in_scope(box, kunci)
        if kunci in box.pasted:
            return _pasted_claim(box, kunci)
        # only a function that reads an object of this type: never an edit function, never one of the same name
        # elsewhere on the platform (names repeat across repositories), never one taking another type
        want = f"object:{t['api_name']}"
        fn = next((f for f in box.functions() if f["name"] == nama_fungsi and f.get("kind") != "edit" and not f.get("edits")
                   and any(str(i.get("type")) == want for i in f.get("inputs") or [])), None)
        if not fn:
            # which types the function does read, and what else reads this type (11 calls of Audit Nasional 1 asked
            # klaim_serupa of types it does not take)
            takes = sorted({str(i.get("type")).removeprefix("object:") for f in box.functions() if f["name"] == nama_fungsi and f.get("kind") != "edit"
                            for i in f.get("inputs") or [] if str(i.get("type")).startswith("object:")})
            here = sorted({f["name"] for f in box.functions() if f.get("kind") != "edit" and not f.get("edits")
                           and any(str(i.get("type")) == want for i in f.get("inputs") or [])})
            raise LookupError(f"tidak ada fungsi baca '{nama_fungsi}' untuk {t['name']}" +
                              (f"; '{nama_fungsi}' menerima tipe (api_name): {', '.join(takes)}" if takes else "") +
                              (f"; fungsi untuk {t['name']}: {', '.join(here[:12])}" if here else ""))
        arg = next(i["name"] for i in fn["inputs"] if str(i.get("type")) == want)
        r = p.post(f"/api/functions/{fn['id']}/execute", {"inputs": {arg: {"object_type_id": t["id"], "primary_key": kunci}}, "resource": "aip"})
        value = r.get("value", r.get("output", r))
        if isinstance(value, list):  # object results come wrapped ({"__object__": {...}})
            value = [v.get("__object__", v) if isinstance(v, dict) else v for v in value]
        elif isinstance(value, dict) and "__object__" in value:
            value = value["__object__"]
        rid = None
        if isinstance(value, list) and value and isinstance(value[0], dict):
            rid = box.result(f"{nama_fungsi}({kunci})", [_flat(o) if "primary_key" in o else o for o in value], None, None,
                             {"kind": "function", "name": nama_fungsi, "type": t["name"], "key": kunci})
            shown: Any = [_brief(o) if "primary_key" in o else o for o in value[:ROWS_FOR_MODEL]]
        else:
            shown = value
        return ({"fungsi": nama_fungsi, "objek": kunci, "hasil": shown, "hasil_id": rid, "ringkasan": f"{nama_fungsi}({kunci})"},
                {"request": {"endpoint": f"POST /api/functions/{fn['id']}/execute"}, "rid": rid,
                 "links": [{"app": "function", "id": fn["id"], "name": nama_fungsi}, {"app": "object", "type_id": t["id"], "pk": kunci, "type": t["name"]}]})

    def usulkan_action(action: str, tipe: str, kunci: str, parameter_json: str, alasan: str) -> dict:
        """Usulkan satu action Nexus pada objek (mis. "Tahan klaim untuk verifikasi (BPJS)") dengan parameter JSON dan alasan.
        Agen tidak menjalankannya: usulan tampil untuk diputuskan manusia."""
        t = box.type_of(agent, tipe, any_owner)
        # the exact action on this object type, resolved now: the person deciding sees and runs this one, not one of the
        # same name elsewhere; its object parameter is the object proposed, which the agent's parameters cannot replace
        act = next((a for a in box.action_types() if a.get("object_type_id") == t["id"] and a.get("status", "active") == "active"
                    and action in (a.get("display_name"), a.get("api_name"))), None)
        if not act:
            names = [a["display_name"] for a in box.action_types() if a.get("object_type_id") == t["id"]]
            raise LookupError(f"action '{action}' tidak ada untuk {t['name']}; yang ada: {names}")
        defs = act.get("parameters") or []
        obj = next((d["id"] for d in defs if d.get("type") == "object"), "object")
        params = json.loads(parameter_json) if (parameter_json or "").strip() else {}
        if not isinstance(params, dict):
            raise ValueError("parameter_json harus objek JSON")
        unknown = [k for k in params if k == obj or k not in {d["id"] for d in defs}]
        if unknown:
            raise ValueError(f"parameter tidak dikenal untuk {act['display_name']}: {unknown}")
        emit({"type": "proposal", "agent": agent, "action": act["display_name"], "action_id": act["id"], "object_param": obj,
              "object_type": {"id": t["id"], "name": t["name"]}, "pk": kunci, "parameters": params,
              "parameter_defs": [{"id": d["id"], "name": d.get("display_name") or d["id"], "type": d.get("type"), "required": bool(d.get("required"))}
                                 for d in defs if d["id"] != obj],
              "reason": alasan})
        return ({"status": "diusulkan — menunggu keputusan manusia", "action": action, "kunci": kunci,
                 "ringkasan": f"usulan {action} untuk {kunci}"}, {"links": [{"app": "object", "type_id": t["id"], "pk": kunci, "type": t["name"]}]})

    def estimasi_kerugian_klaim(filter_json: str) -> dict:
        """Estimasi kerugian sekumpulan Klaim Berisiko: filter_json seperti di cari_objek ("" = semua klaim). Aturan Box
        Karantina per klaim bertag yang BELUM dikoreksi verifikator: komponen terbesar dari tagihan di luar tarif INA-CBG +
        top-up, dibayar di atas 1,5× median peer setarif, separuh calon klaim ganda, atau ekspektasi koreksi model; klaim yang sudah dikoreksi dilaporkan terpisah
        (sudah_dikoreksi_rp). Pakai untuk "berapa estimasi kerugiannya" tentang himpunan klaim (kode INA-CBG, LOS ekstrem,
        wilayah, diagnosis, faskes): jumlah selisih_rp saja adalah yang sudah dikoreksi, BUKAN estimasi kerugian."""
        t = box.type_of(agent, CLAIMS_TYPE, any_owner)
        body = {"filters": check_filters(t, _filters(filter_json))}
        r = p.post("/api/aip/karantina/estimasi", body)
        rows = r.get("klaim_kontributor") or []
        rid = box.result(f"Estimasi kerugian {t['name']}" + (f" · {filter_json}" if body["filters"] else ""), rows, t,
                         {"klaim_id": "string", "komponen": "string", "nilai_rp": "double", "dibayar_rp": "double", "peer_p50_rp": "double",
                          "faskes_profil_id": "string", "inacbg_kode": "string", "los_hari": "integer", "tag": "string"})
        rp = lambda x: f"Rp{x or 0:,.0f}".replace(",", ".")  # noqa: E731
        return ({**r, "hasil_id": rid,
                 "ringkasan": f"{r['klaim']} klaim ({r['klaim_bertag']} bertag): estimasi kerugian {rp(r['estimasi_kerugian_rp'])}, "
                              f"sudah dikoreksi {rp(r['sudah_dikoreksi_rp'])}, tagihan {rp(r['biaya_tagih_rp'])}"},
                {"request": {"endpoint": "POST /api/aip/karantina/estimasi", "body": body}, "rid": rid, "rows": len(rows),
                 "links": [{"app": "objects", "type_id": t["id"], "type": t["name"]}]})

    fns: list[Callable] = [cari_objek, agregasi_objek, detail_objek, objek_terkait, jalankan_fungsi]
    # the loss of a set of claims, for the agent that holds the claims (and the validator, which re-checks it)
    if any(t["name"] == CLAIMS_TYPE and (any_owner or owner == box.owner_of.get(agent, agent)) for t, owner in box.types.values()):
        fns.append(estimasi_kerugian_klaim)
    if not read_only:
        fns.append(usulkan_action)
    return [box.wrap(agent, f.__name__, f) for f in fns]


def platform_tools(box: Toolbox, agent: str) -> list[Callable]:
    """The Data & Lineage agent: the platform's own resources."""
    p = box.p

    def cari_nexus(kueri: str, k: int) -> dict:
        """Cari di graf pengetahuan (Orbis/Nexus): dataset, pipeline, tipe objek, model, dokumen — dengan pencarian semantik."""
        r = p.post("/api/orbis/search", {"q": kueri, "k": max(1, min(int(k or 10), 20))})
        hits = [{"label": h.get("label"), "jenis": h.get("kind"), "id": h.get("id"), "skor": round(h.get("score", 0), 3)} for h in r.get("hits", [])]
        # a result of the run like any read: the answer cites it (an uncited [r1] once failed a lineage answer, 2026-10-24)
        rid = box.result(f"Pencarian Nexus: {kueri}", hits, None, None, {"kind": "other"})
        return ({"hasil": hits, "hasil_id": rid, "ringkasan": f"{len(hits)} simpul untuk '{kueri}'"},
                {"request": {"endpoint": "POST /api/orbis/search"}, "rid": rid, "rows": len(hits)})

    def telusuri_lineage(nama: str, arah: str, kedalaman: int) -> dict:
        """Telusuri Data Lineage dari satu node (dataset, pipeline, tipe objek): arah hulu (up), hilir (down) atau keduanya
        (both); kedalaman 1–6 langkah."""
        g = p.get("/api/lineage/graph")
        nodes = {n["id"]: n for n in g.get("nodes", [])}
        want = nama.lower().strip()
        hit = [n for n in nodes.values() if (n.get("name") or "").lower() == want] or [n for n in nodes.values() if want in (n.get("name") or "").lower()]
        if not hit:
            raise LookupError(f"tidak ada node lineage bernama '{nama}'")
        start = hit[0]
        up: dict[str, list[str]] = {}
        down: dict[str, list[str]] = {}
        for e in g.get("edges", []):
            down.setdefault(e["from"], []).append(e["to"])
            up.setdefault(e["to"], []).append(e["from"])

        def walk(adj: dict[str, list[str]]) -> list[dict]:
            seen, frontier, out = {start["id"]}, [start["id"]], []
            for level in range(1, max(1, min(int(kedalaman or 3), 6)) + 1):
                nxt = []
                for nid in frontier:
                    for m in adj.get(nid, []):
                        if m not in seen and m in nodes:
                            seen.add(m)
                            nxt.append(m)
                            out.append({"nama": nodes[m].get("name"), "jenis": nodes[m].get("kind_label") or nodes[m].get("kind"), "level": level})
                frontier = nxt
            return out[:60]

        hulu = walk(up) if arah in ("up", "both") else []
        hilir = walk(down) if arah in ("down", "both") else []
        rid = box.result(f"Lineage {start.get('name')}", [{"arah": "hulu", **x} for x in hulu] + [{"arah": "hilir", **x} for x in hilir], None, None,
                         {"kind": "other"})
        return ({"node": start.get("name"), "jenis": start.get("kind_label") or start.get("kind"), "hulu": hulu, "hilir": hilir, "hasil_id": rid,
                 "ringkasan": f"{start.get('name')}: {len(hulu)} hulu, {len(hilir)} hilir"},
                {"request": {"endpoint": "GET /api/lineage/graph"}, "rid": rid, "rows": len(hulu) + len(hilir),
                 "links": [{"app": "lineage", "node": start.get("name"), "node_id": start["id"]}]})

    def baca_kode(repo: str, path: str) -> dict:
        """Baca repositori kode (mis. "Pipeline Data Sampel BPJS", "Fungsi Nexus Data Sampel BPJS"): path "" → daftar file."""
        repos = p.get("/api/code-repos")
        rec = next((r for r in repos if r.get("name", "").lower() == repo.lower()), None) or next((r for r in repos if repo.lower() in r.get("name", "").lower()), None)
        if not rec:
            raise LookupError(f"repositori '{repo}' tidak ada")
        r = p.get(f"/api/code-repos/{rec['id']}")
        files: dict[str, str] = r.get("files") or {}
        if not path:
            rid = box.result(f"Repositori {rec['name']}", [{"file": f} for f in sorted(files)[:200]], None, None, {"kind": "other"})
            return ({"repo": rec["name"], "file": sorted(files)[:80], "hasil_id": rid, "ringkasan": f"{rec['name']}: {len(files)} file"},
                    {"rid": rid, "rows": len(files), "links": [{"app": "code", "id": rec["id"]}]})
        match = path if path in files else next((f for f in files if f.endswith(path) or path.lower() in f.lower()), None)
        if not match:
            raise LookupError(f"file '{path}' tidak ada")
        text = files[match]
        rid = box.result(f"{rec['name']}: {match}", [{"file": match, "baris": text.count(chr(10)) + 1}], None, None, {"kind": "other"})
        return ({"repo": rec["name"], "file": match, "isi": text[:6000], "terpotong": len(text) > 6000, "hasil_id": rid,
                 "ringkasan": f"{match} ({text.count(chr(10)) + 1} baris)"},
                {"rid": rid, "rows": 1, "links": [{"app": "code", "id": rec["id"], "path": match}]})

    return [box.wrap(agent, f.__name__, f) for f in (cari_nexus, telusuri_lineage, baca_kode)]


# ------------------------------------------------------------------------------------------------
# the Machine Learning agent (aip/ml.py): the supervised claim-risk model, its benchmark, its explanations
# ------------------------------------------------------------------------------------------------

ML_TOOLS = ["kartu_model_ml", "kartu_bukti_model", "bentuk_sub_agen_teknik", "skor_risiko_klaim_ml", "risiko_faskes_ml", "jelaskan_klaim_ml",
            "benchmark_ml"]
SUB_CALLS = 6  # model calls per technique sub-agent
BENCH_WAIT = 900  # seconds a live benchmark may take before the tool stops waiting (the job goes on)


def _r(v: Any, d: int = 4) -> Any:
    return round(float(v), d) if isinstance(v, (int, float)) and v == v else v


def ml_tools(box: Toolbox, agent: str, read_only: bool = False) -> list[Callable]:
    p = box.p

    def _board_rows(papan: list[dict]) -> list[dict]:
        rows = []
        for x in papan:
            r, ci = x["rata"], (x.get("gabungan_oof") or {}).get("ci95") or {}
            rows.append({"model": x["model"], "keluarga": x.get("keluarga"), "pembanding": bool(x.get("pembanding")),
                         **{k: _r(r[k]["mean"]) for k in ("auprc", "auroc", "f1", "presisi", "recall", "akurasi", "akurasi_seimbang",
                                                           "presisi_top_0_1pct", "recall_top_1pct", "lift_top_0_1pct") if k in r},
                         "auprc_sd": _r(r["auprc"]["sd"]), "auprc_ci95": [_r(v) for v in ci.get("auprc", [])] or None,
                         "auroc_ci95": [_r(v) for v in ci.get("auroc", [])] or None, "detik_latih": _r(x.get("detik_latih"), 1),
                         "menang": f"{x['menang']}/{x['dari']}" if x.get("dari") else None,
                         "p_vs_terbaik": _r((x.get("uji_vs_terbaik") or {}).get("p")),
                         "setara_dengan_terbaik": (not (x.get("uji_vs_terbaik") or {}).get("berbeda_nyata", True)) if x.get("uji_vs_terbaik") else None})
        return rows

    def _board_result(title: str, papan: list[dict], task: str, best: Optional[str]) -> tuple[str, list[dict]]:
        rows = _board_rows(papan)
        rid = box.result(title, rows, types={"model": "string", "keluarga": "string"},
                         meta={"kind": "ml_board", "task": task, "best": best, "metric": "auprc"})
        return rid, rows

    def kartu_model_ml() -> dict:
        """Kartu model ML (panggil PERTAMA sebelum menyebut angka keandalan): label yang dipakai, model terpilih per segmen,
        papan benchmark semua teknik (AUPRC, AUROC, F1, presisi, recall, akurasi, akurasi seimbang, presisi & lift di 0,1%
        teratas, dengan simpangan antar-lipatan dan interval 95%), pembanding (aturan, Isolation Forest), validasi temporal,
        perbandingan metode penjelasan (TreeSHAP, KernelSHAP, LIME, oklusi) dan fitur terpenting."""
        c = p.get("/api/aip/ml")
        if c.get("status") != "siap":
            raise RuntimeError("model ML belum dilatih (admin: POST /api/aip/ml/train)")
        lap = c.get("laporan") or {}
        out: dict[str, Any] = {"versi": c.get("version"), "dilatih": c.get("trained_at"), "label": lap.get("label"), "segmen": lap.get("segmen"),
                               "keluaran": lap.get("keluaran"), "tugas": {}}
        for task, r in (lap.get("tugas") or {}).items():
            rid, rows = _board_result(f"Benchmark teknik ML · {r['label']}", r["papan"], task, r.get("terbaik"))
            # the evaluation sample keeps every positive and 1 in `bobot_negatif` negatives (weighted back): its row count is
            # not the population, and positif/klaim is not the share of positives — a briefing said 0,059% for 0,006%
            # (2026-10-24), as did an outside model reading the same numbers
            ev_ = r.get("evaluasi") or {}
            pos, n, w = int(ev_.get("positif") or 0), int(ev_.get("klaim") or 0), int(ev_.get("bobot_negatif") or 1)
            pop = pos + (n - pos) * w
            evaluasi = {"klaim_sampel": n, "positif": pos, "bobot_negatif": w, "klaim_populasi_setara": pop,
                        "porsi_positif_populasi_pct": _r(100 * pos / pop, 5) if pop else None, "auprc_acak": _r(pos / pop, 7) if pop else None,
                        "cara_baca": f"Sampel evaluasi = semua {pos} klaim positif + 1 dari {w} klaim negatif (dibobot {w} saat metrik dihitung), "
                                     f"setara {pop} klaim. Porsi positif populasi = porsi_positif_populasi_pct, BUKAN positif/klaim_sampel. AUPRC "
                                     "dibandingkan dengan auprc_acak (= porsi positif populasi), dan antar-tugas hanya lewat kelipatannya di atas acak."}
            t: dict[str, Any] = {"label": r["label"], "terbaik": r.get("terbaik"), "hasil_id_papan": rid, "evaluasi": evaluasi,
                                 "uji": r.get("uji"), "ulangan": r.get("ulangan"), "lipatan": r.get("lipatan"),
                                 "papan": [{k: v for k, v in x.items() if k in ("model", "pembanding", "auprc", "auprc_ci95", "auroc", "f1", "presisi",
                                                                                 "recall", "akurasi", "lift_top_0_1pct", "menang", "p_vs_terbaik",
                                                                                 "setara_dengan_terbaik")} for x in rows]}
            if r.get("penjelas"):
                ex = [{"metode": m["metode"], "deletion_auc": _r(m["deletion_auc"]), "detik_per_klaim": _r(m["detik_per_klaim"], 3),
                       "stabilitas": _r(m.get("stabilitas")), "kesepakatan_treeshap": _r(m.get("kesepakatan_treeshap")), "keterangan": m.get("keterangan")}
                      for m in r["penjelas"]["metode"]]
                t["hasil_id_penjelas"] = box.result(f"Perbandingan metode penjelasan · {r['label']}", ex, meta={"kind": "ml_explainers", "task": task})
                t["penjelas"] = [{k: e[k] for k in ("metode", "deletion_auc", "stabilitas")} for e in ex]
            if r.get("kepentingan_global"):
                imp = [{"fitur": g["label"], "penurunan_auprc": _r(g["penurunan_auprc"])} for g in r["kepentingan_global"][:12]]
                t["hasil_id_fitur"] = box.result(f"Fitur terpenting (permutation importance) · {r['label']}", imp,
                                                 meta={"kind": "ml_importance", "task": task, "metric": "penurunan_auprc"})
                t["fitur_teratas"] = [g["fitur"] for g in imp[:5]]
            if r.get("temporal"):
                t["temporal"] = {"batas_uji": r["temporal"].get("batas_uji"), "positif_uji": r["temporal"].get("positif_uji"),
                                 **{m: {k: _r(v[k]) for k in ("auprc", "auroc", "f1", "presisi", "recall") if k in v} for m, v in r["temporal"]["model"].items()}}
            out["tugas"][task] = t
        ev = c.get("bukti") or {}
        if ev:
            out["kartu_bukti"] = {"kapasitas": ev.get("kapasitas"), "catatan_kapasitas": ev.get("catatan_kapasitas"),
                                          "tidak_berlaku": ev.get("tidak_berlaku"),
                                          "kebocoran_di_atas_0_8": [f"{x['feature']} {_r(x['auc'], 3)}: {x.get('penjelasan') or 'belum dijelaskan'}"
                                                                    for x in ev.get("kebocoran_di_atas_0_8") or []]}
            for name, card in (ev.get("kartu") or {}).items():
                h, cond = card["kartu"]["headline"], card["kartu"]["conditions"]
                out["kartu_bukti"][name] = {
                    "k": cond["k"], "prevalensi": _r(cond["prevalence"], 6), "precision_at_k": _r(h["precision"]),
                    "precision_ik95": [_r(h["precision_low"]), _r(h["precision_high"])], "tertangkap": h["caught"], "acak_diharapkan": h["random_expected"],
                    "lift": _r(h["lift"], 1), "recall_rupiah": _r(h.get("rupiah_recall")), "faskes_jujur_diaudit": h["honest_audit"],
                    "ablasi": [{"varian": a["variant"], "precision_at_k": _r(a["precision_at_k"]), "pr_auc": _r(a["pr_auc"]), "p_vs_sebelumnya": _r(a.get("p_value"))}
                               for a in card.get("ablasi") or []],
                    "negatif_sulit": [{"kelompok": n["kelompok"], "jujur_ditandai": n["jujur_ditandai"], "porsi": _r(n["porsi_jujur_ditandai"], 5)}
                                      for n in card.get("negatif_sulit") or []]}
        best = {k: v.get("terbaik") for k, v in out["tugas"].items()}
        return ({**out, "ringkasan": f"model {c.get('version')}: terbaik {best}" + ("; kartu bukti model tersedia" if ev else "")},
                {"request": {"endpoint": "GET /api/aip/ml"}, "links": [{"app": "model", "id": (c.get("model") or {}).get("model_id")}]})

    def skor_risiko_klaim_ml(provinsi: str, segmen: str, hanya_lolos_verifikasi: bool, batas: int) -> dict:
        """Klaim dengan peluang koreksi verifikasi tertinggi menurut model ML, dengan alasan (TreeSHAP). provinsi: nama
        atau kode ("" = semua); segmen: "rumah_sakit", "klinik_utama" atau ""; hanya_lolos_verifikasi=true → hanya klaim
        berisiko tinggi yang TIDAK dikoreksi verifikator (kandidat audit ulang); batas 1–50."""
        body = {"provinsi": provinsi or None, "segmen": segmen or None, "hanya_lolos_verifikasi": bool(hanya_lolos_verifikasi),
                "batas": max(1, min(int(batas or 20), 50))}
        r = p.post("/api/aip/ml/klaim", body)
        rows = r["klaim"]
        if _scope(box):  # Blu 3.0: the claims an agent may read row by row
            rows = [x for x in rows if str(x.get("klaim_id")) in box.lingkup["boleh"]]
        rid = box.result(f"Klaim berisiko menurut model ML{' · ' + provinsi if provinsi else ''}{' · lolos verifikasi' if hanya_lolos_verifikasi else ''}",
                         rows, types={"klaim_id": "string", "faskes_profil_id": "string", "provinsi": "string"},
                         meta={"kind": "ml_klaim", "metric": "risiko_pct", "label": "klaim_id", "filters": [body]})
        brief = [{k: x.get(k) for k in ("klaim_id", "nama_profil", "provinsi", "risiko_pct", "tingkat_risiko", "sudah_dikoreksi", "inacbg_kode", "alasan_utama")}
                 for x in rows[:6]]
        return ({"hasil_id": rid, "ditandai_dalam_cakupan": r["ditandai_dalam_cakupan"], "lolos_verifikasi_berisiko": r["lolos_verifikasi_berisiko"],
                 "klaim_teratas": brief, "jumlah_baris": len(rows),
                 "ringkasan": f"{len(rows)} klaim; {r['ditandai_dalam_cakupan']} ditandai di cakupan, {r['lolos_verifikasi_berisiko']} berisiko tinggi lolos verifikasi"},
                {"request": {"endpoint": "POST /api/aip/ml/klaim", "body": body}, "rows": len(rows)})

    def risiko_faskes_ml(provinsi: str, segmen: str, urut: str, batas: int) -> dict:
        """Profil faskes menurut model ML: ekspektasi koreksi (jumlah peluang), koreksi aktual, klaim ditandai, klaim
        berisiko tinggi yang lolos verifikasi, rasio aktual/ekspektasi. urut: ekspektasi_koreksi | risiko_per_1000_klaim |
        berisiko_lolos_verifikasi | rasio_aktual_ekspektasi | koreksi_aktual. provinsi/segmen "" = semua; batas 1–30."""
        body = {"provinsi": provinsi or None, "segmen": segmen or None, "urut": urut or "ekspektasi_koreksi", "batas": max(1, min(int(batas or 15), 30))}
        r = p.post("/api/aip/ml/faskes", body)
        rows = r["faskes"]
        rid = box.result(f"Faskes menurut model ML · urut {body['urut']}{' · ' + provinsi if provinsi else ''}", rows,
                         types={"faskes_profil_id": "string", "provinsi_kode": "string"},
                         meta={"kind": "ml_faskes", "metric": body["urut"], "label": "nama_profil", "filters": [body]})
        brief = [{k: x.get(k) for k in ("nama_profil", "provinsi", "klaim", "ekspektasi_koreksi", "koreksi_aktual", "klaim_ditandai",
                                        "berisiko_lolos_verifikasi", "rasio_aktual_ekspektasi")} for x in rows[:6]]
        return ({"hasil_id": rid, "total_cakupan": r["total"], "faskes_teratas": brief, "ringkasan": f"{len(rows)} profil faskes dari {r['total']['faskes']}"},
                {"request": {"endpoint": "POST /api/aip/ml/faskes", "body": body}, "rows": len(rows)})

    def jelaskan_klaim_ml(klaim_id: str) -> dict:
        """Jelaskan SATU klaim dengan beberapa metode sekaligus (TreeSHAP, KernelSHAP, LIME, oklusi, atau suku EBM):
        fitur pendorong risiko tiap metode dan seberapa sepakat metode-metode itu (irisan 3 fitur teratas)."""
        r = p.post("/api/aip/ml/jelaskan", {"klaim_id": klaim_id})
        main = r["metode"].get("treeshap") or r["metode"].get("ebm") or next(iter(r["metode"].values()))
        rid = box.result(f"Pendorong risiko klaim {klaim_id} ({'TreeSHAP' if 'treeshap' in r['metode'] else 'penjelas utama'})", main["fitur"],
                         types={"fitur": "string", "label": "string", "nilai": "string"}, meta={"kind": "ml_shap", "label": "label", "metric": "kontribusi"})
        cmp_rows = [{"metode": m, "fitur_teratas": ", ".join(f["label"] for f in v["fitur"][:3]), "detik": v["detik"]} for m, v in r["metode"].items()]
        rid2 = box.result(f"Penjelasan klaim {klaim_id} per metode", cmp_rows, meta={"kind": "ml_explain_compare"})
        return ({"hasil_id": rid, "hasil_id_perbandingan": rid2, "risiko_pct": r["risiko_pct"], "ditandai": r["ditandai"], "model": r["model"],
                 "per_metode": {m: [f"{f['label']} = {f['nilai']}" for f in v["fitur"][:3]] for m, v in r["metode"].items()},
                 "irisan_top3": r["irisan_top3"], "ringkasan": f"klaim {klaim_id}: risiko {r['risiko_pct']}% ({len(r['metode'])} metode)"},
                {"request": {"endpoint": "POST /api/aip/ml/jelaskan", "body": {"klaim_id": klaim_id}}})

    def benchmark_ml(tugas: str, model_csv: str, lipatan: int, provinsi_kode: int) -> dict:
        """Jalankan benchmark teknik ML BARU sekarang (beberapa menit): tugas "rumah_sakit" (sulit, label langka) atau
        "semua"; model_csv: daftar dipisah koma dari Regresi logistik, Random Forest, Extra Trees, HistGradientBoosting,
        XGBoost, LightGBM, CatBoost, MLP, EBM ("" = semua); lipatan 2–5 (validasi silang per faskes); provinsi_kode 0 = semua.
        Pakai bila diminta membandingkan teknik pada cakupan tertentu; untuk angka model yang dipakai, cukup kartu_model_ml."""
        body = {"tugas": tugas or "rumah_sakit", "model": [m.strip() for m in (model_csv or "").split(",") if m.strip()] or None,
                "lipatan": max(2, min(int(lipatan or 3), 5)), "provinsi_kode": int(provinsi_kode) if provinsi_kode else None}
        job = p.post("/api/aip/ml/benchmark", body)
        t0 = time.time()
        while job["status"] == "running" and time.time() - t0 < BENCH_WAIT:
            time.sleep(5)
            job = p.get(f"/api/aip/ml/jobs/{job['id']}")
            if job.get("log"):
                emit({"type": "progress", "agent": agent, "tool": "benchmark_ml", "text": job["log"][-1][:200]})
        if job["status"] != "succeeded":
            raise RuntimeError(job.get("error") or f"benchmark masih berjalan (job {job['id']}); hasilnya bisa dilihat nanti")
        res = job["result"]
        rid, rows = _board_result(f"Benchmark baru · {res['tugas_label']}{' · provinsi ' + str(body['provinsi_kode']) if body['provinsi_kode'] else ''}",
                                  res["papan"], res["tugas"], next((x["model"] for x in res["papan"] if not x["pembanding"]), None))
        return ({"hasil_id": rid, "job": job["id"], "evaluasi": res["evaluasi"], "lipatan": res["lipatan"], "detik": res["detik"],
                 "papan": [{k: v for k, v in x.items() if k in ("model", "pembanding", "auprc", "auprc_ci95", "auroc", "f1", "presisi", "recall")} for x in rows],
                 "ringkasan": f"benchmark {res['tugas']} {res['lipatan']} lipatan: {len(rows)} teknik dalam {res['detik']:.0f} s"},
                {"request": {"endpoint": "POST /api/aip/ml/benchmark", "body": body}, "rows": len(rows)})


    def kartu_bukti_model(kartu: str) -> dict:
        """Kartu bukti model yang dipakai, dengan ukuran kit evaluasi eksternal: kartu "rumah_sakit" atau "semua".
        precision@k pada kapasitas audit (asumsi 0,1% klaim) dengan IK 95% per faskes, lift, recall rupiah, profil
        faskes jujur yang ikut diaudit (keseluruhan dan per kelas faskes), ablasi berpasangan vs aturan, uji permutasi,
        negatif sulit, kebocoran, dan apa yang tidak berlaku di data nyata. Skor out-of-fold, prevalensi nyata."""
        c = p.get("/api/aip/ml")
        ev = c.get("bukti") or {}
        if not ev:
            raise RuntimeError("kartu bukti belum dibuat untuk versi model ini (admin: tombol 'Buat kartu bukti' di ML Studio → Eksperimen & evaluasi)")
        name = kartu if kartu in (ev.get("kartu") or {}) else "rumah_sakit"
        card = ev["kartu"][name]
        h, cond = card["kartu"]["headline"], card["kartu"]["conditions"]
        label = {"semua": "semua klaim FKRTL", "rumah_sakit": "klaim rumah sakit"}.get(name, name)
        head = [{"ukuran": "precision@k", "nilai": _r(h["precision"]), "ik95": f"{_r(h['precision_low'], 3)}–{_r(h['precision_high'], 3)}"},
                {"ukuran": "klaim terkoreksi di daftar audit", "nilai": h["caught"], "ik95": f"{h['caught_low']}–{h['caught_high']}"},
                {"ukuran": "harapan bila acak", "nilai": h["random_expected"], "ik95": None},
                {"ukuran": "lift vs acak", "nilai": _r(h["lift"], 1), "ik95": None},
                {"ukuran": "recall rupiah@k", "nilai": _r(h.get("rupiah_recall")), "ik95": None},
                {"ukuran": "profil faskes jujur diaudit", "nilai": _r(h["honest_audit"]["rate"]), "ik95": f"{h['honest_audit']['flagged']}/{h['honest_audit']['honest']}"}]
        r1 = box.result(f"Kartu bukti model · {label} · k = {cond['k']:,} klaim".replace(",", "."), head, meta={"kind": "ml_evidence_head", "card": name})
        abl = [{"varian": a["variant"], "precision_at_k": _r(a["precision_at_k"]), "ik95": f"{_r(a['ci_low'], 3)}–{_r(a['ci_high'], 3)}",
                "pr_auc": _r(a["pr_auc"]), "perubahan": _r(a.get("diff")), "p": _r(a.get("p_value"))} for a in card.get("ablasi") or []]
        r2 = box.result(f"Ablasi vs aturan · {label}", abl, meta={"kind": "ml_evidence_ablation", "card": name, "metric": "precision_at_k", "label": "varian"})
        hard = [{"kelompok": n["kelompok"], "porsi_jujur_ditandai": _r(n["porsi_jujur_ditandai"], 6), "jujur_ditandai": n["jujur_ditandai"],
                 "klaim_jujur": n["jujur"], "rasio_vs_rata": _r(n["porsi_jujur_ditandai"] / n["porsi_ditandai_keseluruhan"], 2) if n["porsi_ditandai_keseluruhan"] else None}
                for n in card.get("negatif_sulit") or []]
        r3 = box.result(f"Negatif sulit · {label}", hard, meta={"kind": "ml_evidence_hard", "card": name, "metric": "porsi_jujur_ditandai", "label": "kelompok"})
        strata = sorted([s for s in card["kartu"].get("strata") or [] if s["stratum"] == "kelas" and s["honest_groups"] >= 10], key=lambda s: -s["rate"])[:12]
        r4 = box.result(f"Profil faskes jujur yang ikut diaudit per kelas · {label}",
                        [{"kelas": s["value"], "porsi_diaudit": _r(s["rate"]), "diaudit": s["flagged"], "faskes_jujur": s["honest_groups"]} for s in strata],
                        meta={"kind": "ml_evidence_strata", "card": name, "metric": "porsi_diaudit", "label": "kelas"}) if strata else None
        perm = card["kartu"].get("permutation") or {}
        return ({"kartu": name, "hasil_id": [r for r in (r1, r2, r3, r4) if r], "kapasitas": ev.get("kapasitas"), "catatan_kapasitas": ev.get("catatan_kapasitas"),
                 "utama": head, "ablasi": abl, "negatif_sulit": hard[:5], "uji_permutasi": {k: _r(perm.get(k)) for k in ("observed", "null_mean", "p_value")},
                 "kebocoran_di_atas_0_8": [f"{x['feature']} {_r(x['auc'], 3)}: {x.get('penjelasan') or 'belum dijelaskan'}" for x in ev.get("kebocoran_di_atas_0_8") or []],
                 "tidak_berlaku": ev.get("tidak_berlaku"),
                 "catatan": "kalimat juri bawaan kit menyebut positif 'fraud'; di data ini positif = dikoreksi verifikator, bukan fraud terbukti",
                 "ringkasan": f"kartu bukti {label}: precision@k {_r(h['precision'], 3)}, lift {_r(h['lift'], 0)}x"},
                {"request": {"endpoint": "GET /api/aip/ml"}, "links": [{"app": "ml", "file": f"bukti_{name}.html"}]})

    def _technique_tool(t: dict, key: str, body: dict, jobs: dict) -> Callable[..., Any]:
        async def jalankan_teknik(catatan: str) -> dict:
            """Jalankan validasi silang teknik ini pada cakupan yang ditetapkan Agen ML (job di server: lipatan
            dikelompokkan per faskes, bertingkat per kelas, prevalensi nyata dibobot balik), lalu kembalikan metriknya
            dan rujukan risetnya. catatan: boleh kosong."""
            import asyncio

            job = await asyncio.to_thread(p.post, "/api/aip/ml/benchmark", {**body, "model": [t["technique"]], "pembanding": False})
            t0, last = time.time(), ""
            while job["status"] == "running" and time.time() - t0 < BENCH_WAIT:
                await asyncio.sleep(4)
                job = await asyncio.to_thread(p.get, f"/api/aip/ml/jobs/{job['id']}")
                line = (job.get("log") or [""])[-1]
                if line and line != last:
                    emit({"type": "progress", "agent": key, "tool": "jalankan_teknik", "text": line[:200]})
                    last = line
            if job["status"] != "succeeded":
                raise RuntimeError(job.get("error") or f"job {job['id']} belum selesai")
            jobs[t["technique"]] = job["id"]
            r = job["result"]["papan"][0]
            m, ci = r["rata"], (r.get("gabungan_oof") or {}).get("ci95") or {}
            out = {"teknik": r["model"], "keluarga": r.get("keluarga"), "job": job["id"], "evaluasi": job["result"].get("evaluasi"),
                   "lipatan": job["result"].get("lipatan"), "ulangan": job["result"].get("ulangan"),
                   **{k: {"rata": _r(m[k]["mean"]), "sd": _r(m[k]["sd"])} for k in ("auprc", "auroc", "f1", "presisi", "recall", "akurasi_seimbang")
                      if k in m},
                   "lift_top_0_1pct": _r(m.get("lift_top_0_1pct", {}).get("mean"), 1), "auprc_ik95": [_r(v) for v in ci.get("auprc", [])],
                   "detik_latih": _r(r.get("detik_latih"), 1),
                   "riset": [{"rujukan": f"{x['penulis']} ({x['tahun']})", "judul": x["judul"], "temuan": x.get("temuan"), "sumber": x.get("sumber")}
                             for x in r.get("riset") or []]}
            return ({**out, "ringkasan": f"{r['model']}: AUPRC {out['auprc']['rata']} ± {out['auprc']['sd']}"},
                    {"request": {"endpoint": "POST /api/aip/ml/benchmark", "body": {**body, "model": [t["technique"]]}}})
        return box.wrap_async(key, "jalankan_teknik", jalankan_teknik)

    SUB_TEXT = """Anda {name}: sub-agen yang dibentuk Agen Machine Learning untuk menguji SATU teknik, {technique} ({family}).
Panggil jalankan_teknik sekali (validasi silang di server), lalu tulis laporan untuk Agen ML, paling banyak 8 baris:
- AUPRC rata-rata ± simpangan dan IK 95%, AUROC, F1, presisi, recall, akurasi seimbang, lift di 0,1% teratas, waktu
  latih: angka persis dari hasil tool;
- apa kata riset tentang teknik ini untuk deteksi fraud asuransi kesehatan (rujukan dari hasil tool, sebut penulis-tahun);
- kekuatan dan kelemahan yang terlihat di angka (mis. presisi tinggi tetapi recall rendah, simpangan antar-lipatan besar).
Jangan mengarang angka. Jawab dalam Bahasa Indonesia."""

    async def bentuk_sub_agen_teknik(teknik_csv: str, tugas: str, lipatan: int, provinsi_kode: int) -> dict:
        """Bentuk sub-agen, satu per teknik ML, yang bekerja paralel: tiap sub-agen menjalankan validasi silang tekniknya
        sendiri (lipatan yang SAMA untuk semua, sehingga hasilnya berpasangan) dan melaporkan metrik serta rujukan risetnya;
        lalu semua teknik dibandingkan dengan t-test resampel terkoreksi. teknik_csv: nama teknik dipisah koma dari
        Regresi logistik, Random Forest, Extra Trees, HistGradientBoosting, XGBoost, LightGBM, CatBoost, MLP, EBM
        ("" = semua sembilan); tugas: "rumah_sakit" atau "semua"; lipatan 2–5; provinsi_kode 0 = semua provinsi."""
        from google.adk.agents import LlmAgent, ParallelAgent

        if box.spawn is None or box.llm is None:
            raise RuntimeError("runtime ini tidak bisa membentuk sub-agen")
        catalogue = {s["technique"].lower(): s for s in box.agents[agent].get("subagents") or []}
        wanted = [x.strip().lower() for x in (teknik_csv or "").split(",") if x.strip()] or list(catalogue)
        unknown = [x for x in wanted if x not in catalogue]
        if unknown:
            raise LookupError(f"teknik tidak dikenal: {', '.join(unknown)}; pilihan: {', '.join(s['technique'] for s in catalogue.values())}")
        chosen = [catalogue[x] for x in dict.fromkeys(wanted)][:9]
        if len(chosen) < 2:
            raise ValueError("bentuk setidaknya dua sub-agen agar tekniknya bisa dibandingkan")
        body = {"tugas": tugas or "rumah_sakit", "lipatan": max(2, min(int(lipatan or 3), 5)), "ulangan": 1,
                "provinsi_kode": int(provinsi_kode) if provinsi_kode else None}
        jobs: dict[str, str] = {}
        subs = [LlmAgent(name=s["key"], model=box.llm(s["key"]), instruction=SUB_TEXT.format(**s), tools=[_technique_tool(s, s["key"], body, jobs)],
                         output_key=f"laporan_{s['key']}") for s in chosen]
        emit({"type": "subagents", "parent": agent, "agents": [{k: s[k] for k in ("key", "name", "technique", "family")} for s in chosen], "body": body})
        state = await box.spawn(ParallelAgent(name="sub_agen_ml", sub_agents=subs), f"Uji teknik Anda pada {body}", SUB_CALLS * len(subs))
        reports = {s["technique"]: (state.get(f"laporan_{s['key']}") or "(tidak ada laporan)")[:1500] for s in chosen}
        emit({"type": "subagents_done", "parent": agent, "agents": [s["key"] for s in chosen], "jobs": jobs})
        out: dict[str, Any] = {"sub_agen": [s["name"] for s in chosen], "kondisi": body, "laporan": reports}
        rid = None
        if len(jobs) >= 2:
            import asyncio

            cmp = await asyncio.to_thread(p.post, "/api/aip/ml/bandingkan", {"job_ids": list(jobs.values())})
            rid, rows = _board_result(f"Benchmark sub-agen · {cmp['tugas_label']}" + (f" · provinsi {body['provinsi_kode']}" if body["provinsi_kode"] else ""),
                                      cmp["papan"], cmp["tugas"], cmp["papan"][0]["model"])
            out.update(hasil_id=rid, uji=cmp["uji"], papan=[{k: v for k, v in x.items() if k in ("model", "auprc", "auprc_ci95", "auroc", "f1", "presisi",
                                                                                                   "recall", "menang", "p_vs_terbaik", "setara_dengan_terbaik")}
                                                         for x in rows])
        missing = [s["technique"] for s in chosen if s["technique"] not in jobs]
        if missing:
            out["gagal"] = missing
        return ({**out, "ringkasan": f"{len(chosen)} sub-agen, {len(jobs)} teknik selesai" + (f"; teratas {out['papan'][0]['model']}" if out.get("papan") else "")},
                {"request": {"endpoint": "POST /api/aip/ml/benchmark x" + str(len(chosen)) + " + /api/aip/ml/bandingkan", "body": body}})

    def verifikasi_klaim(klaim_id: str) -> dict:
        """Verifikasi SATU klaim lewat pipeline inferensi (POST /verify): model ML terpasang (model.pkl, pickle) memberi
        peluang koreksi dan alasannya (TreeSHAP), lalu LLM menelaah catatan klinisnya (diagnosis masuk/utama, prosedur,
        keparahan INA-CBG, lama rawat dibanding median/p90 kodenya, tarif tambahan) dan menulis mengapa klaim itu wajar
        atau mencurigakan, dengan dokumen yang perlu diperiksa. Status: INDIKASI_KUAT, PERLU_DIPERIKSA atau WAJAR.
        klaim_id: "<edisi>:<kunjungan_fkrtl_id>" (mis. dari skor_risiko_klaim_ml atau cari_objek) — hanya klaim yang ada di
        data; klaim BARU (JSON yang ditempel pengguna) pakai verifikasi_klaim_baru."""
        _claim_in_scope(box, klaim_id)
        r = p.post("/api/aip/fraud/v1/verify/klaim", {"klaim_id": klaim_id})
        tl = (r.get("analisis_medis") or {}).get("telaah") or {}
        row = {"klaim_id": r["klaim_id"], "status": r["status"], "peluang_koreksi_pct": round(100 * r["fraud_probability"], 4),
               "ditandai_model": r["ml"]["ditandai_model"], "model": f"{r['ml']['model']} · {r['ml']['mesin']}", "telaah_klinis": tl.get("label"),
               "ringkasan": r["ai_reasoning"], "kejanggalan": "; ".join(tl.get("kejanggalan") or []), "penjelasan_wajar": "; ".join(tl.get("penjelasan_wajar") or []),
               "dokumen_diperiksa": "; ".join(tl.get("dokumen_diperiksa") or []), "gerbang_angka": "lolos" if tl.get("lolos_gerbang_angka") else "tidak lolos"}
        rid = box.result(f"Verifikasi klaim {klaim_id} (model + telaah klinis LLM)", [row], types={"klaim_id": "string"}, meta={"kind": "verify"})
        return ({"hasil_id": rid, "status": r["status"], "status_label": r["status_label"], "peluang_koreksi_pct": row["peluang_koreksi_pct"],
                 "alasan_model": r["ml"].get("alasan_teks"), "telaah_klinis": {k: tl.get(k) for k in ("label", "ringkasan", "alasan_klinis", "kejanggalan",
                                                                                                      "penjelasan_wajar", "dokumen_diperiksa", "keyakinan")},
                 "di_luar_prompt": r.get("di_luar_prompt"), "pipeline": [f"{x['tahap']} {x['ms']} ms" for x in r.get("pipeline") or []],
                 "ringkasan": f"{klaim_id}: {r['status']} (model {row['peluang_koreksi_pct']}%, klinis {tl.get('label') or '-'})"},
                {"request": {"endpoint": "POST /api/aip/fraud/v1/verify/klaim", "body": {"klaim_id": klaim_id}}, "rid": rid, "rows": 1})

    def verifikasi_klaim_baru(klaim_json: str) -> dict:
        """Verifikasi SATU klaim BARU yang tidak ada di data (mis. ditempel pengguna sebagai JSON) lewat pipeline inferensi
        POST /verify — model ML, aturan lapisan semantik, telaah klinis LLM — dalam format juri (claim_id, patient_age,
        ina_cbg_code, primary_diagnosis, claimed_cost, real_cost, length_of_stay_days, clinical_notes) atau kontrak klaim
        lengkap (kunjungan_fkrtl_id, …). Jangan mencari klaim baru di data: ia tidak ada di sana. klaim_json: objek JSON-nya."""
        try:
            claim = json.loads(klaim_json)
        except ValueError as e:
            raise ValueError(f"klaim_json bukan JSON: {e}") from e
        if not isinstance(claim, dict):
            raise ValueError("klaim_json harus satu objek JSON (satu klaim)")
        return verify_new(box, claim)

    fns = [kartu_model_ml, kartu_bukti_model, skor_risiko_klaim_ml, risiko_faskes_ml, jelaskan_klaim_ml, verifikasi_klaim, verifikasi_klaim_baru] + \
        ([] if read_only else [benchmark_ml])
    tools = [box.wrap(agent, f.__name__, f) for f in fns]
    if not read_only:
        tools.insert(2, box.wrap_async(agent, "bentuk_sub_agen_teknik", bentuk_sub_agen_teknik))
    return tools


def verify_new(box: Toolbox, claim: dict) -> tuple[dict, dict]:
    """A new claim (not in the data) through the inference pipeline (POST /verify): the judges' flat format or the claims
    contract. Its answer as a result (hasil_id) the answer cites and the validator reads, with the claim's own numbers."""
    body = {k: v for k, v in claim.items() if k not in ("pendapat_kedua", "mesin")}
    r = box.p.post("/api/aip/fraud/v1/verify", body)
    tl = (r.get("analisis_medis") or {}).get("telaah") or {}
    cid = str(claim.get("claim_id") or claim.get("kunjungan_fkrtl_id") or r.get("klaim_id"))
    row = {"klaim_id": cid, "status": r["status"], "peluang_koreksi_pct": round(100 * r["fraud_probability"], 4), "ditandai_model": r["ml"]["ditandai_model"],
           "model": f"{r['ml']['model']} · {r['ml']['mesin']}", "telaah_klinis": tl.get("label"), "keyakinan": tl.get("keyakinan"), "ringkasan": r["ai_reasoning"],
           "kejanggalan": "; ".join(tl.get("kejanggalan") or []), "penjelasan_wajar": "; ".join(tl.get("penjelasan_wajar") or []),
           "dokumen_diperiksa": "; ".join(tl.get("dokumen_diperiksa") or []), "tag_aturan": "; ".join(f"{t.get('label')} ({t.get('bukti')})" for t in r.get("indikasi") or []),
           "gerbang_angka": "lolos" if tl.get("lolos_gerbang_angka") else "tidak lolos",
           **{k: claim[k] for k in ("patient_age", "ina_cbg_code", "primary_diagnosis", "claimed_cost", "real_cost", "length_of_stay_days") if k in claim}}
    rid = box.result(f"Verifikasi klaim baru {cid} (pipeline /verify: model + aturan + telaah klinis LLM)", [row],
                     types={"klaim_id": "string", "ina_cbg_code": "string", "primary_diagnosis": "string"}, meta={"kind": "verify"})
    return ({"hasil_id": rid, "klaim_id": cid, "status": r["status"], "status_label": r["status_label"], "peluang_koreksi_pct": row["peluang_koreksi_pct"],
             "arti_peluang": r.get("arti_probabilitas"), "alasan_model": r["ml"].get("alasan_teks"), "tag_aturan": row["tag_aturan"],
             "telaah_klinis": {k: tl.get(k) for k in ("label", "ringkasan", "alasan_klinis", "kejanggalan", "penjelasan_wajar", "dokumen_diperiksa", "keyakinan")},
             "peringatan": r.get("peringatan") or [], "ringkasan": f"{cid}: {r['status']} (model {row['peluang_koreksi_pct']}%, klinis {tl.get('label') or '-'})"},
            {"request": {"endpoint": "POST /api/aip/fraud/v1/verify", "body": body}, "rid": rid, "rows": 1})


PACK_SCOPE = ("provinsi", "kabkota", "faskes", "inacbg_kode", "diagnosis", "modus", "flag", "tipe_fkrtl", "kelas_rawat", "bulan_dari", "bulan_sampai",
              "kelompok")
BOX_TYPE = "Karantina Faskes (AI Agent Swarm)"


def _rp(v: Any) -> str:
    return "Rp " + f"{float(v or 0):,.0f}".replace(",", ".")


def _id(v: Any) -> str:
    """A number in Indonesian notation (1.093; 3,7)."""
    if isinstance(v, float) and not v.is_integer():
        return f"{v:,.1f}".replace(",", "_").replace(".", ",").replace("_", ".")
    return f"{int(v or 0):,}".replace(",", ".")


def audit_pack(box: Toolbox, agent: str, scope: dict) -> tuple[dict, dict]:
    """The audit pack of a scope (POST /api/aip/karantina/paket): every part a result of this run — for the screen and the
    writer's citations — and the text the writer works from, every figure in it computed by code."""
    body = {k: v for k, v in (scope or {}).items() if k in PACK_SCOPE and v not in (None, "", [])}
    r = box.p.post("/api/aip/karantina/paket", body)
    types = {t["name"]: t for t, _ in box.types.values()}
    rids: dict[str, str] = {}
    for part in r["bagian"]:
        rows, g = part["baris"], part.get("kelompok")
        if part["jenis"] == "agg" and g:
            keys = [x["group"] for x in rows]
            where = box.geo(g, keys) if g in ("provinsi_kode", "kabkota_kode") else {}
            names = box.labels(g, keys) if g == "inacbg_kode" else {}
            rows = [{**({"nama": names[str(x["group"])]} if str(x["group"]) in names else {}), **x,
                     **({"lokasi": where[str(x["group"])]} if str(x["group"]) in where else {})} for x in rows]
            meta = {"kind": "agg", "group": g, "metric": "count", "prop": None, "type": CLAIMS_TYPE, "filters": r["filter"]}
        elif part["jenis"] == "objects":
            meta = {"kind": "objects", "type": part.get("tipe"), "total": len(rows), "filters": r["filter"]}
        else:
            meta = {"kind": "kpi", "type": CLAIMS_TYPE, "filters": r["filter"]}
        rids[part["kunci"]] = box.result(part["judul"], rows, types.get(part.get("tipe") or CLAIMS_TYPE), None, meta)
    firm = r.get("konsultan") or {}
    notes = [{"sumber": f"laporan analis {x['agen']}", "teks": x["laporan"]} for x in firm.get("laporan_analis") or []] + \
        [{"sumber": f"rekomendasi penyidik · {x['faskes']}", "teks": f"jalur {x['jalur']} (kelompok {x['kelompok']}; {x['tsm']}): {x['alasan']}"}
         for x in firm.get("rekomendasi_jalur") or []] + \
        [{"sumber": f"laporan penugasan · {x['bagian']}", "teks": x["teks"]} for x in firm.get("bagian_laporan") or []]
    if notes:
        rids["konsultan"] = box.result(f"Temuan AI Agent Swarm (penugasan {firm.get('run')})", notes, types.get(BOX_TYPE), None, {"kind": "other"})
        box.quoted += "\n".join(n["teks"] for n in notes)  # figures the consultancy wrote: the writer may repeat them, as theirs
    parts = {p["kunci"]: p for p in r["bagian"]}
    k = parts["ringkasan"]["baris"][0]
    # a scope cut by flags: its claims are the flagged part of the scope's risky claims, said so (paket.build)
    size = (f"{_id(k['klaim'])} klaim {k['flag']} dari {_id(k['klaim_berisiko_cakupan'])} klaim berisiko di cakupan ini "
            f"({_id(k['porsi_flag_cakupan_pct'])}%; {_id(k['porsi_nasional_pct'])}% dari {_id(k['klaim_nasional'])} klaim {k['flag']} nasional)"
            if k.get("flag") else f"{_id(k['klaim'])} klaim berisiko ({_id(k['porsi_nasional_pct'])}% dari {_id(k['klaim_nasional'])} nasional)")
    lines = [f"[{rids['ringkasan']}] Ringkasan ({r['cakupan']['teks']}): {size}; "
             f"{_id(k['klaim_bertag'])} klaim bertag indikasi ({_id(k['porsi_bertag_pct'])}%); {_id(k['faskes'])} faskes, "
             f"{_id(k['faskes_di_karantina'])} di Box Karantina; estimasi kerugian {_rp(k['estimasi_kerugian_rp'])} ({_id(k['porsi_kerugian_nasional_pct'])}% "
             f"dari estimasi nasional {_rp(k['estimasi_kerugian_nasional_rp'])}); sudah dikoreksi verifikator {_rp(k['sudah_dikoreksi_rp'])} dari "
             f"{_id(k['klaim_dikoreksi'])} klaim; tagihan {_rp(k['biaya_tagih_rp'])}, dibayar {_rp(k['biaya_verifikasi_rp'])} (koreksi {_id(k['rasio_koreksi_pct'])}%); "
             f"LOS ekstrem {_id(k['klaim_los_ekstrem'])}, readmisi 30 hari {_id(k['klaim_readmisi_30'])}, calon klaim ganda {_id(k['klaim_calon_ganda'])}; "
             f"skor risiko rata-rata {_id(k['skor_risiko_rata'])}"
             + (f"; peringkat provinsi {k['peringkat_provinsi']} dari {k['jumlah_provinsi']} ({_id(k['kali_rata_provinsi'])} kali rata-rata "
                f"{_id(k['rata_klaim_per_provinsi'])} klaim {k.get('flag') or 'berisiko'} per provinsi)" if k.get("peringkat_provinsi") else "") + "."]

    def top(key: str, label: str, n: int = 6) -> None:
        if key in parts and parts[key]["baris"]:
            rows = parts[key]["baris"]
            say = lambda x: (f"{x.get('nama') or x['group']} {_id(x['value'])} {label} ({_id(x.get('porsi_klaim_pct', 0))}%), "  # noqa: E731
                             f"estimasi {_rp(x.get('estimasi_kerugian_rp'))}, sudah dikoreksi {_rp(x.get('sudah_dikoreksi_rp'))} "
                             f"(koreksi {_id(x.get('rasio_koreksi_pct', 0))}% tagihan), readmisi {_id(x.get('readmisi_30_pct', 0))}%, "
                             f"LOS ekstrem {_id(x.get('los_ekstrem_pct', 0))}%, indikasi utama {x.get('indikasi_utama', '-')}"
                             + "".join(f", {k.replace('_teratas', '')} teratas {v}" for k, v in x.items() if k.endswith("_teratas")))
            common = [x for x in sorted(rows, key=lambda x: -x["value"])[:3] if x not in rows[:n]]
            corrected = [x for x in sorted((x for x in rows if x["value"] >= 10), key=lambda x: -x.get("rasio_koreksi_pct", 0))[:3]
                         if x not in rows[:n] and x not in common]
            lines.append(f"[{rids[key]}] {parts[key]['judul']} — teratas menurut estimasi kerugian: " + "; ".join(say(x) for x in rows[:n])
                         + ("; terbanyak klaim: " + "; ".join(say(x) for x in common) if common else "")
                         + ("; koreksi tertinggi (≥ 10 klaim): " + "; ".join(say(x) for x in corrected) if corrected else "") + ".")

    top("wilayah", "klaim")
    if parts.get("modus", {}).get("baris"):
        lines.append(f"[{rids['modus']}] {parts['modus']['judul']}: " + "; ".join(
            f"{x['group']} {_id(x['value'])} tag (kuat {_id(x.get('kuat', 0))}, sedang {_id(x.get('sedang', 0))}, lemah {_id(x.get('lemah', 0))})"
            for x in parts["modus"]["baris"][:8]) + ".")
    if parts.get("faskes", {}).get("baris"):
        lines.append(f"[{rids['faskes']}] {parts['faskes']['judul']}: " + "; ".join(
            f"#{x['prioritas']} {x['nama']} ({x.get('kabkota') or '-'}): Box Karantina kelompok {x['kelompok_karantina']}, status {x['status']}, jalur awal "
            f"{x['jalur_awal']}, TSM {x['tsm']}, estimasi kerugian faskes {_rp(x.get('estimasi_kerugian_faskes_rp'))}; di cakupan ini {_id(x['value'])} klaim, "
            f"estimasi {_rp(x['estimasi_kerugian_rp'])}, sudah dikoreksi {_rp(x['sudah_dikoreksi_rp'])}, readmisi {_id(x.get('readmisi_30_pct', 0))}%, "
            f"LOS ekstrem {_id(x.get('los_ekstrem_pct', 0))}%, indikasi utama {x.get('indikasi_utama', '-')}; modus faskes: {x['modus_faskes']}"
            for x in parts["faskes"]["baris"][:6]) + ".")
    if parts.get("tren", {}).get("baris"):
        t = parts["tren"]["baris"]
        peak = max(t, key=lambda x: x["value"])
        lines.append(f"[{rids['tren']}] Per bulan: {len(t)} bulan, {t[0]['group']} {_id(t[0]['value'])} klaim → {t[-1]['group']} {_id(t[-1]['value'])} klaim; "
                     f"puncak {peak['group']} ({_id(peak['value'])} klaim, estimasi {_rp(peak['estimasi_kerugian_rp'])}); 6 bulan terakhir: "
                     + "; ".join(f"{x['group']} {_id(x['value'])} klaim, tagihan {_rp(x.get('biaya_tagih_rp'))}, dibayar {_rp(x.get('biaya_verifikasi_rp'))}"
                                 for x in t[-6:]) + ".")
    top("kode", "klaim")
    top("diagnosis", "klaim", 5)
    if parts.get("kelas", {}).get("baris"):
        lines.append(f"[{rids['kelas']}] {parts['kelas']['judul']}: " + "; ".join(
            f"{x['group']} {_id(x['value'])} klaim berisiko dari {_id(x['klaim_fkrtl'])} klaim FKRTL ({_id(x['per_1000_klaim'] or 0)} per 1.000), "
            f"estimasi {_rp(x['estimasi_kerugian_rp'])}, indikasi utama {x['indikasi_utama']}" for x in parts["kelas"]["baris"]) + ".")
    if parts.get("kontributor", {}).get("baris"):
        lines.append(f"[{rids['kontributor']}] {parts['kontributor']['judul']} (teratas): " + "; ".join(
            f"{x['klaim_id']} di {x['faskes']} ({x['inacbg_kode']}, LOS {x['los_hari']} hari): dibayar {_rp(x['biaya_verifikasi_rp'])} vs median peer "
            f"{_rp(x['peer_biaya_p50_rp'])}, estimasi {_rp(x['estimasi_kerugian_rp'])} ({x['komponen']}; {x['indikasi']})" for x in parts["kontributor"]["baris"][:5]) + ".")
    if notes:
        lines.append(f"[{rids['konsultan']}] Temuan AI Agent Swarm (penugasan {firm.get('run')}, {firm.get('pada')}; kutip sebagai temuan AI Agent Swarm):\n"
                     + "\n".join(f"- {n['sumber']}: {n['teks']}" for n in notes))
    lines.append("Catatan data: " + "; ".join(r.get("catatan") or []) + ".")
    text = "\n".join(lines)
    modes = (parts.get("modus") or {}).get("baris") or []
    return ({"ringkasan": f"paket audit {r['cakupan']['teks']}: {_id(k['klaim'])} klaim, estimasi kerugian {_rp(k['estimasi_kerugian_rp'])}",
             "klaim": k["klaim"], "teks": text, "hasil": rids, "cakupan": r["cakupan"]["teks"], "kpi": k, "modus_utama": modes[0]["group"] if modes else "-",
             "faskes_ab": sum(x["kelompok_karantina"] in ("A", "B") for x in (parts.get("faskes") or {}).get("baris") or [])},
            {"request": {"endpoint": "POST /api/aip/karantina/paket", "body": body}, "rid": rids["ringkasan"], "rows": k["klaim"],
             "links": [{"app": "objects", "type_id": t["id"], "type": t["name"]} for t in (types.get(CLAIMS_TYPE), types.get(BOX_TYPE)) if t]})


def compare_packs(box: Toolbox, packs: list[dict]) -> tuple[str, str]:
    """Several scopes side by side (a comparison of provinces, modes, classes): one row per pack, every figure from its
    pack, as a result of the run (its ranking on the screen) and the line the writer compares from."""
    rows = [{"group": p["cakupan"], "value": p["kpi"]["klaim"], "porsi_nasional_pct": p["kpi"]["porsi_nasional_pct"],
             **({"flag": p["kpi"]["flag"], "klaim_berisiko_cakupan": p["kpi"]["klaim_berisiko_cakupan"]} if p["kpi"].get("flag") else {}),
             "estimasi_kerugian_rp": p["kpi"]["estimasi_kerugian_rp"], "sudah_dikoreksi_rp": p["kpi"]["sudah_dikoreksi_rp"],
             "rasio_koreksi_pct": p["kpi"]["rasio_koreksi_pct"], "klaim_los_ekstrem": p["kpi"]["klaim_los_ekstrem"],
             "los_ekstrem_pct": round(100 * p["kpi"]["klaim_los_ekstrem"] / p["kpi"]["klaim"], 1) if p["kpi"]["klaim"] else 0.0,
             "klaim_readmisi_30": p["kpi"]["klaim_readmisi_30"],
             "readmisi_30_pct": round(100 * p["kpi"]["klaim_readmisi_30"] / p["kpi"]["klaim"], 1) if p["kpi"]["klaim"] else 0.0,
             "faskes_kelompok_ab": p["faskes_ab"], "modus_utama": p["modus_utama"]} for p in packs]
    rid = box.result("Perbandingan cakupan (paket audit)", rows, None, None, {"kind": "agg", "group": "cakupan", "metric": "count", "prop": None, "type": CLAIMS_TYPE})
    line = f"[{rid}] Perbandingan cakupan: " + "; ".join(
        (f"{x['group']}: {_id(x['value'])} klaim {x['flag']} dari {_id(x['klaim_berisiko_cakupan'])} klaim berisiko cakupannya "
         f"({_id(x['porsi_nasional_pct'])}% dari klaim {x['flag']} nasional)" if x.get("flag") else
         f"{x['group']}: {_id(x['value'])} klaim ({_id(x['porsi_nasional_pct'])}% nasional)") + f", estimasi {_rp(x['estimasi_kerugian_rp'])}, sudah dikoreksi "
        f"{_rp(x['sudah_dikoreksi_rp'])} ({_id(x['rasio_koreksi_pct'])}% tagihan), LOS ekstrem {_id(x['klaim_los_ekstrem'])} ({_id(x['los_ekstrem_pct'])}%), "
        f"readmisi 30 hari {_id(x['klaim_readmisi_30'])} ({_id(x['readmisi_30_pct'])}%), faskes kelompok A/B {x['faskes_kelompok_ab']}, modus utama "
        f"{x['modus_utama']}" for x in rows) + "."
    return rid, line


def tools_for(box: Toolbox, a: dict) -> list[Callable]:
    """An agent's tools: the platform's for the Data agent, its objects' for a domain agent, plus the ML tools for the
    Machine Learning agent."""
    if box.owner_of.get(a["key"], a["key"]) == "data":  # (a small agent of the Data agent: its platform tools)
        return platform_tools(box, a["key"])
    tools = object_tools(box, a["key"])
    if "kartu_model_ml" in (a.get("tools") or []):
        tools += ml_tools(box, a["key"])
    return tools
