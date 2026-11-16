"""Claim network for the AI Agent Swarm Branch report (the user, 2026-11-14: "graph untuk audit detail klaim fraud, supaya bisa
dilihat visual"; the branch case file had none). For every case file of a run's branch reports, the network the screening
model actually read:

  the claim, its member, hospital and INA-CBG code;
  the earlier claims Model 1's 624 features averaged (fitur.Stream.neighbours): same member / same hospital / same hospital +
  code / same code, the last 10/10/10/5 in arrival order. ML v7 (and v4) read these as features X1;
  the hospitals the member visited within +-14 days and the members they share with this hospital (fitur.Stream.ring_detail,
  the basis of the network rule in the review route);
  the engine's network signals on the claim, and per neighbour what ties it to the claim (same day and code, overlapping stay,
  readmission, a clone-like bill at the same hospital).

The stream is rebuilt exactly as testing/uji_gen2.py built it per chunk: the /testing data's stream (.tmp/testing-data, read
only) followed by the chunk's claims appended one at a time in their saved order, and each case's network is read right after
its claim is appended (later claims were not in the stream when the claim was scored). Each rebuilt claim is checked against
its saved feature rows: the 4 neighbour counts (last 4 columns of X1) and the +-14-day ring (XR). A mismatch is reported and the
graph is marked approximate. Each case file also gets its explanation (testing/penjelasan_cabang.py, written by code from these facts, no LLM): a plain paragraph,
the Permenkes modes with their evidence, the verifier's steps, and the decision trail; the model's push per block (the claim itself,
its graph neighbours, the fraud-mechanism features) comes from the screening model's own SHAP contributions (LightGBM pred_contrib),
as /testing shows it. No LLM is called; no label is written. Synthetic runs only.

A case with device evidence (testing/iot_cabang.py, the IoT layer) also carries it as g["iot"] (the report's kasus[].iot), and its
lineage two more nodes: "IoT alat medis" (sessions, hours running / on standby against the bill) and "Blockchain (jangkar bukti)" (the visit's
anchored Merkle root).

Each case file also gets its data lineage, g["jejak"] (the user, 2026-11-14: "tambahin data lineage di tab baru disini, coba cek
ai-jkn-audit gimana dia tambahin data lineage di report"; drawn by web/src/components/aip/JejakKlaim.tsx as ai-jkn-audit's
JejakData draws a national case file): the claim from its row in the generator batch through the API schema, the realtime rule
engine, the feature stream (claim graph + mechanism features), the 646-feature row, the screening model file and its inference,
the indications, the swarm's redacted dossier and agents (RAGU claims only), the decision, the ledger tag with its loss estimate,
Box Karantina, to the case file's figure. Nodes sit on a grid (col, lane) set here; each holds THIS claim's own values at that
layer (`kolom`, read from the files named in `sumber`), and a layer the claim did not pass through is marked `off`.

Usage: .venv/Scripts/python.exe testing/graf_cabang.py --set gen3_kc2 [--kc sul-7371]
Output, one folder per branch (2026-11-15: a full cardiology run has ~19k case files, ~20 KB each, too much for one file):
  data/aip/cabang/<set>/graf_<kc>/<KLM-id>.json  one case file's network, explanation and lineage (compact JSON)
  data/aip/cabang/<set>/graf_<kc>/index.json     the shared header (dibuat, run, kc, hari_cincin, maks, relasi_nama, cek) and, per
                                                 case, what the list views show before the file is opened: {modus: {kode, nama}}
served by /api/swarm-cabang?run=&kc=&graf=1 (the index) and &graf=1&kasus=<KLM-id> (one case), SwarmCabangView -> GrafKlaim. The
folder is written beside (graf_<kc>.tmp, index last) and swapped in at the end, replacing the stale folder and the single
graf_<kc>.json that runs built before 2026-11-15 have (the API still serves that file for runs not rebuilt)."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import sys
import time
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
import fitur as FT  # noqa: E402
import fitur_v4 as F4  # noqa: E402
import laporan_cabang as LC  # noqa: E402
import penjelasan_cabang as PC  # noqa: E402

SRC_RT = ROOT / ".tmp" / "testing-data" / "aip" / "realtime" / "realtime.sqlite"
BASIS_SQL = """SELECT p.rec FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
               WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'uji:%' OR p.sumber LIKE 'aug:%')
               ORDER BY p.seq"""  # = testing/uji_gen2.py chunk(): the stream every chunk started from
RELASI = tuple(FT.CAPS)  # peserta, faskes, faskes_kode, kode (the order of the X1 blocks)
HARI_CINCIN = 14
KOL_CINCIN = FT.R2_WINS.index(HARI_CINCIN) * 2  # XR = (log1p rs, log1p co) per window of R2_WINS
MAKS_RS_CINCIN, MAKS_PESERTA_CINCIN = 5, 8
MAKS_KLAIM_CINCIN = 3  # claims shown per shared member (at this hospital or the other one, +-14 days)
BLOK = (("klaim", 0, 124), ("graph", 124, 624), ("mekanisme", 624, 646))  # = testing/app.py BLOK_V7 (X1 own | X1 neighbours | X4)
# the engine's network and episode signals (aip/realtime/graf.py and the stream checks): what ties a claim to others
SINYAL = {
    "KLAIM_GANDA_STREAM": "Klaim ganda (id berbeda)", "KLAIM_GANDA_RIWAYAT": "Klaim ganda (riwayat)", "KLAIM_BERULANG_MIRIP": "Klaim berulang (versi mirip)",
    "RAWAT_INAP_TUMPANG_TINDIH": "Rawat inap tumpang tindih", "KARTU_BANYAK_FASKES": "Satu kartu di banyak faskes", "PEMECAHAN_EPISODE": "Unbundling 0–3 hari",
    "EPISODE_HARI_SAMA": "Episode dipecah hari sama", "READMISI_DX_SAMA": "Readmisi diagnosis sama", "READMISI": "Readmisi ≤ 30 hari",
    "CINCIN_FASKES": "Jaringan faskes tidak wajar", "KLONING_LINTAS_PESERTA": "Kloning lintas peserta", "LONJAKAN_KEPARAHAN": "Lonjakan keparahan III",
    "RISIKO_ASOSIASI": "Faskes di Box Karantina", "KARTU_KELUARGA": "Kartu keluarga dipakai",
}


def peserta_label(pid: object) -> str:
    return f"P-{str(pid)[-4:]}"  # = laporan_cabang (the case file's member pseudonym)


def peserta_id(pid: object) -> str:
    return "p:" + hashlib.md5(str(pid).encode()).hexdigest()[:10]


def faskes_id(fk: str) -> str:
    return "f:" + hashlib.md5(str(fk).encode()).hexdigest()[:10]


def hari(s: str) -> int:
    return int(np.datetime64((s or "1970-01-01")[:10], "D").astype(int))


def tgl_dari(h: int) -> str:
    return (date(1970, 1, 1) + timedelta(days=int(h))).isoformat()


class Pandangan:
    """What the graph shows of each claim in a chunk's stream: the /testing stream first, then the chunk's claims."""

    def __init__(self, basis: list[dict], label_rs: dict[str, str]) -> None:
        self.basis, self.label_rs = basis, label_rs
        self.batch: list[dict] = []

    def rs(self, fk: str, cadangan: str = "") -> str:
        return self.label_rs.get(fk) or cadangan or f"RS {fk[:6]}"

    def __getitem__(self, j: int) -> dict:
        return self.basis[j] if j < len(self.basis) else self.batch[j - len(self.basis)]


def baca_basis(sebelum: float | None = None) -> list[dict]:
    """The /testing stream every chunk started from. `sebelum` (epoch seconds): only events received before the batch ran; the
    /testing bench keeps adding test claims to this stream, and a chunk's copy did not have the later ones."""
    con = sqlite3.connect(f"file:{SRC_RT}?mode=ro", uri=True)
    try:
        sql = BASIS_SQL if sebelum is None else BASIS_SQL.replace("ORDER BY p.seq", f"AND (json_extract(p.rec, '$.diterima') IS NULL OR json_extract(p.rec, '$.diterima') < {float(sebelum)}) ORDER BY p.seq")
        recs = [json.loads(r) for r, in con.execute(sql)]
    finally:
        con.close()
    return recs


def tanda(v: dict, f: dict) -> list[str]:
    """What ties neighbour v to the focal claim f, from their own fields (no model): the patterns a verifier checks by hand."""
    out = []
    sama_peserta = v["peserta_key"] == f["peserta_key"]
    if sama_peserta and v["faskes"] == f["faskes"] and v["kode"] == f["kode"] and v["d"] == f["d"]:
        out.append("sama_persis")
    if sama_peserta and v["faskes"] != f["faskes"] and v["tingkat"] == f["tingkat"] == "RITL" and v["d"] <= f["p"] and f["d"] <= v["p"]:
        out.append("tumpang_tindih")
    if sama_peserta and v["faskes"] == f["faskes"] and v["tingkat"] == "RITL" and 0 <= f["d"] - v["p"] <= 3 and "sama_persis" not in out:
        out.append("readmisi_dekat")
    if sama_peserta and v["faskes"] != f["faskes"] and abs(v["d"] - f["d"]) <= 3 and "tumpang_tindih" not in out:
        out.append("beda_rs_dekat")
    # a clone (as the engine's KLONING_LINTAS_PESERTA and fitur_v4): inpatient, and a bill that is not the package tariff (outpatient
    # package claims of one code all bill the same amount)
    if (not sama_peserta and v["tingkat"] == f["tingkat"] == "RITL" and f["biaya"] != f["tarif"] and v["faskes"] == f["faskes"] and v["kode"] == f["kode"]
            and abs(v["d"] - f["d"]) <= 3 and abs(v["los"] - f["los"]) <= 1 and f["biaya"] and abs(v["biaya"] - f["biaya"]) <= 0.05 * f["biaya"]):
        out.append("mirip_kloning")
    return out


def graf_klaim(st: FT.Stream, V: Pandangan, i: int, x1: np.ndarray, xr: np.ndarray, desk: dict, kasus_of: dict) -> dict:
    f = V[i]
    nb = st.neighbours(i)
    rs_n, co_n, nh_n, inter = st.ring_detail(i, HARI_CINCIN)
    deg = np.array([FT.DEG_LOG[len(nb[r])] for r in RELASI], np.float32)
    cocok = bool(np.allclose(deg, x1[-4:], atol=1e-6) and np.allclose([np.log1p(rs_n), np.log1p(co_n)], xr[KOL_CINCIN:KOL_CINCIN + 2], atol=1e-5))

    def simpul(j: int, **extra) -> dict:
        v = V[j]
        out = {"id": f"k:{j}", "tgl": tgl_dari(v["d"]), "pulang": tgl_dari(v["p"]), "kode": v["kode"], "tingkat": v["tingkat"], "los": v["los"],
               "biaya": v["biaya"], "rs": v["rs"], "peserta": peserta_label(v["peserta_key"]), "dx": v.get("dx") or "", "asal": v["asal"],
               "peserta_id": peserta_id(v["peserta_key"]), "faskes_id": faskes_id(v["faskes"]),
               "keputusan": v["keputusan"], "keputusan_mesin": v["keputusan_mesin"], "sinyal": [s for s in v["sinyal"] if s in SINYAL]}
        if v.get("kunci") in kasus_of:
            out["kasus"] = kasus_of[v["kunci"]]
        return out | extra

    klaim: dict[str, dict] = {}
    relasi = []
    for r in RELASI:
        ids = []
        for j in nb[r]:
            nid = f"k:{j}"
            if nid not in klaim:
                klaim[nid] = simpul(j, relasi=[], tanda=tanda(V[j], f))
            klaim[nid]["relasi"].append(r)
            ids.append(nid)
        key = st.keys(st.f[i])[r]
        sebelum = st.rel[r].get(key, [])
        relasi.append({"kunci": r, "nama": FT.RELASI_NAMA[r], "maks": FT.CAPS[r], "klaim": ids, "sebelumnya": max(0, len(sebelum) - 1)})
    # the ring: the other hospitals the member visited within +-14 days, and the members each shares with this hospital
    kunjungan: dict[str, int] = {}
    for dd, _j, gg in st.by_mem[f["peserta_key"]]:
        if gg != f["faskes"] and abs(dd - f["d"]) <= HARI_CINCIN:
            kunjungan[gg] = kunjungan.get(gg, 0) + 1
    rs_lain = sorted(inter.items(), key=lambda kv: -len(kv[1]))[:MAKS_RS_CINCIN]

    def ke_cincin(j: int) -> None:
        nid = f"k:{j}"
        if nid not in klaim:
            klaim[nid] = simpul(j, relasi=[], tanda=tanda(V[j], f))
        if "cincin" not in klaim[nid]["relasi"]:
            klaim[nid]["relasi"].append("cincin")

    for fk, ms in rs_lain:
        for dd, j, gg in st.by_mem[f["peserta_key"]]:
            if gg == fk and abs(dd - f["d"]) <= HARI_CINCIN and j != i:
                ke_cincin(j)
        for m in sorted(ms, key=str)[:MAKS_PESERTA_CINCIN]:
            for dd, j, gg in [x for x in st.by_mem[m] if x[2] in (fk, f["faskes"]) and abs(x[0] - f["d"]) <= HARI_CINCIN][-MAKS_KLAIM_CINCIN:]:
                ke_cincin(j)
    cincin = {"hari": HARI_CINCIN, "rs_dikunjungi": int(nh_n), "peserta_bersama": int(co_n), "maks_bersama_satu_rs": int(rs_n),
              "rs_lain": [{"id": faskes_id(fk), "label": V.rs(fk), "kunjungan_peserta": kunjungan.get(fk, 0), "peserta_bersama": len(ms),
                           "contoh_peserta": sorted(peserta_label(m) for m in ms)[:MAKS_PESERTA_CINCIN]} for fk, ms in rs_lain]}
    return {"fokus": simpul(i, relasi=[], tanda=[]), "klaim": klaim, "relasi": relasi, "cincin": cincin,
            "entitas": {"peserta": {"label": peserta_label(f["peserta_key"]), "sebelumnya": relasi[0]["sebelumnya"]},
                        "rs": {"label": f["rs"], "sebelumnya": relasi[1]["sebelumnya"]},
                        "rs_kode": {"label": f"{f['rs']} · {f['kode']}", "sebelumnya": relasi[2]["sebelumnya"]},
                        "kode": {"label": f["kode"], "deskripsi": desk.get(f["kode"], ""), "sebelumnya": relasi[3]["sebelumnya"]}},
            "sinyal": [{"kode": s, "label": SINYAL[s]} for s in f["sinyal"] if s in SINYAL], "cocok": cocok}


# ---- the claim's data lineage (JejakKlaim.tsx): helpers, then one function per case
def angka(v: float, n: int = 0) -> str:
    return f"{float(v):,.{n}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def rp(v: float) -> str:
    return "Rp " + angka(v)


def rp_singkat(v: float) -> str:
    v = float(v)
    return f"Rp {angka(v / 1e9, 2)} M" if v >= 1e9 else f"Rp {angka(v / 1e6, 1)} jt" if v >= 1e6 else rp(v)


def nilai_fitur(v: float) -> str:
    """A feature value as the row holds it: an integer as is, otherwise 3 significant digits."""
    v = float(v)
    return angka(v) if v == int(v) and abs(v) < 1e12 else f"{v:.3g}".replace(".", ",")


def rel(p: Path) -> str:
    try:
        return Path(p).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return Path(p).name


def simpul_jejak(id_: str, col: int, lane: int, fam: str, icon: str, kind: str, name: str, sub: str, sumber: str,
                 kolom: list[tuple[str, object]], off: bool = False, alert: bool = False) -> dict:
    d = {"id": id_, "col": col, "lane": lane, "fam": fam, "icon": icon, "kind": kind, "name": name, "sub": sub, "sumber": sumber,
         "kolom": [{"nama": a, "nilai": str(b)} for a, b in kolom]}
    if off:
        d["off"] = True
    if alert:
        d["alert"] = True
    return d


NAMA_RELASI = {"peserta": "peserta sama", "faskes": "RS sama", "faskes_kode": "RS + kode sama", "kode": "kode sama"}
NAMA_AGEN = {"koding": "spesialis koding", "tagihan": "spesialis tagihan", "episode": "spesialis episode", "hakim": "hakim"}
KEP_NAMA = {"TAHAN": "ditahan", "PERIKSA": "perlu diperiksa", "DIBERSIHKAN": "dibersihkan swarm"}
PASANGAN = ("KLONING_KLAIM", "KLAIM_GANDA", "PEMECAHAN_EPISODE", "READMISI", "RUJUKAN_SEMU")


def hitungan_kerugian(tag: str, biaya: int, tarif: int, topup: int, kode: str, ref: dict, iot: dict | None = None) -> str:
    """The inputs of laporan_cabang.taksir_kerugian for this claim, as numbers (the result is the case's estimasi_kerugian_rp)."""
    med_b = ref["biaya"].get(kode) or biaya
    if tag == LC.TAG_IOT and iot:
        t = iot["tarif"]
        return f"tarif ditagih {iot['ditagih']['inacbg']} {angka(t['ditagih_rp'])} − didukung alat {t['kode_seharusnya']} {angka(t['seharusnya_rp'])}"
    if tag == "UPCODING_KEPARAHAN":
        low = LC.kode_lebih_ringan(kode)
        if low and low in ref["tarif"]:
            return f"tarif {angka(tarif)} − tarif median {low} {angka(ref['tarif'][low])}"
        return f"tagihan {angka(biaya)} − median kode {angka(med_b)}"
    if tag == "TAGIHAN_MELEBIHI_TARIF":
        return (f"maks(top-up {angka(topup)} − median {angka(ref['topup'].get(kode) or 0)}; "
                f"tagihan {angka(biaya)} − {angka(LC.PITA_PEER, 1)} × median {angka(med_b)})")
    if tag == "KLAIM_FIKTIF":
        return f"seluruh tagihan {angka(biaya)}"
    if tag in PASANGAN:
        return f"{angka(LC.PORSI_PASANGAN, 1)} × tagihan {angka(biaya)}"
    return f"tagihan {angka(biaya)} − {angka(LC.PITA_PEER, 1)} × median {angka(med_b)}"


BAND = {"A": "0–50%", "B": "50–80%", "C": "80–95%", "D": "95–99%", "Z": "sisa / tanpa kerugian"}  # = laporan_cabang.BANDS, cumulative loss of the branch


def jejak_klaim(J: dict, *, kc_file: Path, hf: Path, i: int, raw: dict, rec: dict, g: dict, ctx: dict, contrib: np.ndarray,
                tags: list[tuple[str, str, str]], dos: tuple | None, rs: dict | None) -> dict:
    """One case file's lineage, left to right on three lanes (0 = the engine, the indications and the Box; 1 = the claim's main
    path; 2 = the mechanism features, the model file and the swarm). Every value is this claim's, read from the layer's own file;
    kept short (~5 KB a case): one row per fact, no value repeated between layers."""
    kep, s, q, a = rec["keputusan"], float(ctx["s"]), float(ctx["q"]), ctx["ambang"]
    zona = "TAHAN" if ctx["zona_tahan"] else "RAGU" if ctx["zona_ragu"] else "LOLOS"
    ragu, antre = zona == "RAGU", kep in ("TAHAN", "PERIKSA")
    pid, fk, kode = str(raw["peserta"][i]), str(raw["faskes"][i]), str(raw["kode"][i])
    dx = str(raw["dx"][i]) if "dx" in raw else ""
    biaya, tarif, topup, los = int(raw["biaya"][i]), int(raw["tarif"][i]), int(raw["topup"][i]), int(raw["los"][i])
    tingkat, kelas = str(raw["tingkat"][i]), str(raw["kelas"][i])
    rr = list(rec.get("rule") or [])
    rugi = int(rec.get("estimasi_kerugian_rp") or 0)
    sumber = rel(hf)
    N: list[dict] = []
    # 1. the raw row of the generator batch, as the chunk file keeps it
    N.append(simpul_jejak("raw", 0, 1, "data", "doc", "Data mentah · batch", hf.name, f"baris {i} dari {angka(len(raw['kode']))}", sumber, [
        ("peserta · faskes", f"{peserta_label(pid)} · {fk[:8]}"), ("tgl datang", str(raw["tgl"][i])),
        ("layanan", f"{tingkat} · {kelas}" + (f" · LOS {los} hari" if tingkat == "RITL" else "")), ("INA-CBG · dx", f"{kode} · {dx or '—'}"),
        ("tagihan · tarif · top-up", f"Rp {angka(biaya)} · {angka(tarif)} · {angka(topup)}")]))
    # 2. the API claim schema (only claims that passed it reached the engine and the chunk file)
    ok = lambda b: "✓" if b else "✗"  # noqa: E731
    (lo_b, hi_b), (lo_l, hi_l) = J["batas"]["biaya_tagih_rp"], J["batas"]["los_hari"]
    N.append(simpul_jejak("val", 1, 1, "data", "check", "Validasi · skema API", "KlaimIn", f"{J['n_kolom']} kolom · lolos", "api/aip/layanan.py · KlaimIn", [
        ("dx_primer_icd3", f"{dx} {ok(re.fullmatch(J['pola']['dx_primer_icd3'], dx))}" if dx else "—"),
        ("inacbg_kode", f"{kode} {ok(re.fullmatch(J['pola']['inacbg_kode'], kode))}"),
        ("rentang", f"tagihan ≤ {rp_singkat(hi_b)} {ok(lo_b <= biaya <= hi_b)} · LOS {lo_l}–{hi_l} {ok(lo_l <= los <= hi_l)}")]))
    # 3. the realtime engine's event: its rule signals and score
    sig = str(raw["sinyal"][i]).split()
    km, sr = str(raw["keputusan"][i]), float(raw["skor_rule"][i])
    kol = [(x, J["sinyal"].get(x, x)) for x in sig[:4]] or [("sinyal", "tidak ada")]
    if len(sig) > 4:
        kol.append(("lainnya", f"{len(sig) - 4} sinyal"))
    N.append(simpul_jejak("eng", 2, 0, "data", "bolt", "Mesin realtime · sinyal", f"{len(sig)} sinyal" if sig else "tanpa sinyal",
                          f"skor aturan {angka(sr, 1)}/100 · {km}", f"{sumber} · sinyal", kol, alert=bool(sig)))
    # 4. the feature stream: the claim graph the model averaged (the neighbours graf_klaim rebuilt and checked against X1/XR)
    cc = g["cincin"]
    singkat = {"peserta": "peserta", "faskes": "RS", "faskes_kode": "RS+kode", "kode": "kode"}
    N.append(simpul_jejak("graf", 3, 1, "data", "graph", "Fitur stream · graph", f"{sum(len(r['klaim']) for r in g['relasi'])} tetangga",
                          "4 relasi · " + "/".join(str(len(r["klaim"])) for r in g["relasi"]), "testing/fitur.py · Stream", [
                              ("tetangga dibaca", " · ".join(f"{singkat[r['kunci']]} {len(r['klaim'])}/{r['maks']}" for r in g["relasi"])),
                              ("klaim sebelumnya", " · ".join(f"{singkat[r['kunci']]} {angka(r['sebelumnya'])}" for r in g["relasi"])),
                              (f"jaringan ±{cc['hari']} hari", f"{cc['rs_dikunjungi']} RS lain · {cc['peserta_bersama']} peserta bersama"),
                              ("cocok fitur tersimpan", "ya" if g["cocok"] else "tidak (perkiraan)")]))
    # 5. the fraud-mechanism features (v4), the ones that pushed the score most first
    x4, c4 = raw["X4"][i], contrib[624:646]
    urut = [j for j in np.argsort(-np.abs(c4)) if x4[j] != 0][:3]
    lbl4 = lambda j: J["x4_label"].get(F4.NAMES[j], F4.NAMES[j])  # noqa: E731
    N.append(simpul_jejak("mek", 3, 2, "data", "sliders", "Fitur mekanisme · v4", f"{int(np.count_nonzero(x4))} dari {len(x4)} aktif",
                          lbl4(urut[0]) if urut else "semua nol", f"{sumber} · X4", [(lbl4(j), nilai_fitur(x4[j])) for j in urut] or [("fitur aktif", "tidak ada")]))
    # 6. the feature row the model read (X1 624 + X4 22), its values for the strongest drivers
    X = np.hstack([raw["X1"][i], raw["X4"][i]])
    top = [int(j) for j in np.argsort(-contrib[:-1])[:3] if contrib[j] > 0]
    N.append(simpul_jejak("row", 4, 1, "data", "table", "Feature store · baris", f"{len(X)} fitur", "124 klaim + 500 graph + 22", f"{sumber} · X1+X4",
                          [("bukan nol", f"{int(np.count_nonzero(X))} dari {len(X)}")] + [(J["label"](j), nilai_fitur(X[j])) for j in top]))
    # 7. the screening model file (the same for every claim of the run)
    N.append(J["model"])
    # 8. its inference on this row: score, percentile among normal claims, zone, SHAP push per block and the top drivers
    d = g["penjelasan"]["dorongan"]
    pct = lambda v: f"{angka(100 * v, 0)}%"  # noqa: E731
    zt = {"TAHAN": f"TAHAN: s ≥ {PC.des(a['tahan'], 4)}", "LOLOS": "LOLOS",
          "RAGU": f"RAGU: s ≥ {PC.des(a['ragu'], 4)}" if s >= a["ragu"] else "RAGU: aturan telaah menyala"}[zona]
    kol = [("zona", zt)] + ([("aturan telaah", ", ".join(rr))] if rr else [])
    kol += [("dorongan blok", f"klaim {pct(d['klaim'])} · graph {pct(d['graph'])} · mekanisme {pct(d['mekanisme'])}")]
    kol += [(J["label"](j), f"+{PC.des(contrib[j], 3)} log-odds") for j in top[:2]]
    N.append(simpul_jejak("inf", 5, 1, "ml", "sparkle", "Inferensi ML", f"skor {PC.des(s, 4)}", f"zona {zona} · > {PC.persen(q)} normal",
                          J["zona_file"], kol, alert=zona != "LOLOS"))
    # 9. the indications: rule tags (engine signals and review rules) and the model tag, with their strength
    N.append(simpul_jejak("ind", 6, 0, "nexus", "alert", "Indikasi · tag", f"{len(tags)} tag", f"{tags[0][0]} · {tags[0][2]}" if tags else "tanpa tag",
                          "testing/laporan_cabang.py · indikasi_kc", [(lb, f"{src} · {kk}") for lb, src, kk in tags[:4]] or [("tag", "tidak ada")],
                          off=not tags, alert=any(kk == "kuat" for _lb, _s, kk in tags)))
    # 10. the redacted dossier the swarm read (RAGU only): features in words, no score, label, scheme or identity
    if dos:
        f_, no, n_, teks = dos
        baris = teks.splitlines()
        nyala = next((b.split("—", 1)[1].strip() for b in baris if b.startswith("rule yang menyala")), "tidak ada")
        tanpa_id = pid not in teks and fk not in teks
        N.append(simpul_jejak("dos", 6, 2, "data", "doc", "Berkas swarm · tanpa ID", f_.name, f"baris {no} dari {n_} · {angka(len(teks))} karakter", rel(f_), [
            ("baris 1", baris[0][:90]), ("rule menyala", nyala[:80]),
            ("tidak memuat", "skor, label, skema" + (", ID peserta & RS ✓" if tanpa_id else "; ID peserta/RS TERBACA"))]))
    else:
        N.append(simpul_jejak("dos", 6, 2, "data", "doc", "Berkas swarm · tanpa ID", "tidak dibuat", f"zona {zona}", J["dossier_file"],
                              [("berkas", "tidak dibuat: ditahan langsung (zona TAHAN)" if zona == "TAHAN" else "tidak ada di berkas swarm run ini")], off=True))
    # 11. the swarm: three specialists and the judge (a language model), each with its risk score and family
    ag = rec.get("agen")
    if ag and ragu:
        kol = [(NAMA_AGEN[k], f"{PC.des(ag[k]['p'])} · {ag[k].get('famili') or '-'}") for k in NAMA_AGEN if k in ag]
        al = PC.tanpa_kode((ag.get("hakim") or {}).get("alasan") or "")
        if al:
            kol.append(("alasan hakim", al[:90]))
        for x in ((ag.get("hakim") or {}).get("aturan") or [])[:4]:  # the judge's stance on each rule finding (rule-evidence lane)
            if isinstance(x, dict) and x.get("id"):
                kol.append((f"temuan {x['id']}", f"{x.get('sikap') or '-'}" + (f" · {PC.tanpa_kode(str(x.get('alasan') or ''))[:70]}" if x.get("alasan") else "")))
        N.append(simpul_jejak("swm", 7, 2, "ml", "logic", "Swarm · Model AI (LLM)", f"hakim {PC.des(ag['hakim']['p'])}",
                              "spesialis " + " / ".join(PC.des(ag[k]["p"]) for k in ("koding", "tagihan", "episode") if k in ag), J["agen_file"], kol))
    else:
        N.append(simpul_jejak("swm", 7, 2, "ml", "logic", "Swarm · Model AI (LLM)", "tidak dipanggil", f"zona {zona}", J["agen_file"],
                              [("swarm", "tidak dipanggil: skor di atas ambang tahan" if zona == "TAHAN" else "tidak ada jawaban swarm")], off=True))
    # 12. the decision: TAHAN by the zone, otherwise the gate (judge + the score's percentile)/2 against tau
    tau = float(ctx["tau"])
    iot = rec.get("iot")
    naik_iot = bool(iot and iot.get("hasil") == "tidak_sesuai" and rec.get("keputusan_asal") not in ("TAHAN", "PERIKSA"))
    if naik_iot:
        aturan = f"verifikasi IoT: {iot['aturan']} tidak sesuai → PERIKSA (semula {rec.get('keputusan_asal')})"
    elif kep == "TAHAN":
        aturan = f"s {PC.des(s, 3)} ≥ tahan {PC.des(a['tahan'], 4)}"
    else:
        f_g = float(ctx["f"])
        gab = f"(hakim {PC.des(ctx['p'] or 0)} + q {PC.des(q)})/2 = {PC.des(f_g)}" if ctx["pilihan"] != "V5a" else f"hakim {PC.des(f_g)}"
        aturan = f"{gab} {'≥' if f_g >= tau else '<'} τ {PC.des(tau)}"
        jl = ctx.get("jalur") or {}
        if jl.get("jalur") == "bukti_aturan":  # the rule-evidence lane set f: (judge + rule strength)/2
            aturan = (f"(hakim {PC.des(ctx['p'] or 0)} + k {PC.des(jl.get('k_aturan') or 0)})/2 = {PC.des(jl.get('f_aturan') or f_g)} "
                      f"{'≥' if f_g >= tau else '<'} τ {PC.des(tau)} · jalur bukti aturan (jalur ML {PC.des(jl.get('f_ml') or 0)})")
    kol = [("aturan", aturan), ("skor risiko", PC.des(rec["skor_risiko"], 3))]
    if rec.get("prioritas"):
        kol.append(("prioritas", f"{rec['prioritas']} · indeks {angka(rec['indeks_prioritas'])}"))
    N.append(simpul_jejak("kep", 8, 1, "app", "filter", "Keputusan · gerbang", kep,
                          {"TAHAN": "tanpa swarm", "PERIKSA": "antrean verifikator", "DIBERSIHKAN": "tidak masuk antrean"}[kep],
                          "testing/laporan_cabang.py · muat()", kol, alert=antre))
    # 13. the ledger tag and the loss estimate priced from it (the same number Box Karantina reads)
    ka = rec.get("keputusan_ai") or {}
    if antre and rec.get("tag"):
        lvl = "sedang" if kep == "TAHAN" or ka.get("keyakinan") == "Tinggi" else "lemah"
        N.append(simpul_jejak("tag", 9, 1, "nexus", "list", "Buku besar · tag", f"rugi {rp_singkat(rugi)}", rec.get("tag_label") or rec["tag"],
                              "api/aip/realtime/cabang_tag.py", [
                                  ("tag · kekuatan", f"{rec['tag']} · {lvl}"),
                                  ("dari", "verifikasi IoT alat medis" if rec["tag"] == LC.TAG_IOT else f"famili {ka.get('famili') or '-'} ({'pendorong SHAP + aturan' if kep == 'TAHAN' else 'hakim'})"),
                                  ("hitungan", hitungan_kerugian(rec["tag"], int(rec.get("biaya_rp") or biaya), int(rec.get("tarif_rp") or tarif), topup, rec.get("inacbg") or kode, J["ref"], iot)),
                                  ("estimasi kerugian", rp(rugi))],
                              alert=rugi > 0))
    else:
        N.append(simpul_jejak("tag", 9, 1, "nexus", "list", "Buku besar · tag", "tanpa tag", "tidak ditulis", "api/aip/realtime/cabang_tag.py",
                              [("buku besar", "dibersihkan swarm: tidak ditulis, rugi Rp 0")], off=True))
    # 14. Box Karantina: the hospital's group (its share of the branch's loss) and its TSM path
    if rs:
        t = rs.get("tsm") or {}
        est = float(rs.get("estimasi_kerugian_rp") or 0)
        kol = [("RS", rs["nama"]), ("kelompok", f"{rs['kelompok']} · {BAND.get(rs['kelompok'], '')} kumulatif KC"),
               ("estimasi RS", f"{rp(est)} · {angka(100 * float(rs.get('porsi_kerugian') or 0), 1)}% KC")]
        if t:
            kol.append(("T · S · M", " · ".join(str((t.get(x) or {}).get("nilai", "—")) for x in ("terstruktur", "sistematis", "masif"))))
        kol.append(("klaim ini", f"{rp(rugi)} = {angka(100 * rugi / est, 1)}% RS" if antre and est else "Rp 0 (tidak menambah kerugian RS)"))
        N.append(simpul_jejak("box", 10, 0, "nexus", "lock", "Box Karantina", f"kelompok {rs['kelompok']}", f"jalur {rs.get('jalur') or '—'}",
                              f"{rel(kc_file)} · berkas_rs", kol, off=not antre, alert=antre and rs["kelompok"] in ("A", "B")))
    else:
        N.append(simpul_jejak("box", 10, 0, "nexus", "lock", "Box Karantina", "tanpa berkas RS", "tidak ada rekomendasi", f"{rel(kc_file)} · berkas_rs",
                              [("RS", rec.get("rs") or "—"), ("Box", "RS tanpa klaim direkomendasikan: tidak ada berkas RS")], off=True))
    # 15. the case file and the figure the report shows
    md = g["penjelasan"]["modus"]
    kol = [("keputusan", f"{kep} · {KEP_NAMA[kep]}"), ("modus", f"{md['kode']} · {md['nama']}" if md["kode"] not in ("", "-") else md["nama"]),
           ("rugi ≈", f"{rp(rugi)} · {rec.get('dasar_kerugian') or ''}" if antre else "Rp 0 (tidak masuk antrean)")]
    N.append(simpul_jejak("berkas", 11, 1, "app", "project", "Berkas kasus", rec["id"],
                          f"rugi ≈ {rp_singkat(rugi)} · {rec['prioritas']}" if antre else "dibersihkan swarm", f"{rel(kc_file)} · kasus", kol))
    if iot:  # the IoT layer (testing/iot_cabang.py): a current clamp on the device's power cable, and the evidence's anchor
        tr, bk = iot["tarif"], iot["bukti"]
        alat = ", ".join(f"{x['id']} {angka(x['jam_nyala'], 1)} jam" for x in iot.get("alat") or [])[:110] or "tidak ada sesi alat"
        mj = iot["terukur"].get("mode_jam") or {}
        if "jalan" in mj and "siaga" in mj:  # a ventilator: jalan / siaga (the clamp's states)
            terukur = (f"jalan {angka(mj['jalan'], 1)} jam · siaga {angka(mj['siaga'], 1)} jam · jalan terpanjang tanpa putus "
                       f"{angka(iot['terukur']['jam_berturut_maks'], 1)} jam")
        else:
            terukur = f"{angka(iot['terukur']['jam_total'], 1)} jam nyala · terpanjang {angka(iot['terukur']['jam_berturut_maks'], 1)} jam"
        N.append(simpul_jejak("iot", 4, 0, "data", "bolt", "IoT alat medis", {"tidak_sesuai": "tidak sesuai", "sesuai": "sesuai", "tanpa_bukti": "tanpa bukti"}.get(iot["hasil"], iot["hasil"]),
                              f"{len(iot.get('sesi') or [])} sesi · aturan {iot['aturan']}", "data/aip/cabang/iot/<set>/bukti.json", [
                                  ("ditagih", f"{iot['ditagih']['prosedur']} · {angka(iot['ditagih']['jam'] or 0, 1)} jam · {iot['ditagih']['inacbg']}"),
                                  ("terukur", terukur),
                                  ("alat (sensor clamp pada kabel daya)", alat), ("selisih tarif", f"{rp(tr['selisih_rp'])} ({tr['kode_seharusnya']})")]
                              + ([("data run", f"{iot['klaim_asli']['inacbg']} · {rp(iot['klaim_asli']['tarif_rp'])} (ventilasi sintetis)")] if iot.get("klaim_asli") else []),
                              alert=iot["hasil"] == "tidak_sesuai"))
        N.append(simpul_jejak("bc", 5, 0, "nexus", "lock", "Blockchain (jangkar bukti)", "rantai utuh" if bk.get("rantai_ok") else "tidak cocok" if bk.get("merkle_root") else "tanpa jangkar",
                              f"{angka(bk.get('pembacaan') or 0)} pembacaan + ikatan sesi", "data/aip/cabang/iot/<set>/masukan/jangkar.json", [
                                  ("merkle root", (bk.get("merkle_root") or "—")[:22] + ("…" if bk.get("merkle_root") else "")),
                                  ("dijangkarkan", str(bk.get("dijangkarkan") or "—").replace("T", " ")), ("klaim diajukan", str(bk.get("klaim_diajukan") or "—")),
                                  ("catatan", str(bk.get("catatan") or "")[:90])], off=not bk.get("merkle_root"), alert=bool(bk.get("merkle_root")) and not bk.get("rantai_ok")))
    aturan_tag = any(src == "aturan" for _lb, src, _k in tags)
    model_tag = any(src == "model" for _lb, src, _k in tags)
    E = [("raw", "val", "validasi skema", False), ("val", "eng", "rule engine", False), ("eng", "graf", "fitur.Stream · 4 relasi", False),
         ("eng", "mek", "fitur v4", False), ("graf", "row", "X1 · 624", False), ("mek", "row", "X4 · 22", False),
         ("row", "inf", "predict + SHAP", False), ("mdl", "inf", J["seed"], False),
         ("eng", "ind", "tag (kode)", not aturan_tag), ("inf", "ind", "tag model", not model_tag),
         ("inf", "dos", "berkas tanpa ID", not dos), ("dos", "swm", "spesialis → hakim", not (dos and ag and ragu)),
         ("swm", "kep", "gerbang τ", not (ag and ragu)), ("inf", "kep", f"zona {zona}", False),
         ("kep", "tag", "taksir_kerugian", not antre), ("tag", "box", "aturan Box", not (antre and rs)),
         ("ind", "box", "modus per RS (TSM)", not (tags and rs)), ("box", "berkas", "berkas RS", not rs), ("tag", "berkas", "estimasi kerugian", not antre)]
    if iot:
        E += [("raw", "iot", "kunjungan · peserta", False), ("iot", "bc", "hash + Merkle root", False),
              ("bc", "ind", "tag IoT", iot["hasil"] != "tidak_sesuai"), ("bc", "kep", "verifikasi IoT", not naik_iot)]
    return {"nodes": N, "edges": [{"from": x, "to": y, "label": lb, **({"off": True} if o else {})} for x, y, lb, o in E]}


def modus_rs_ke_laporan(fp: Path, g: dict) -> None:
    """Each hospital's main indication as its claims' explanations name it (the Permenkes 16/2019 mode of penjelasan_cabang),
    written into the report's hospital case files and hospital table, so the hospital summary says what its claim files say.
    The loss tables keep the ledger tag (the basis of the estimate, the same as Box Karantina)."""
    L = json.loads(fp.read_text("utf-8"))
    if "berkas_rs" not in L:
        return
    kep = {c["id"]: c["keputusan"] for c in L["kasus"]}
    teks = {}
    for b in L["berkas_rs"]:
        n: Counter = Counter()
        for x in b["kasus"]:
            p = (g.get(x) or {}).get("penjelasan")
            if p and kep.get(x) in ("TAHAN", "PERIKSA"):
                n[(p["modus"]["kode"], p["modus"]["nama"])] += 1
        b["modus_klaim"] = [{"kode": k, "nama": nm, "klaim": v} for (k, nm), v in n.most_common()]
        if n:
            (k, nm), v = n.most_common(1)[0]
            teks[b["faskes_profil_id"]] = f"{k + ' · ' if k and k != '-' else ''}{nm} ({v} klaim)"
    for e in L["exhibit"]:
        if e["id"] != "rs-prioritas":
            continue
        lama = {}
        for r in e["baris"]:
            if r["faskes_profil_id"] in teks:
                lama[r["faskes"]] = (r["modus"], teks[r["faskes_profil_id"]])
                r["modus"] = teks[r["faskes_profil_id"]]
        for c in e.get("kolom") or []:
            if c["key"] == "modus":
                c["label"] = "Indikasi utama (penjelasan klaim)"
        e["fakta"] = [next((f.replace(f"modus utama {a.lower()}", f"indikasi utama {b_}") for nm_, (a, b_) in lama.items() if f.startswith(f"{nm_}:")), f)
                      for f in e["fakta"]]
    fp.write_text(json.dumps(L, ensure_ascii=False, default=str), "utf-8")


def tulis_json(fp: Path, d: dict) -> None:
    fp.write_text(json.dumps(d, ensure_ascii=False, default=int, separators=(",", ":")), "utf-8")


def ganti_folder(baru: Path, lama: Path) -> None:
    """Swap the freshly written folder in for the stale one (a few tries: on Windows a file the web server or a scanner holds
    for a moment blocks the delete or the rename)."""
    for coba in range(5):
        try:
            if lama.exists():
                shutil.rmtree(lama)
            baru.rename(lama)
            return
        except OSError:
            if coba == 4:
                raise
            time.sleep(1.0)


def main(nama: str, kc_pilih: str = "") -> None:
    if LC.RIIL:
        sys.exit("graf_cabang: real-sample runs are not supported (the stream here is the synthetic /testing one)")
    t0 = time.time()
    OUT = LC.BASIS / nama
    files = sorted(OUT.glob(f"kc_{kc_pilih or '*'}.json"))
    if not files:
        sys.exit(f"no branch report in {OUT} (run testing/laporan_cabang.py --set {nama} first)")
    M = LC.muat(nama)
    z, F, kep = M["z"], M["F"], M["kep"]
    kunci = [str(k) for k in z["kunci"]]
    klm = {"KLM-" + hashlib.md5(k.encode()).hexdigest()[:8].upper(): k for k in kunci}
    zi = {k: n for n, k in enumerate(kunci)}

    def kunci_kasus(c: dict) -> str | None:
        """The claim a case file is about: its own key when the report carries it (laporan_cabang since 2026-11-15; 8 hex of md5
        collide on a run of ~700k claims, so the id alone could attach another claim's graph), else the id's md5 (older reports)."""
        if c.get("kunci") is not None:
            return str(c["kunci"]) if str(c["kunci"]) in zi else None
        return klm.get(c["id"])

    # every case file of the run (a neighbour in another branch's queue is named, not linked)
    kasus_of, target, kasus_rec = {}, {}, {}
    for fp in sorted(OUT.glob("kc_*.json")):
        kid = fp.stem[3:]
        for c in json.loads(fp.read_text("utf-8"))["kasus"]:
            k = kunci_kasus(c)
            if k is None:
                print(f"  {kid}: {c['id']} not found in zona_{nama}.npz; skipped")
                continue
            kasus_of[k] = {"id": c["id"], "kc": kid, "keputusan": c["keputusan"]}
            if fp in files:
                target[k] = (kid, c["id"])
                kasus_rec[k] = c
    label_rs = LC.nama_rs(M["rs"])  # the report's unique names (class · ownership · kab/kota)
    # the explanation's facts: thresholds, review rules, the network rule, the code medians, and the screening model (for its SHAP push per block)
    import joblib
    import pandas as pd
    import v5 as V5

    K = M["K"]
    amb = K["ambang"]
    ambang = {"tahan": float(amb["tahan"]), "ragu": float(amb.get("lebar") or amb.get("ragu")), "periksa": float(amb.get("periksa_v4") or 0)}
    aturan_v4 = {r["aturan"]: {"fitur": r["fitur"], "ambang": r["ambang"]} for r in json.loads((LC.ROOT / ".tmp" / "data_v4" / "aturan_v4.json").read_text("utf-8"))["dipilih"]}
    b3 = joblib.load(LC.HERE / "model_v3_bersih" / "model.joblib")
    rj = b3.get("rule_jaringan") or {"kolom": 0, "ambang": 2}
    if M["model"] == "ml_v7":
        model_file = LC.HERE / "model_ml_v7" / "model.joblib"
        b7 = joblib.load(model_file)
        model_skor, model_versi = b7["kandidat"][b7["pilihan"]]["models"], f"pilihan {b7['pilihan']}"
    else:
        model_file = V5.V4.MODEL / "model.joblib"
        b4 = joblib.load(model_file)
        model_skor, model_versi = b4["models"], f"varian {b4.get('varian') or '-'}"
    los_med = pd.DataFrame({"kode": F["kode"].astype(str), "los": F["los"].astype(float)}).groupby("kode")["los"].median().to_dict()
    p_hakim = np.nan_to_num(M["p"], nan=-1.0)

    def ctx_untuk(n_z: int, raw: dict, i: int) -> tuple[dict, np.ndarray]:
        X = np.hstack([raw["X1"][i], raw["X4"][i]])[None].astype(np.float32)
        contrib = np.mean([mm.booster_.predict(X, pred_contrib=True)[0] for mm in model_skor], axis=0)
        naik = np.clip(contrib[:-1], 0, None)
        kode = str(raw["kode"][i])
        return {"model": M["model_nama"], "s": float(z["s"][n_z]), "q": float(M["q"][n_z]), "f": float(M["f"][n_z]),
                "p": float(p_hakim[n_z]) if p_hakim[n_z] >= 0 else None, "zona_tahan": bool(z["tahan"][n_z]), "zona_ragu": bool(z["ragu"][n_z]),
                "ambang": ambang, "tau": float(K["tau"]), "pilihan": K["pilihan"], "skor_rule": float(raw["skor_rule"][i]),
                "sinyal": str(raw["sinyal"][i]).split(), "x4": dict(zip(F4.NAMES, (float(x) for x in raw["X4"][i]))),
                "xr3": int(round(float(np.expm1(raw["XR"][i][rj["kolom"]])))), "rj_ambang": float(rj["ambang"]), "aturan_v4": aturan_v4,
                "ref": {"los_median": los_med.get(kode), "biaya_median": M["ref_biaya"]["biaya"].get(kode), "topup_median": M["ref_biaya"]["topup"].get(kode)},
                "dorongan": {nm: round(float(naik[a:b].sum() / max(float(naik.sum()), 1e-9)), 4) for nm, a, b in BLOK},
                # the medical-record evidence the engine wrote (penjelasan's bukti_sinyal) and the rule-evidence lane's record, when the run has them
                "bukti_sinyal": json.loads(str(raw["rme_bukti"][i])) if "rme_bukti" in raw and str(raw["rme_bukti"][i]) else {},
                "jalur": (M.get("gerbang") or {}).get(str(z["kunci"][n_z]))}, contrib

    # the lineage's facts shared by every case: the schema's checks, the engine's signal names, the feature names, the model
    # file, where the zones, dossiers and agents' answers live, each claim's indications and each hospital's Box entry
    import cabang_analisis as CA
    import swarm_v5 as SW
    from aip import layanan as LY
    from aip.realtime import modus as MO

    def meta_skema(nm: str, attr: str):
        return next((getattr(m, attr) for m in LY.KlaimIn.model_fields[nm].metadata if getattr(m, attr, None) is not None), None)

    nama_fitur = list(b3["agg_names"]) + list(F4.NAMES)
    teknik = "LightGBM" if "LGBM" in type(model_skor[0]).__name__ else type(model_skor[0]).__name__
    kartu_m = model_file.parent / "kartu.json"
    beku = json.loads(kartu_m.read_text("utf-8")).get("dibekukan", "—") if kartu_m.exists() else "—"
    zona_meta = LC.KERJA / f"zona_{nama}.json"
    J = {"n_kolom": len(LY.KlaimIn.model_fields), "pola": {nm: meta_skema(nm, "pattern") for nm in ("dx_primer_icd3", "inacbg_kode")},
         "batas": {nm: (meta_skema(nm, "ge"), meta_skema(nm, "le")) for nm in ("biaya_tagih_rp", "los_hari")},
         "sinyal": {k: v[3] for k, v in MO.SIGNALS.items()}, "x4_label": SW.X4_LABEL, "label": lambda j: CA.nama_fitur(nama_fitur[j], SW.X4_LABEL),
         "ref": M["ref_biaya"], "seed": f"rata-rata {len(model_skor)} seed", "zona_file": rel(LC.KERJA / f"zona_{nama}.npz"),
         "dossier_file": rel(LC.KERJA / f"berkas_{nama}.jsonl"), "agen_file": rel(LC.KERJA / f"agen_{nama}.json"),
         "model": simpul_jejak("mdl", 4, 2, "ml", "cpu", f"Model · {M['model_nama']}", model_file.name, f"{teknik} × {len(model_skor)} · {model_versi}", rel(model_file), [
             ("fitur · seed", f"{getattr(model_skor[0], 'n_features_in_', '—')} · {len(model_skor)} seed, skor dirata-rata"),
             ("dibekukan", beku), ("berkas", f"{angka(model_file.stat().st_size / 1e6, 1)} MB · sha256 {hashlib.sha256(model_file.read_bytes()).hexdigest()[:12]}"),
             ("ambang zona", f"TAHAN ≥ {PC.des(ambang['tahan'], 4)} · RAGU ≥ {PC.des(ambang['ragu'], 4)} ({(zona_meta if zona_meta.exists() else LC.HERE / 'model_v5' / 'kartu.json').name})")])}
    ind_klaim = LC.indikasi_kc(np.array(sorted(zi[k] for k in target), dtype=int), M)["_per_klaim"]
    kc_semua = sorted(fp.stem[3:] for fp in OUT.glob("kc_*.json"))
    dossier: dict[str, tuple] = {}  # the branch's own dossier file first (a one-branch swarm run reads only that), then the run's
    for f_ in [LC.KERJA / f"berkas_{nama}_{kid}.jsonl" for kid in kc_semua] + [LC.KERJA / f"berkas_{nama}_swarm.jsonl", LC.KERJA / f"berkas_{nama}.jsonl"]:
        if not f_.exists():
            continue
        baris = f_.read_text("utf-8").splitlines()
        for no, ln in enumerate(baris, 1):
            dd = json.loads(ln)
            if dd["kunci"] in target and dd["kunci"] not in dossier:
                dossier[dd["kunci"]] = (f_, no, len(baris), dd["teks"])
    rs_box = {(fp.stem[3:], b["faskes_profil_id"]): b for fp in files for b in json.loads(fp.read_text("utf-8")).get("berkas_rs") or []}

    SET = LC.SET_ROOT / nama
    basis_recs = baca_basis(min(f.stat().st_mtime for f in SET.glob("hasil_[0-9][0-9].npz")))
    basis_fields = [FT.claim_fields(e) for e in basis_recs]
    basis_view = []
    for e, fd in zip(basis_recs, basis_fields):
        d = fd["day"]
        p = hari(e.get("tgl_pulang") or e.get("tgl_datang") or "")
        basis_view.append({"peserta_key": e.get("peserta"), "faskes": fd["faskes"], "kode": fd["kode"], "d": d, "p": max(d, p), "tingkat": e.get("tingkat") or "",
                           "los": int(e.get("los") or 0), "biaya": int(e.get("biaya") or 0), "tarif": int(e.get("tarif") or 0), "dx": e.get("dx3") or "", "asal": "riwayat",
                           "rs": label_rs.get(fd["faskes"]) or (e.get("faskes_label") or "").split(" · ")[0] or f"RS {fd['faskes'][:6]}",
                           "keputusan": None, "keputusan_mesin": e.get("keputusan"), "sinyal": [str(s.get("kode")) for s in e.get("sinyal") or []]})
    print(f"basis stream {len(basis_recs)} claims ({time.time() - t0:.0f} s)")
    SET = LC.SET_ROOT / nama
    per_kc: dict[str, dict] = {fp.stem[3:]: {} for fp in files}  # per case only what the index keeps; the case file is written at once
    salah_kc: Counter = Counter()
    sementara = {kid: OUT / f"graf_{kid}.tmp" for kid in per_kc}  # each branch's folder, written beside and swapped in at the end
    for d_ in sementara.values():
        if d_.exists():
            shutil.rmtree(d_)  # left by an interrupted run
        d_.mkdir(parents=True)
    cek = {"klaim_dicek": 0, "tidak_cocok": 0, "chunk": {}}
    for hf in sorted(SET.glob("hasil_[0-9][0-9].npz")):
        c = int(hf.stem.split("_")[1])
        raw = dict(np.load(hf, allow_pickle=False))
        n = len(raw["kode"])
        mau = {i: target[f"{nama}:{c}:{i}"] for i in range(n) if f"{nama}:{c}:{i}" in target}
        if not mau:
            continue
        st = FT.Stream(np.zeros((len(basis_fields), 1), np.float32), basis_fields, np.zeros(1, np.float32), np.ones(1, np.float32))
        V = Pandangan(basis_view, label_rs)
        nol = np.zeros(1, np.float32)
        salah = 0
        for i in range(max(mau) + 1):
            k = f"{nama}:{c}:{i}"
            pid, fk, kode, tingkat = str(raw["peserta"][i]), str(raw["faskes"][i]), str(raw["kode"][i]), str(raw["tingkat"][i])
            fd = FT.claim_fields({"peserta": pid, "faskes": fk, "kode": kode, "tgl_datang": str(raw["tgl"][i]), "tingkat": tingkat})
            los = int(raw["los"][i])
            n_z = zi.get(k)
            V.batch.append({"peserta_key": pid, "faskes": fk, "kode": kode, "d": fd["day"], "p": fd["day"] + (los if tingkat == "RITL" else 0), "tingkat": tingkat,
                            "los": los, "biaya": int(raw["biaya"][i]), "tarif": int(raw["tarif"][i]), "dx": str(raw["dx"][i]) if "dx" in raw else "", "asal": "batch", "kunci": k,
                            "rs": V.rs(fk), "keputusan": str(kep[n_z]) if n_z is not None else None, "keputusan_mesin": str(raw["keputusan"][i]),
                            "sinyal": str(raw["sinyal"][i]).split()})
            j = st.append(nol, fd)
            if i in mau:
                kid, cid = mau[i]
                g = graf_klaim(st, V, j, raw["X1"][i], raw["XR"][i], M["desk"], kasus_of)
                g["fokus"]["kasus"] = kasus_of[k]
                ctx, contrib = ctx_untuk(n_z, raw, i)
                g["penjelasan"] = PC.tanpa_kode(PC.jelaskan(kasus_rec[k], g, ctx))
                g["jejak"] = jejak_klaim(J, kc_file=OUT / f"kc_{kid}.json", hf=hf, i=i, raw=raw, rec=kasus_rec[k], g=g, ctx=ctx, contrib=contrib,
                                         tags=ind_klaim.get(int(n_z), []), dos=dossier.get(k), rs=rs_box.get((kid, fk)))
                if kasus_rec[k].get("iot"):  # the device evidence (testing/iot_cabang.py), as the report's case carries it
                    g["iot"] = kasus_rec[k]["iot"]
                tulis_json(sementara[kid] / f"{cid}.json", g)
                # the claim lists before a file is opened (SwarmCabangView): the fraud type, the one sentence of evidence for it and its
                # confidence ("Bukti per jenis fraud"), and any other type the explanation names
                jf = g["penjelasan"].get("jenis_fraud") or []
                m0 = g["penjelasan"]["modus"]
                utama = next((x for x in jf if x.get("kode") == m0.get("kode")), jf[0] if jf else None)
                per_kc[kid][cid] = {"modus": m0, **({"bukti": str(utama.get("bukti") or "")[:240], "keyakinan": utama.get("keyakinan")} if utama else {}),
                                    **({"lain": [{"kode": x["kode"], "nama": x["nama"]} for x in jf if x is not utama][:3]} if len(jf) > 1 else {})}
                salah_kc[kid] += not g["cocok"]
                cek["klaim_dicek"] += 1
                salah += not g["cocok"]
        cek["tidak_cocok"] += salah
        cek["chunk"][c] = {"kasus": len(mau), "tidak_cocok": salah}
        print(f"chunk {c}: {len(mau)} case files, {salah} not matching the saved features ({time.time() - t0:.0f} s)")
    for kid, ring in per_kc.items():
        # the index last (the API serves a folder only once its index is there), then the folder replaces the stale one
        tulis_json(sementara[kid] / "index.json", {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "run": nama, "kc": kid, "hari_cincin": HARI_CINCIN,
                                                   "maks": FT.CAPS, "relasi_nama": FT.RELASI_NAMA, "kasus": ring,
                                                   "cek": {"klaim": len(ring), "tidak_cocok": salah_kc[kid]}})
        ganti_folder(sementara[kid], OUT / f"graf_{kid}")
        (OUT / f"graf_{kid}.json").unlink(missing_ok=True)  # the single file of a build before 2026-11-15, now stale
        modus_rs_ke_laporan(OUT / f"kc_{kid}.json", {cid: {"penjelasan": s} for cid, s in ring.items()})
    # "branch graph file" is the line testing/jalan_kc_tema.py picks from this output
    print(f"{len(per_kc)} branch graph file(s) -> {OUT} (graf_<kc>/index.json + one file per case); "
          f"{cek['klaim_dicek']} case files, {cek['tidak_cocok']} not matching; {time.time() - t0:.0f} s")
    if cek["tidak_cocok"]:
        print("WARNING: some rebuilt networks differ from the features the model read (graph marked approximate)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="gen3_kc2")
    ap.add_argument("--kc", default="", help="one branch id (e.g. sul-7371); default: every branch report of the run")
    a = ap.parse_args()
    main(a.set, a.kc)
