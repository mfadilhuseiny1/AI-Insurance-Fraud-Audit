"""JKN AIP agent with tools (demo): the agent of AIP Agent Studio JKN answers by calling tools that read the platform —
the Nexus (ontology), the audit pipeline and its builds, data lineage, the code repository, model benchmarks, AIP Logic
functions, the fraud engine — and returns its answer with the trace of every tool call.

Every tool calls the platform's own API over HTTP with the asking user's credentials, so the agent sees exactly what
that user may see: project roles and markings are checked by the same middleware as in the apps.

POST /api/demo/jkn/agent/ask  {q, history?}  →  {answer, steps: [{tool, args, summary, ms, view, ok}], model, ms}
GET  /api/demo/jkn/agent/tools               →  the tool catalogue
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/demo/jkn/agent", tags=["demo-jkn-agent"])

MODEL = "vertex/deepseek-ai/deepseek-v4.1-flash-maas"  # open model on Vertex AI (aip/models.py)
MAX_ROUNDS = 6
SYSTEM = """Anda adalah Audit Copilot JKN di AIP Agent Studio (BluesandAI). Jawab dalam bahasa Indonesia, ringkas dan tepat.
Selalu ambil fakta dengan tool sebelum menjawab — jangan mengarang angka, nama, id atau isi kode. Pilih tool sesuai pertanyaan:
- objek, faskes, klaim, dokter, temuan, relasi → search_nexus, describe_object_type, query_objects
- pipeline, transform, dataset keluaran, build → get_pipeline
- asal/alur data, hulu/hilir, dampak perubahan → trace_lineage
- kode, fungsi, transform Python → read_code
- performa model, recall, metrik, latensi → model_benchmark
- fungsi AIP Logic → list_logic_functions
- angka fraud, antrian pre-payment → fraud_summary; memeriksa satu klaim → check_claim
Boleh memanggil beberapa tool. Sebut sumbernya (tool apa) di jawaban. Data demo ini fiktif; jika data tidak ada atau akses
ditolak, katakan apa adanya."""


class AskIn(BaseModel):
    q: str = Field(min_length=1, max_length=2000)
    history: list[dict] = []


class Platform:
    """The platform API, called with the asking user's credentials (cookie or token, and the page's origin for writes)."""

    def __init__(self, request: Request):
        self.base = str(request.base_url).rstrip("/")
        self.headers = {k: v for k, v in (("cookie", request.headers.get("cookie")), ("authorization", request.headers.get("authorization")),
                                          ("origin", request.headers.get("origin")), ("referer", request.headers.get("referer"))) if v}
        self.client = httpx.Client(timeout=120, headers=self.headers)
        self._cache: dict[str, Any] = {}

    def get(self, path: str, **params: Any) -> Any:
        key = path + json.dumps(params, sort_keys=True)
        if key not in self._cache:
            r = self.client.get(self.base + path, params={k: v for k, v in params.items() if v is not None})
            if r.status_code >= 400:
                raise PermissionError(_detail(r)) if r.status_code in (401, 403) else RuntimeError(_detail(r))
            self._cache[key] = r.json()
        return self._cache[key]

    def post(self, path: str, body: dict) -> Any:
        r = self.client.post(self.base + path, json=body)
        if r.status_code >= 400:
            raise PermissionError(_detail(r)) if r.status_code in (401, 403) else RuntimeError(_detail(r))
        return r.json()

    def ids(self) -> dict:
        """The JKN demo's resources (pipeline, repositories, objective), as its builds recorded them."""
        if "ids" not in self._cache:
            e2e, models = {}, {}
            try:
                e2e = self.get("/api/demo/jkn/e2e")
            except Exception:  # noqa: BLE001
                pass
            try:
                models = self.get("/api/demo/jkn-models")
            except Exception:  # noqa: BLE001
                pass
            self._cache["ids"] = {"pipeline": e2e.get("pipeline_id"), "scoring_pipeline": e2e.get("scoring_pipeline_id"), "iot_pipeline": e2e.get("iot_pipeline_id"),
                                  "functions_repo": e2e.get("functions_repo_id"), "model_repo": models.get("repo_id"), "objective": models.get("objective_id"),
                                  "models": models}
        return self._cache["ids"]


def _detail(r: httpx.Response) -> str:
    try:
        return str(r.json().get("detail") or r.text)[:300]
    except Exception:  # noqa: BLE001
        return f"{r.status_code} {r.text[:200]}"


def _cut(s: Any, n: int = 160) -> str:
    s = "" if s is None else str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


# ------------------------------------------------------------------ tools

def search_nexus(p: Platform, query: str, k: int = 10) -> dict:
    hits = p.post("/api/orbis/search", {"q": query, "k": max(1, min(int(k), 20))}).get("hits", [])
    return {"hits": [{"label": h.get("label"), "kind": h.get("kind"), "id": h.get("id"), "score": round(h.get("score", 0), 3)} for h in hits]}


def _schema(p: Platform) -> dict:
    return p.get("/api/jkn-nexus/schema")


def _find_type(p: Platform, name: str) -> Optional[dict]:
    want = name.lower().strip()
    types = [n for n in _schema(p).get("nodes", []) if n.get("node_kind") == "object_type"]
    return next((t for t in types if t["name"].lower() == want), None) or next((t for t in types if want in t["name"].lower()), None) \
        or next((t for t in types if any(w in t["name"].lower() for w in want.split() if len(w) > 3)), None)


def describe_object_type(p: Platform, name: str) -> dict:
    t = _find_type(p, name)
    if not t:
        return {"error": f"tipe objek '{name}' tidak ditemukan", "tipe_tersedia": [n["name"] for n in _schema(p).get("nodes", []) if n.get("node_kind") == "object_type"]}
    sem = t.get("semantic") or {}
    edges = [e for e in _schema(p).get("edges", []) if t["id"] in (e.get("source"), e.get("target"))]
    names = {n["id"]: n["name"] for n in _schema(p).get("nodes", [])}
    return {"nama": t["name"], "id": t["id"], "kategori": t.get("category"), "jumlah_objek": t.get("object_count"), "arti": _cut(sem.get("verified_definition") or sem.get("interpretation"), 300),
            "properti": [{"nama": x.get("display_name") or x.get("api_name"), "api_name": x.get("api_name"), "tipe": x.get("type"), "deskripsi": _cut(x.get("ontology_description"), 120)} for x in sem.get("properties", [])[:40]],
            "relasi": [{"ke": names.get(e["target"] if e["source"] == t["id"] else e["source"]), "jenis": e.get("term") or e.get("edge_kind"), "nama": e.get("name"), "kardinalitas": e.get("cardinality")} for e in edges[:25]]}


def query_objects(p: Platform, object_type: str, search: str = "", limit: int = 10) -> dict:
    t = _find_type(p, object_type)
    if not t:
        return {"error": f"tipe objek '{object_type}' tidak ditemukan"}
    r = p.get("/api/jkn-nexus/instances", type_id=t["id"], q=search or "", limit=max(1, min(int(limit), 25)))
    return {"tipe": t["name"], "total": r.get("total"), "objek": [{"id": o.get("primary_key"), "judul": o.get("title"),
            "properti": {k: v for k, v in (o.get("properties") or {}).items() if v not in (None, "", [])}} for o in r.get("objects", [])]}


def get_pipeline(p: Platform, which: str = "audit") -> dict:
    ids = p.ids()
    pid = {"scoring": ids.get("scoring_pipeline"), "iot": ids.get("iot_pipeline")}.get(which, ids.get("pipeline"))
    if not pid:
        return {"error": "pipeline JKN tidak ditemukan"}
    f = p.get(f"/api/pipeline/files/{pid}")
    c, item = f.get("content") or {}, f.get("item") or {}
    kinds: dict[str, int] = {}
    for n in c.get("nodes", []):
        kinds[n.get("kind", "?")] = kinds.get(n.get("kind", "?"), 0) + 1
    builds = p.get("/api/pipeline/builds", pipeline_id=pid, limit=3)
    return {"pipeline_id": pid, "nama": item.get("name"), "jumlah_node": len(c.get("nodes", [])), "node_per_jenis": kinds,
            "node": [{"nama": n.get("name"), "jenis": n.get("kind"), "keterangan": _cut(n.get("description"), 90)} for n in c.get("nodes", [])[:40]],
            "keluaran": [{"nama": o.get("name"), "jenis": o.get("kind"), "lokasi": (o.get("location") or {}).get("name"), "ekspektasi": len(o.get("expectations") or [])} for o in c.get("outputs", [])],
            "jadwal": [s.get("name") or s.get("id") for s in c.get("schedules", [])],
            "build_terakhir": [{"id": b.get("id"), "status": b.get("status"), "pemicu": b.get("trigger"), "mulai": b.get("started_at") or b.get("created_at")} for b in (builds if isinstance(builds, list) else [])]}


def trace_lineage(p: Platform, name: str, direction: str = "both", depth: int = 3) -> dict:
    g = p.get("/api/lineage/graph")
    nodes = {n["id"]: n for n in g.get("nodes", [])}
    want = name.lower().strip()
    hit = [n for n in nodes.values() if (n.get("name") or "").lower() == want] or [n for n in nodes.values() if want in (n.get("name") or "").lower()]
    if not hit:
        return {"error": f"tidak ada node lineage bernama '{name}'"}
    start = hit[0]
    up: dict[str, list[str]] = {}
    down: dict[str, list[str]] = {}
    for e in g.get("edges", []):
        down.setdefault(e["from"], []).append(e["to"])
        up.setdefault(e["to"], []).append(e["from"])

    def walk(adj: dict[str, list[str]]) -> list[dict]:
        seen, frontier, out = {start["id"]}, [start["id"]], []
        for level in range(1, max(1, min(int(depth), 6)) + 1):
            nxt = []
            for nid in frontier:
                for m in adj.get(nid, []):
                    if m in seen or m not in nodes:
                        continue
                    seen.add(m)
                    nxt.append(m)
                    out.append({"nama": nodes[m].get("name"), "jenis": nodes[m].get("kind_label") or nodes[m].get("kind"), "level": level})
            frontier = nxt
        return out[:60]

    return {"node": {"nama": start.get("name"), "jenis": start.get("kind_label") or start.get("kind"), "id": start["id"]}, "lain_yang_cocok": [n.get("name") for n in hit[1:6]],
            "hulu": walk(up) if direction in ("up", "both") else [], "hilir": walk(down) if direction in ("down", "both") else []}


def read_code(p: Platform, path: str = "", repo: str = "functions") -> dict:
    ids = p.ids()
    rid = ids.get("model_repo") if repo == "model" else ids.get("functions_repo")
    if not rid:
        return {"error": "repositori kode JKN tidak ditemukan"}
    r = p.get(f"/api/code-repos/{rid}")
    files: dict[str, str] = r.get("files") or {}
    if not path:
        return {"repo": r.get("name"), "repo_id": rid, "branch": (r.get("branch") or {}).get("name") or r.get("default_branch"), "file": sorted(files)[:80]}
    match = path if path in files else next((f for f in files if f.endswith(path) or path.lower() in f.lower()), None)
    if not match:
        return {"error": f"file '{path}' tidak ada", "file": sorted(files)[:80]}
    text = files[match]
    return {"repo": r.get("name"), "file": match, "baris": text.count("\n") + 1, "isi": text[:6000], "terpotong": len(text) > 6000}


def model_benchmark(p: Platform) -> dict:
    ids = p.ids()
    out: dict[str, Any] = {}
    m = ids.get("models") or {}
    if m:
        out["model_dirilis"] = {"nama": m.get("released"), "recall": m.get("recall"), "deployment_live": m.get("live_deployment_id"), "deployment_batch": m.get("batch_deployment_id")}
    if ids.get("objective"):
        o = p.get(f"/api/modeling-objectives/{ids['objective']}")
        out["objektif"] = {"nama": o.get("name"), "metrik": o.get("success_metric"), "arah": o.get("metric_direction"), "ambang": o.get("threshold"),
                           "kandidat": [{"nama": c.get("name"), "versi": c.get("version"), "status": c.get("status"),
                                         "evaluasi": [{k: v for k, v in (e or {}).items() if k in ("metric", "value", "metrics", "dataset", "at", "name")} for e in (c.get("evaluations") or [])][:5]}
                                        for c in o.get("candidates", [])]}
    try:
        b = p.get("/api/demo/jkn/fraud/benchmark")
        out["latensi_skrining"] = {"p50_ms": b.get("p50_ms"), "p95_ms": b.get("p95_ms"), "target_p95_ms": b.get("target_p95_ms"), "lolos": b.get("lolos_target")}
        mt = p.get("/api/demo/jkn/fraud/metrics")
        out["aturan_fraud"] = mt.get("aturan_registry")
    except Exception as e:  # noqa: BLE001
        out["latensi_skrining"] = {"error": str(e)[:120]}
    return out


def list_logic_functions(p: Platform) -> dict:
    fns = p.get("/api/ontology/logic")
    return {"fungsi": [{"id": f.get("id"), "nama": f.get("name"), "deskripsi": _cut(f.get("description"), 160)} for f in fns
                       if any(w in json.dumps(f).lower() for w in ("jkn", "klaim", "faskes"))]}


def fraud_summary(p: Platform) -> dict:
    o = p.get("/api/demo/jkn/fraud/overview")
    q = p.get("/api/demo/jkn/fraud/prepayment/queue")
    return {"kpi": o.get("kpi"), "distribusi_temuan": (o.get("charts") or {}).get("distribusi_temuan"), "antrian_pre_payment": q.get("ringkasan"),
            "contoh_ditahan": [{"sep": x.get("no_sep"), "faskes": x.get("faskes"), "skor": x.get("skor"), "alasan": x.get("alasan", [])[:2]} for x in (q.get("lanes") or {}).get("hold", [])[:5]]}


def check_claim(p: Platform, prosedur: str = "87.44", diagnosa: str = "J18.9", tarif_klaim: int = 3_000_000, severity_diklaim: int = 1,
                severity_didukung: int = 1, dokumen_lengkap: bool = True, faskes: str = "RS-01") -> dict:
    docs = {k: bool(dokumen_lengkap) for k in ("resume_medis", "hasil_lab", "log_tindakan", "kehadiran")}
    r = p.post(f"/api/demo/jkn/mobile/rs/{faskes}/cek", {"prosedur": prosedur, "diagnosa": diagnosa, "tarif_klaim": int(tarif_klaim),
                                                          "severity_diklaim": int(severity_diklaim), "severity_didukung": int(severity_didukung), "dokumen": docs})
    return {k: r.get(k) for k in ("status_perkiraan", "skor", "tier", "jalur", "alasan", "faktor", "saran", "nilai_risiko_rp")}


def _s(props: dict, req: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": req}


TOOLS: list[dict] = [
    {"name": "search_nexus", "view": "home", "label": "Nexus · cari", "fn": search_nexus,
     "description": "Cari objek, tipe objek, dataset, jurnal atau keputusan di graf pengetahuan Nexus JKN dengan pencarian semantik.",
     "parameters": _s({"query": {"type": "string", "description": "kata kunci atau pertanyaan"}, "k": {"type": "integer", "description": "jumlah hasil (maks 20)"}}, ["query"])},
    {"name": "describe_object_type", "view": "home", "label": "Nexus · tipe objek", "fn": describe_object_type,
     "description": "Skema satu tipe objek Nexus JKN: properti beserta deskripsinya, relasi dan kardinalitasnya, jumlah objek.",
     "parameters": _s({"name": {"type": "string", "description": "nama tipe objek, mis. 'Faskes Audit JKN', 'Klaim JKN', 'Dokter Audit JKN'"}}, ["name"])},
    {"name": "query_objects", "view": "home", "label": "Nexus · objek", "fn": query_objects,
     "description": "Ambil objek dari satu tipe objek Nexus JKN, opsional difilter kata kunci (nama, kode, status).",
     "parameters": _s({"object_type": {"type": "string"}, "search": {"type": "string"}, "limit": {"type": "integer", "description": "maks 25"}}, ["object_type"])},
    {"name": "get_pipeline", "view": "pipeline", "label": "Pipeline Builder", "fn": get_pipeline,
     "description": "Definisi pipeline JKN di Pipeline Builder: node (sumber, transform), dataset keluaran, jadwal, dan build terakhir.",
     "parameters": _s({"which": {"type": "string", "enum": ["audit", "scoring", "iot"], "description": "audit (utama), scoring (ML), iot"}}, [])},
    {"name": "trace_lineage", "view": "lineage", "label": "Data Lineage", "fn": trace_lineage,
     "description": "Telusuri Data Lineage dari satu node (dataset, pipeline, tipe objek, model, aplikasi): apa yang ada di hulu dan hilirnya.",
     "parameters": _s({"name": {"type": "string", "description": "nama node, mis. 'faskes_audit' atau 'Faskes Audit JKN (demo)'"},
                       "direction": {"type": "string", "enum": ["up", "down", "both"]}, "depth": {"type": "integer", "description": "1–6"}}, ["name"])},
    {"name": "read_code", "view": None, "label": "Code repository", "fn": read_code,
     "description": "Baca repositori kode JKN: tanpa path → daftar file; dengan path → isi file (fungsi, transform, model).",
     "parameters": _s({"path": {"type": "string"}, "repo": {"type": "string", "enum": ["functions", "model"]}}, [])},
    {"name": "model_benchmark", "view": None, "label": "Model benchmark", "fn": model_benchmark,
     "description": "Performa model JKN: model yang dirilis dan recall-nya, kandidat di objektif pemodelan beserta evaluasi, latensi skrining dan hit/false-positive rate aturan fraud.",
     "parameters": _s({}, [])},
    {"name": "list_logic_functions", "view": "logic", "label": "AIP Logic", "fn": list_logic_functions,
     "description": "Daftar fungsi AIP Logic untuk JKN.", "parameters": _s({}, [])},
    {"name": "fraud_summary", "view": "ops", "label": "Mesin fraud", "fn": fraud_summary,
     "description": "Ringkasan mesin fraud JKN: KPI (klaim terflag, kasus, estimasi kerugian), distribusi temuan, antrian pre-payment dan contoh klaim ditahan.",
     "parameters": _s({}, [])},
    {"name": "check_claim", "view": None, "label": "Cek klaim", "fn": check_claim,
     "description": "Periksa satu klaim dengan aturan & skor fraud tanpa mencatatnya: perkiraan jalur (otomatis/review/ditahan), skor, alasan, saran.",
     "parameters": _s({"prosedur": {"type": "string", "description": "kode ICD-9, mis. 87.44 foto thorax, 81.54 TKR, 74.1 SC"}, "diagnosa": {"type": "string"},
                       "tarif_klaim": {"type": "integer"}, "severity_diklaim": {"type": "integer"}, "severity_didukung": {"type": "integer"},
                       "dokumen_lengkap": {"type": "boolean"}, "faskes": {"type": "string"}}, [])},
]
BY_NAME: dict[str, dict] = {t["name"]: t for t in TOOLS}


def _summary(name: str, res: dict) -> str:
    if "error" in res:
        return f"gagal: {res['error']}"
    if name == "search_nexus":
        return f"{len(res['hits'])} simpul: " + ", ".join(_cut(h['label'], 40) for h in res["hits"][:4])
    if name == "describe_object_type":
        return f"{res['nama']} · {len(res['properti'])} properti · {len(res['relasi'])} relasi"
    if name == "query_objects":
        return f"{res['tipe']} · {len(res['objek'])} dari {res.get('total')} objek"
    if name == "get_pipeline":
        b = res["build_terakhir"][0]["status"] if res["build_terakhir"] else "—"
        return f"{res['nama']} · {res['jumlah_node']} node · {len(res['keluaran'])} keluaran · build terakhir {b}"
    if name == "trace_lineage":
        return f"{res['node']['nama']} · {len(res['hulu'])} hulu · {len(res['hilir'])} hilir"
    if name == "read_code":
        return f"{res['file']} · {res['baris']} baris" if "isi" in res else f"{res.get('repo')} · {len(res.get('file') or [])} file"
    if name == "model_benchmark":
        m = res.get("model_dirilis") or {}
        return f"{m.get('nama', '—')} recall {m.get('recall')} · p95 skrining {(res.get('latensi_skrining') or {}).get('p95_ms')} ms"
    if name == "list_logic_functions":
        return f"{len(res['fungsi'])} fungsi"
    if name == "fraud_summary":
        k = res.get("kpi") or {}
        return f"{k.get('klaim_terflag')}/{k.get('total_klaim')} klaim terflag · {k.get('kasus_investigasi')} kasus · antrian {res.get('antrian_pre_payment')}"
    if name == "check_claim":
        return f"{res.get('status_perkiraan')} · skor {res.get('skor')}"
    return "ok"


def run_tool(p: Platform, name: str, args: dict) -> tuple[dict, bool]:
    t = BY_NAME.get(name)
    if not t:
        return {"error": f"tool '{name}' tidak dikenal"}, False
    fn: Callable[..., dict] = t["fn"]
    try:
        return fn(p, **(args or {})), True
    except PermissionError as e:
        return {"error": f"akses ditolak: {e}"}, False
    except TypeError as e:
        return {"error": f"argumen tidak valid: {e}"}, False
    except Exception as e:  # noqa: BLE001 - the model sees the failure and can try another way
        return {"error": str(e)[:300]}, False


@router.get("/tools")
def tools() -> dict:
    return {"model": MODEL, "tools": [{"name": t["name"], "label": t["label"], "view": t["view"], "description": t["description"], "parameters": t["parameters"]} for t in TOOLS]}


@router.post("/ask")
def ask(body: AskIn, request: Request) -> dict:
    import pipeline_ai

    t0 = time.time()
    p = Platform(request)
    decls = [{"name": t["name"], "description": t["description"], "parameters": t["parameters"]} for t in TOOLS]
    messages: list[dict] = [{"role": m["role"], "text": str(m.get("text", ""))[:2000]} for m in body.history[-6:] if m.get("role") in ("user", "assistant") and m.get("text")]
    messages.append({"role": "user", "text": body.q.strip()})
    steps: list[dict] = []
    answer = ""
    try:
        for rnd in range(MAX_ROUNDS + 1):
            out = pipeline_ai.chat_tools(MODEL, SYSTEM, messages, decls, temperature=0.1, max_tokens=1600,
                                         tool_choice="none" if rnd == MAX_ROUNDS else "auto")
            messages.append(out["message"])
            calls = out.get("tool_calls") or []
            if not calls:
                answer = out.get("text") or ""
                break
            for c in calls:
                s0 = time.time()
                res, ok = run_tool(p, c["name"], c.get("args") or {})
                steps.append({"tool": c["name"], "label": BY_NAME.get(c["name"], {}).get("label", c["name"]), "args": c.get("args") or {},
                              "summary": _summary(c["name"], res), "ok": ok, "ms": int((time.time() - s0) * 1000), "view": BY_NAME.get(c["name"], {}).get("view")})
                text = json.dumps(res, ensure_ascii=False, default=str)
                messages.append({"role": "tool", "id": c.get("id"), "name": c["name"], "provider_id": c.get("provider_id"),
                                 "result": json.loads(text[:12000]) if len(text) <= 12000 else {"result": text[:12000] + " …(terpotong)"}})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Agen gagal: {e}")
    finally:
        p.client.close()
    return {"answer": answer.strip(), "steps": steps, "model": MODEL, "ms": int((time.time() - t0) * 1000)}
