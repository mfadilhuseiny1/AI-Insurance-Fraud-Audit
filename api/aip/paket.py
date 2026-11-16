"""The audit pack: what a comprehensive audit answer needs about one scope, computed by code from the fraud consultancy's
outputs (the indication tags, the Karantina box and its per-claim loss rule) and the screened claims, in one read.

Before it, every fraud question had domain agents re-derive these figures with a model call per step: a question and its
cockpit took about two minutes, a lookup as long as an analysis (the user, 2026-10-24: "more efficient, but still a
comprehensive audit report"). The consultancy has done that work; a question only has to cut it to its scope.

A scope is any mix of: provinsi, kabkota, faskes (an id or part of a name), inacbg_kode, diagnosis (an ICD-10 category
such as J18, or part of a name), modus (an indication tag or its label), flags (los_ekstrem, koreksi, readmisi,
klaim_ganda, rawat_inap), tipe_fkrtl, kelas_rawat and a month range. The pack:

- ringkasan: the key figures (claims, tagged claims, facilities, the estimated loss by the box's rule, what the verifier
  already corrected, billed and paid, the LOS / readmission / duplicate signals) with their national comparators and,
  for a province, its rank;
- wilayah: the spread by province (or by kab/kota inside a province); modus: the mix of indication modes and their
  strength; faskes: the facilities that carry the scope's loss, with their Karantina group, TSM reading and path;
  tren: per month; kode and diagnosis: the INA-CBG codes and diagnoses that carry it; kontributor: the claims behind the
  estimated loss; catatan: what the data cannot say.

Every number is computed here, so the writer only words it and code traces each one back (orkestrasi.scrutiny).
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from typing import Any, Optional

from aip import indikasi as I
from aip import karantina as K
from aip import semantik as S

FLAGS = {"los_ekstrem": "flag_los_ekstrem", "koreksi": "flag_selisih_verifikasi", "readmisi": "readmisi_30", "klaim_ganda": "flag_calon_klaim_ganda",
         "rawat_inap": "rawat_inap"}
FLAG_TEXT = {"los_ekstrem": "LOS ekstrem", "koreksi": "dikoreksi verifikator", "readmisi": "readmisi 30 hari", "klaim_ganda": "calon klaim ganda",
             "rawat_inap": "rawat inap"}
TOP = 15


def _up(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip().upper()


def _search(type_name: str, filters: list[dict], request: Any) -> list[dict]:
    """The objects of a type that match, as the caller sees them (markings, restricted views): the Object Explorer's own search."""
    import ontology
    import ontology_explorer as OE

    t = next((x for x in ontology._all("object-types") if x["display_name"] == type_name), None)
    if not t:
        return []
    token = OE.om.RESOURCE.set("aip")
    try:
        with OE._for_build(request, t["id"]), OE._lock:
            found = OE.run_search(OE.SearchIn(object_type_id=t["id"], filters=[OE.Filter(**f) for f in filters], limit=1, histograms=False))
        OE.om.record_query("base", found["type_ids"][:1], len(found["rows"]))
    finally:
        OE.om.RESOURCE.reset(token)
    return [{"_kunci": r["primary_key"], **(r.get("properties") or {})} for r in found["rows"]]


def _faskes_ids(name: str, box: dict[str, dict], profiles: list[dict]) -> list[str]:
    """The facilities a scope names: an id as it is, else every facility whose name holds the words given."""
    if name in box or any(str(p.get("faskes_profil_id") or p["_kunci"]) == name for p in profiles):
        return [name]
    words = _up(name).split()
    hits = {fid for fid, r in box.items() if all(w in _up(r.get("nama")) for w in words)}
    hits |= {str(p.get("faskes_profil_id") or p["_kunci"]) for p in profiles if all(w in _up(p.get("nama_profil")) for w in words)}
    return sorted(hits)


def scope_filters(scope: dict, box: dict[str, dict], profiles: list[dict]) -> tuple[list[dict], list[str], Optional[str]]:
    """(the Klaim Berisiko filters of a scope, its parts as words, the indication tag it asks for)."""
    f: list[dict] = []
    words: list[str] = []
    if scope.get("provinsi"):
        f.append({"property": "provinsi", "op": "eq", "value": _up(scope["provinsi"])})
        words.append(_up(scope["provinsi"]))
    if scope.get("kabkota"):
        f.append({"property": "kabkota", "op": "eq", "value": _up(scope["kabkota"])})
        words.append(_up(scope["kabkota"]))
    if scope.get("faskes"):
        ids = _faskes_ids(str(scope["faskes"]).strip(), box, profiles)
        f.append({"property": "faskes_profil_id", "op": "in", "value": ids or ["-"]})
        words.append(f"faskes {scope['faskes']}")
    if scope.get("inacbg_kode"):
        f.append({"property": "inacbg_kode", "op": "eq", "value": _up(scope["inacbg_kode"])})
        words.append(f"INA-CBG {_up(scope['inacbg_kode'])}")
    if scope.get("diagnosis"):
        d = str(scope["diagnosis"]).strip()
        f.append({"property": "dx_primer_icd3", "op": "eq", "value": d.upper().replace(".", "")[:3]} if re.fullmatch(r"[A-Za-z]\d\d(\.?\d*)?", d)
                 else {"property": "dx_primer_nama", "op": "contains", "value": d})
        words.append(f"diagnosis {d}")
    for k in ("tipe_fkrtl", "kelas_rawat"):
        if scope.get(k):
            f.append({"property": k, "op": "eq", "value": str(scope[k]).strip()})
            words.append(str(scope[k]).strip())
    for flag in scope.get("flag") or []:
        if flag in FLAGS:
            f.append({"property": FLAGS[flag], "op": "eq", "value": True})
            words.append(FLAG_TEXT[flag])
    if scope.get("bulan_dari"):
        f.append({"property": "bulan", "op": "gte", "value": str(scope["bulan_dari"])[:7]})
    if scope.get("bulan_sampai"):
        f.append({"property": "bulan", "op": "lte", "value": str(scope["bulan_sampai"])[:7]})
    if scope.get("bulan_dari") or scope.get("bulan_sampai"):
        words.append(f"bulan {scope.get('bulan_dari') or '…'}–{scope.get('bulan_sampai') or '…'}")
    if scope.get("kelompok"):
        words.append("Box Karantina kelompok " + "/".join(_groups(scope["kelompok"])))
    tag = None
    if scope.get("modus"):
        m = _up(scope["modus"])
        tag = next((k for k, t in S.TAG.items() if m in (k, _up(t["label"])) or m in _up(t["label"]) or m in _up(t.get("modus"))), None)
        words.append(f"modus {S.TAG[tag]['label'] if tag else scope['modus']}")
    return f, words, tag


FLAG_MODE = {"los_ekstrem": "LOS_DIPERPANJANG", "readmisi": "READMISI", "klaim_ganda": "KLAIM_GANDA", "koreksi": "KOREKSI_BERULANG"}
_engagement: dict[str, Any] = {}  # the last engagement's events, read once per engagement


def _last_engagement() -> tuple[Optional[dict], list[dict]]:
    """The last finished engagement of the fraud consultancy and its events (its analysts' reports, the investigators'
    recommendations, the report's sections)."""
    from aip import runs

    best = None
    for d in runs._dir().iterdir():
        try:
            r = json.loads((d / "run.json").read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if r.get("kind") == "konsultan" and r.get("status") == "succeeded" and (not best or r["created_at"] > best["created_at"]):
            best = r
    if not best:
        return None, []
    if _engagement.get("id") != best["id"]:
        _engagement.update(id=best["id"], events=runs._events(best["id"]))
    return best, _engagement["events"]


def _clean(text: str, n: int) -> str:
    """An engagement's text for a chat answer: its result ids belong to that engagement, not to this run."""
    text = re.sub(r"\s*\[(?:r\d+(?:\s*[/,;]\s*)?)+\]", "", text or "")
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:n]


def consultancy(prov_codes: set, fids: list[str], tag: Optional[str], flags: list[str], national: bool) -> dict:
    """What the consultancy's last engagement wrote about a scope: the province analysts' and mode specialists' reports,
    the investigators' recommended path for its facilities, and for a national question the report's own sections."""
    rec, ev = _last_engagement()
    if not rec:
        return {}
    texts = {e["agent"]: e["text"] for e in ev if e["type"] == "text" and e.get("agent")}  # each agent's last report
    want = [f"prov_{c}" for c in sorted(prov_codes)][:3]
    modes = [tag] if tag else [FLAG_MODE[f] for f in flags if f in FLAG_MODE]
    want += [f"modus_{m.lower()}" for m in modes][:2]
    reports = [{"agen": a, "laporan": _clean(texts[a], 2500)} for a in want if texts.get(a)]
    recs: dict[str, dict] = {}
    for e in ev:
        if e["type"] == "rekomendasi" and str(e.get("faskes")) in fids:
            recs[str(e["faskes"])] = e
    paths = [{"faskes": e.get("nama") or e["faskes"], "kelompok": e.get("kelompok"), "jalur": e.get("jalur"),
              "tsm": " · ".join(f"{k}: {v}" for k, v in (e.get("tsm") or {}).items()), "alasan": _clean(str(e.get("alasan") or ""), 900)}
             for e in sorted(recs.values(), key=lambda e: fids.index(str(e["faskes"])))][:6]
    sections = []
    if national:
        done = {e["id"]: e for e in ev if e["type"] == "bagian" and e.get("status") == "selesai" and e.get("teks")}
        sections = [{"bagian": done[k]["judul"], "teks": _clean(done[k]["teks"], 2500)} for k in ("ringkasan", "temuan", "box") if k in done]
    return {"run": rec["id"], "pada": rec.get("finished_at") or rec["created_at"], "laporan_analis": reports, "rekomendasi_jalur": paths,
            "bagian_laporan": sections}


def _groups(v: Any) -> list[str]:
    """Karantina groups asked for: "A", "A,B", ["A", "B"]."""
    items = v if isinstance(v, list) else re.split(r"[\s,/]+", str(v or ""))
    return [g for g in (str(x).strip().upper() for x in items) if g in {b for b, _ in K.BANDS}]


def _f(v: Any) -> float:
    return I._f(v) or 0.0


def _pct(part: float, whole: float) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


_NATIONAL: dict[str, tuple[float, list[dict]]] = {}  # every claim as one caller sees them, for a drill-down's steps
NATIONAL_SECONDS = 120


def _national(request: Any) -> list[dict]:
    """All screened claims as the caller sees them, read once per caller for a couple of minutes: each step of a
    drill-down needs the national comparators, and the read waits on the explorer's lock behind a running engagement."""
    import time

    import auth

    who = str((auth.current() or {}).get("id") or "-")
    hit = _NATIONAL.get(who)
    if hit and time.time() - hit[0] < NATIONAL_SECONDS:
        return hit[1]
    rows = _search(S.T_KLAIM, [], request)
    _NATIONAL[who] = (time.time(), rows)
    return rows


def build(scope: dict, request: Any = None) -> dict:
    have = I._viewer_markings()
    box = {fid: r for fid, r in K._load().items() if K._visible(r, have)}
    profiles = I._objects(S.T_FASKES)
    filters, words, tag = scope_filters(scope, box, profiles)
    national = _national(request)
    claims = _search(S.T_KLAIM, filters, request) if filters else list(national)
    # a scope cut by flags (LOS ekstrem, readmisi…) is a part of the scope's risky claims: the whole is kept beside it, or
    # "459 klaim" read as the province's risky claims (it has 1,093; 459 are LOS-extreme — an answer said 100%, 2026-10-27)
    flags = [x for x in scope.get("flag") or [] if x in FLAGS]
    base = None
    if flags:
        rest = [x for x in filters if x["property"] not in {FLAGS[f] for f in flags}]
        base = _search(S.T_KLAIM, rest, request) if rest else list(national)
    cid = lambda r: str(r.get("klaim_id") or r["_kunci"])  # noqa: E731
    tags = [v for v in (I.view(x) for x in I._all().values() if I.standing(x)) if I._visible(v, have)]
    by_claim: dict[str, set] = defaultdict(set)
    by_faskes: dict[str, set] = defaultdict(set)
    for v in tags:
        if v["entitas"] == "klaim":
            by_claim[str(v["kunci"])].add(v["tag"])
        elif v["entitas"] == "faskes":
            by_faskes[str(v["kunci"])].add(v["tag"])
    if tag:  # a mode: the claims tagged with it, and the claims of the facilities tagged with it
        claims = [r for r in claims if tag in by_claim.get(cid(r), set()) or tag in by_faskes.get(str(r.get("faskes_profil_id")), set())]
        if base is not None:
            base = [r for r in base if tag in by_claim.get(cid(r), set()) or tag in by_faskes.get(str(r.get("faskes_profil_id")), set())]
    if scope.get("kelompok"):  # the facilities of a Karantina group (A: the first 50% of the estimated loss)
        want = set(_groups(scope["kelompok"]))
        claims = [r for r in claims if (box.get(str(r.get("faskes_profil_id"))) or {}).get("kelompok") in want]
        if base is not None:
            base = [r for r in base if (box.get(str(r.get("faskes_profil_id"))) or {}).get("kelompok") in want]
    ml = {str(r.get("klaim_id") or r["_kunci"]): r for r in I._objects(S.T_ML_KLAIM)}
    r_med, _ = K._correction_median({cid(r): r for r in national})

    def loss_of(rows: list[dict]) -> dict[str, dict]:
        out = {}
        for r in rows:
            c = cid(r)
            if c in by_claim:
                out[c] = K.claim_loss(c, r, ml.get(c) or {}, by_claim[c], r_med)
        return out

    lost = loss_of(claims)
    nat_lost = loss_of(national) if filters or tag else lost

    def value(c: dict) -> float:
        return 0.0 if c["dikoreksi"] else max(c["parts"].values(), default=0.0)

    def sums(rows: list[dict], book: dict[str, dict]) -> dict[str, float]:
        est = sum(value(book[cid(r)]) for r in rows if cid(r) in book)
        corr = sum(book[cid(r)]["selisih"] for r in rows if cid(r) in book and book[cid(r)]["dikoreksi"])
        return {"est": est, "corr": corr}

    s, n = sums(claims, lost), sums(national, nat_lost)
    fids = {str(r.get("faskes_profil_id")) for r in claims if r.get("faskes_profil_id")}
    billed = sum(_f(r.get("biaya_tagih_rp")) for r in claims)
    paid = sum(_f(r.get("biaya_verifikasi_rp")) for r in claims)
    kpi = {"klaim": len(claims), "klaim_nasional": len(national), "porsi_nasional_pct": _pct(len(claims), len(national)),
           "klaim_bertag": sum(cid(r) in by_claim for r in claims), "faskes": len(fids), "faskes_di_karantina": sum(f in box for f in fids),
           "estimasi_kerugian_rp": round(s["est"]), "estimasi_kerugian_nasional_rp": round(n["est"]), "porsi_kerugian_nasional_pct": _pct(s["est"], n["est"]),
           "sudah_dikoreksi_rp": round(s["corr"]), "klaim_dikoreksi": sum(bool(r.get("flag_selisih_verifikasi")) for r in claims),
           "biaya_tagih_rp": round(billed), "biaya_verifikasi_rp": round(paid), "rasio_koreksi_pct": _pct(billed - paid, billed),
           "klaim_los_ekstrem": sum(bool(r.get("flag_los_ekstrem")) for r in claims), "klaim_readmisi_30": sum(bool(r.get("readmisi_30")) for r in claims),
           "klaim_calon_ganda": sum(bool(r.get("flag_calon_klaim_ganda")) for r in claims),
           "skor_risiko_rata": round(sum(_f(r.get("skor_risiko")) for r in claims) / len(claims), 1) if claims else 0.0}
    kpi["porsi_bertag_pct"] = _pct(kpi["klaim_bertag"], len(claims))
    ranking = national
    if flags:  # the flagged claims against the national claims with the same flags, and against their whole scope
        ranking = [r for r in national if all(r.get(FLAGS[f]) for f in flags)]
        kpi |= {"flag": " & ".join(FLAG_TEXT[f] for f in flags), "klaim_berisiko_cakupan": len(base or []),
                "porsi_flag_cakupan_pct": _pct(len(claims), len(base or [])), "klaim_nasional": len(ranking),
                "porsi_nasional_pct": _pct(len(claims), len(ranking)), "klaim_berisiko_nasional": len(national)}
    per_prov = Counter(_up(r.get("provinsi")) for r in ranking if r.get("provinsi"))
    if scope.get("provinsi") and per_prov:
        ranked = [p for p, _ in per_prov.most_common()]
        me = _up(scope["provinsi"])
        if me in ranked:
            kpi |= {"peringkat_provinsi": ranked.index(me) + 1, "jumlah_provinsi": len(ranked),
                    "rata_klaim_per_provinsi": round(len(ranking) / len(ranked), 1), "kali_rata_provinsi": round(per_prov[me] / (len(ranking) / len(ranked)), 2)}

    def grouped(key: str, name: Optional[str] = None, top: int = TOP, pair: Optional[str] = None, of: Optional[Any] = None) -> list[dict]:
        """The scope's claims per value of `key` (of: a function of the claim instead): size, loss, corrections, billed and
        paid, readmission and LOS shares, the main indication, and the commonest `pair` value (the diagnosis of a code)."""
        g: dict[Any, dict] = {}
        for r in claims:
            k = of(r) if of else r.get(key)
            if k in (None, ""):
                continue
            x = g.setdefault(k, {"group": k, **({"nama": r.get(name)} if name and r.get(name) else {}), "value": 0, "klaim_bertag": 0,
                                 "estimasi_kerugian_rp": 0.0, "sudah_dikoreksi_rp": 0.0, "biaya_tagih_rp": 0.0, "biaya_verifikasi_rp": 0.0,
                                 "_readmisi": 0, "_los": 0, "_tag": Counter(), "_pair": Counter()})
            x["value"] += 1
            x["biaya_tagih_rp"] += _f(r.get("biaya_tagih_rp"))
            x["biaya_verifikasi_rp"] += _f(r.get("biaya_verifikasi_rp"))
            x["_readmisi"] += bool(r.get("readmisi_30"))
            x["_los"] += bool(r.get("flag_los_ekstrem"))
            x["_tag"].update(by_claim.get(cid(r), ()))
            if pair and r.get(pair):
                x["_pair"][r[pair]] += 1
            c = lost.get(cid(r))
            if c:
                x["klaim_bertag"] += 1
                x["estimasi_kerugian_rp"] += value(c)
                x["sudah_dikoreksi_rp"] += c["selisih"] if c["dikoreksi"] else 0.0
        for x in g.values():
            x["rasio_koreksi_pct"] = _pct(x["biaya_tagih_rp"] - x["biaya_verifikasi_rp"], x["biaya_tagih_rp"])
        # the groups carrying the loss, and beside them the most frequent ones and the most corrected (>= 10 claims): the
        # code an answer names as the most common has its own figure (O-6-10-I, the commonest code of the LOS-extreme
        # claims, was outside a top-15 by loss), and "which code has the highest correction rate" is in the pack
        rows = sorted(g.values(), key=lambda x: (-x["estimasi_kerugian_rp"], -x["value"]))[:top]
        rows += [x for x in sorted(g.values(), key=lambda x: -x["value"])[:5] if x not in rows]
        rows += [x for x in sorted((x for x in g.values() if x["value"] >= 10), key=lambda x: -x["rasio_koreksi_pct"])[:5] if x not in rows]
        for x in rows:
            for k in ("estimasi_kerugian_rp", "sudah_dikoreksi_rp", "biaya_tagih_rp", "biaya_verifikasi_rp"):
                x[k] = round(x[k])
            x["porsi_klaim_pct"] = _pct(x["value"], len(claims))
            x["readmisi_30_pct"], x["los_ekstrem_pct"] = _pct(x.pop("_readmisi"), x["value"]), _pct(x.pop("_los"), x["value"])
            main = x.pop("_tag").most_common(1)
            x["indikasi_utama"] = S.TAG.get(main[0][0], {}).get("label", main[0][0]) if main else "-"
            common = x.pop("_pair").most_common(1)
            if pair:
                x[f"{pair}_teratas"] = f"{common[0][0]} ({common[0][1]} klaim)" if common else "-"
        return rows

    parts: list[dict] = [{"kunci": "ringkasan", "judul": "Ringkasan audit · " + (" · ".join(words) or "nasional"), "jenis": "kpi", "baris": [kpi]}]
    if scope.get("faskes"):
        pass  # one facility: its claims by code and diagnosis say more than a map of one place
    elif scope.get("provinsi") or scope.get("kabkota"):
        parts.append({"kunci": "wilayah", "judul": "Sebaran per kab/kota", "jenis": "agg", "kelompok": "kabkota_kode",
                      "baris": grouped("kabkota_kode", "kabkota", 40)})
    else:
        parts.append({"kunci": "wilayah", "judul": "Sebaran per provinsi", "jenis": "agg", "kelompok": "provinsi_kode",
                      "baris": grouped("provinsi_kode", "provinsi", 40)})
    # the modes of indication in scope: the claims' tags and their facilities' tags, by strength
    mix: dict[str, dict] = {}
    scope_claims = {cid(r) for r in claims}
    for v in tags:
        if (v["entitas"] == "klaim" and str(v["kunci"]) in scope_claims) or (v["entitas"] == "faskes" and str(v["kunci"]) in fids):
            x = mix.setdefault(v["tag_label"], {"group": v["tag_label"], "value": 0, "kuat": 0, "sedang": 0, "lemah": 0, "modus": v.get("modus") or ""})
            x["value"] += 1
            x[v["kekuatan"]] = x.get(v["kekuatan"], 0) + 1
    parts.append({"kunci": "modus", "judul": "Komposisi indikasi fraud (tag AI Agent Swarm)", "jenis": "agg", "kelompok": "jenis_indikasi",
                  "baris": sorted(mix.values(), key=lambda x: -x["value"])})
    # the facilities of the scope in audit order: as the box ranks them (its group by the whole facility's estimated loss, a
    # ditindak path, TSM met), then the scope's own loss and corrections — not the scope's loss alone (a group-D clinic
    # with Rp1,8 jt once led a province's audit list, 2026-10-24)
    rank = {g: i for i, (g, _) in enumerate(K.BANDS)}

    def order(x: dict) -> tuple:
        b = box.get(str(x["group"])) or {}
        tsm = sum((v or {}).get("nilai") == "terpenuhi" for v in (b.get("tsm") or {}).values())
        return (rank.get(b.get("kelompok"), 9), b.get("jalur_awal") != "ditindak", -tsm, -_f(b.get("estimasi_kerugian_rp")),
                -x["estimasi_kerugian_rp"], -x["sudah_dikoreksi_rp"])

    fac = sorted(grouped("faskes_profil_id", None, 10_000), key=order)[:25]
    for i, x in enumerate(fac, 1):
        x["prioritas"] = i
        b, prof = box.get(str(x["group"])) or {}, next((p for p in profiles if str(p.get("faskes_profil_id") or p["_kunci"]) == str(x["group"])), {})
        tsm = b.get("tsm") or {}
        x |= {"nama": b.get("nama") or prof.get("nama_profil") or x["group"], "kabkota": b.get("kabkota") or prof.get("kabkota"),
              "kelompok_karantina": b.get("kelompok") or "-", "status": b.get("status") or "-", "jalur_awal": b.get("jalur_awal") or "-",
              "tsm": " · ".join(f"{d[0].upper()}:{(tsm.get(d) or {}).get('nilai', '-')}" for d in ("terstruktur", "sistematis", "masif")) if tsm else "-",
              "modus_faskes": ", ".join(sorted(S.TAG.get(t, {}).get("label", t) for t in by_faskes.get(str(x["group"]), set())))[:160] or "-",
              "estimasi_kerugian_faskes_rp": b.get("estimasi_kerugian_rp")}
    parts.append({"kunci": "faskes", "judul": "Faskes prioritas audit (urutan Box Karantina)", "jenis": "objects", "tipe": "Karantina Faskes (AI Agent Swarm)",
                  "baris": [{"nama": x.pop("nama"), **{k: v for k, v in x.items() if k != "group"}, "faskes_profil_id": x["group"]} for x in fac]})
    parts.append({"kunci": "tren", "judul": "Per bulan", "jenis": "agg", "kelompok": "bulan",
                  "baris": sorted(grouped("bulan", None, 60), key=lambda x: str(x["group"]))})
    if not scope.get("inacbg_kode"):
        parts.append({"kunci": "kode", "judul": "Kode INA-CBG yang menanggung estimasi kerugian", "jenis": "agg", "kelompok": "inacbg_kode",
                      "baris": grouped("inacbg_kode", pair="dx_primer_nama")})
    if not scope.get("diagnosis"):
        parts.append({"kunci": "diagnosis", "judul": "Diagnosis primer", "jenis": "agg", "kelompok": "dx_primer_nama",
                      "baris": grouped("dx_primer_nama", pair="inacbg_kode")})
    if not scope.get("faskes"):
        # per hospital class, as the consultancy's peer analyst groups them, with the risky claims per 1.000 FKRTL claims of
        # that class in the same area (Profil Faskes klaim_fkrtl): classes compare by rate, not by raw count
        from aip import konsultan

        member = {t: label for _, label, types in konsultan.PEER if types for t in types}
        area = [p for p in profiles if (not scope.get("provinsi") or _up(p.get("provinsi")) == _up(scope["provinsi"]))
                and (not scope.get("kabkota") or _up(p.get("kabkota")) == _up(scope["kabkota"]))]
        total: Counter = Counter()
        for p in area:
            if member.get(p.get("tipe")):
                total[member[p["tipe"]]] += _f(p.get("klaim_fkrtl"))
        kelas = grouped("tipe_fkrtl", None, 20, of=lambda r: member.get(r.get("tipe_fkrtl")))
        for x in kelas:
            x["klaim_fkrtl"] = round(total.get(x["group"], 0))
            x["per_1000_klaim"] = round(1000 * x["value"] / x["klaim_fkrtl"], 2) if x["klaim_fkrtl"] else None
        parts.append({"kunci": "kelas", "judul": "Per kelas rumah sakit (kelompok peer AI Agent Swarm)", "jenis": "agg", "kelompok": "kelas_faskes",
                      "baris": sorted(kelas, key=lambda x: -(x["per_1000_klaim"] or 0))})
    top = sorted(((cid(r), r, lost[cid(r)]) for r in claims if cid(r) in lost and value(lost[cid(r)]) > 0), key=lambda x: -value(x[2]))[:20]
    parts.append({"kunci": "kontributor", "judul": "Klaim di balik estimasi kerugian", "jenis": "objects", "tipe": S.T_KLAIM,
                  "baris": [{"klaim_id": c, "faskes": (box.get(str(r.get("faskes_profil_id"))) or {}).get("nama") or r.get("faskes_profil_id"),
                             "inacbg_kode": r.get("inacbg_kode"), "dx_primer_nama": r.get("dx_primer_nama"), "los_hari": r.get("los_hari"),
                             "biaya_tagih_rp": r.get("biaya_tagih_rp"), "biaya_verifikasi_rp": r.get("biaya_verifikasi_rp"),
                             "peer_biaya_p50_rp": r.get("peer_biaya_p50_rp"), "komponen": max(x["parts"], key=lambda k: x["parts"][k]),
                             "estimasi_kerugian_rp": round(value(x)), "indikasi": ", ".join(sorted(S.TAG.get(t, {}).get("label", t) for t in by_claim[c]))}
                            for c, r, x in top]})
    caveats = ["selisih_rp adalah koreksi verifikator (sudah dikoreksi), bukan kerugian; koreksi juga belum tentu fraud",
               f"estimasi kerugian = aturan Box Karantina per klaim bertag yang belum dikoreksi (tagihan di luar tarif INA-CBG + top-up, "
               f"dibayar di atas {K.PEER_BAND}× median peer setarif, "
               f"{K.DUPLICATE_SHARE:.0%} calon klaim ganda, atau ekspektasi model × rasio koreksi median {r_med:.3f}); klaim tanpa tag tidak dihitung",
               "indikasi bukan putusan: jalur dibina/ditindak diputuskan manusia setelah audit",
               "data sampel BPJS: tanpa identitas dokter atau ID faskes asli"]
    if not claims:
        caveats.insert(0, "tidak ada klaim berisiko yang cocok dengan cakupan ini: periksa ejaan nama wilayah/faskes atau kode")
    # what the consultancy concluded about this scope at its last engagement: its analysts' reasoning, not only its figures
    prov_codes = {r.get("provinsi_kode") for r in claims if r.get("provinsi_kode") is not None} if (scope.get("provinsi") or scope.get("kabkota")) else set()
    firm = consultancy(prov_codes, [str(x["group"]) for x in fac], tag, list(scope.get("flag") or []), not (filters or tag))
    return {"cakupan": {**scope, "teks": " · ".join(words) or "nasional"}, "filter": filters, "tag": tag, "bagian": parts, "catatan": caveats,
            "konsultan": firm}
