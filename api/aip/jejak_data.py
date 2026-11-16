"""The lineage of one claim of a case file, layer by layer, each layer with the claim's own values in it: the BPJS source
file, bronze, silver, gold and its Nexus object, the ML inference the claim passed through (the model's pickle run on
the claim's feature row), the indications on it, the Box rule that turns it into a loss, and the case file's figure
(the user, 2026-10-24: "visualisasi data lineage dari Berkas kasus per faskes sampai data mentah transaksinya … node
file pickle buat nunjukin data mentah ini udh lewat node ML inference").

- Every dataset is read from Files as the caller (drive._item: markings and the project role); a layer the caller may
  not read is shown closed, with the reason, and the rest still traced.
- The containers and the transforms named are the platform lineage's own (GET /api/lineage/graph, 2026-10-28:
  raw .dta → bronze_fkrtl_bagian_N → fkrtl_bagian_N.parquet → Pipeline Builder "Pipeline Data Sampel BPJS: Data Mentah → Siap Analisis" (node
  kunjungan_fkrtl → kunjungan_fkrtl.parquet, node klaim_berisiko → klaim_berisiko.parquet → Klaim Berisiko (BPJS), node klaim_fkrtl →
  klaim_fkrtl.parquet) → the second pipeline "Fakta Klaim BPJS: Siap Analisis → Fakta Klaim" → klaim_fkrtl_fakta.parquet → the live type
  Klaim FKRTL (BPJS) the swarm reads; the model scores skor_risiko_klaim_ml.parquet; the automatic tagger and the swarm write the Box).
- The ML layer runs the deployed version's model.pkl on the claim's row of the feature table the model was trained and
  scored from (aip/ml.py cache), as score_all does for every claim: its risk, the segment's threshold, the TreeSHAP
  reasons, and whether the published scores (the riskiest and the corrected, ml.KEEP_TOP) hold the claim. One model
  scores a claim — its segment's, chosen by the cross-validated benchmark — and the benchmark's other techniques come
  with it as the leaderboard they lost (they keep no score per claim: the user asked why one model shows, 2026-10-28).

    GET /api/aip/konsultan/{run}/laporan-lengkap/jejak?klaim=<edisi:kunjungan>&faskes=<profil>
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from aip import indikasi as I
from aip import karantina as K
from aip import semantik as S

PROJECT = "Data Sampel BPJS 2025"
P = "Pipeline Data Sampel BPJS: Data Mentah → Siap Analisis"  # the Pipeline Builder pipeline that writes silver and gold
P2 = "Fakta Klaim BPJS: Siap Analisis → Fakta Klaim"  # the second pipeline: facts on every claim, not verdicts
# klaim_fkrtl: every claim (5.4 million), the first pipeline's national table the facts are computed from
ALL = [("bobot", "Bobot sampel", "klaim populasi yang diwakili baris ini"), ("jumlah_edisi", "Jumlah edisi", "edisi data yang memuat klaim yang sama"),
       ("klaim_kanonik", "Klaim kanonik", "satu baris per klaim nasional; yang lain salinannya di edisi lain"), ("rawat_inap", "Rawat inap", ""),
       ("los_hari", "Lama rawat (hari)", ""), ("tarif_inacbg_rp", "Tarif INA-CBG", ""), ("topup_subakut_rp", "Top-up subakut/kronis", ""),
       ("topup_khusus_rp", "Top-up khusus", ""), ("biaya_tagih_rp", "Biaya tagih", ""),
       ("sisa_di_luar_tarif_rp", "Di luar tarif", "tagih − tarif INA-CBG − top-up"), ("readmisi_30", "Readmisi 30 hari", "")]
# the facts' own detail columns beside their flags (the flags are named by the rule catalogue, aip/aturan.py)
FACT_DETAIL = [("kelas_hak", "Hak kelas peserta", ""), ("jumlah_tumpang_tindih", "Rawat inap yang bertumpuk", ""),
               ("klaim_tumpang_tindih_id", "Klaim yang bertumpuk", ""), ("jumlah_klaim_hari_sama", "Klaim di hari yang sama", ""),
               ("hari_ke_inap_berikut", "Hari ke rawat inap berikutnya", ""), ("flag_readmisi_dx_sama", "Readmisi dengan diagnosis sama", "")]
# the raw FKRTL columns a reader follows through the layers (bronze keeps the source's own names and codes)
RAW = ["FKL02", "PSTV01", "FKL03", "FKL04", "FKL06", "FKL08", "FKL09", "FKL10", "FKL11", "FKL13", "FKL14", "FKL19", "FKL23", "FKL18", "FKL18A",
       "FKL30", "FKL31", "FKL47", "FKL48"]
SILVER = [("kunjungan_fkrtl_id", "ID kunjungan", ""), ("peserta_id", "Peserta", ""), ("tgl_datang", "Tanggal datang", ""), ("tgl_pulang", "Tanggal pulang", ""),
          ("los_hari", "Lama rawat (hari)", "tgl_pulang − tgl_datang"), ("kabkota_fkrtl", "Kab/kota faskes", "kode FKL06 → nama (label_nilai)"),
          ("jenis_fkrtl", "Jenis faskes", "label"), ("tipe_fkrtl", "Tipe faskes", "label"), ("tingkat_pelayanan", "Tingkat pelayanan", "label"),
          ("poli", "Poli", "label"), ("kelas_rawat", "Kelas rawat", "label"), ("status_pulang", "Status pulang", "label"),
          ("inacbg_kode", "INA-CBG", ""), ("inacbg_keparahan", "Keparahan", "label"), ("dx_primer_kode", "Diagnosis primer (kode)", ""),
          ("dx_primer_nama", "Diagnosis primer", ""), ("prosedur", "Prosedur", ""), ("tarif_inacbg_rp", "Tarif INA-CBG", ""),
          ("biaya_tagih_rp", "Biaya tagih", ""), ("biaya_verifikasi_rp", "Biaya verifikasi", ""), ("selisih_rp", "Selisih (dikoreksi)", "tagih − verifikasi"),
          ("flag_calon_klaim_ganda", "Flag calon klaim ganda", "peserta, tanggal, INA-CBG, biaya sama dengan klaim lain"),
          ("flag_los_ekstrem", "Flag LOS ekstrem", "LOS > p99 kodenya dan > 3 hari")]
GOLD = [("topup_subakut_rp", "Top-up subakut/kronis", "special CMG FKL34, di luar paket"),
        ("topup_khusus_rp", "Top-up khusus", "prosedur, prostesis, investigasi, obat khusus (FKL37+40+43+46)"),
        ("sisa_di_luar_tarif_rp", "Di luar tarif", "tagih − tarif INA-CBG − top-up"),
        ("peer_klaim", "Klaim peer setarif", "klaim dengan INA-CBG, tipe RS, regional, kepemilikan, kelas rawat, tahun tarif dan edisi sama"),
        ("peer_biaya_p50_rp", "Median biaya peer", "median biaya tagih peer setarif"), ("rasio_biaya_peer", "Rasio biaya / peer", "biaya tagih ÷ median peer setarif"),
        ("peer_los_inap_p90", "LOS p90 peer", "persentil 90 lama rawat inap peer"), ("indikasi_utama", "Indikasi utama", "aturan skrining Siap Analisis"),
        ("skor_risiko", "Skor risiko aturan", "35·ganda + 25·selisih + 25·LOS + 10·readmisi + rasio peer"), ("alasan_risiko", "Alasan", "")]
MONEY = {"FKL47", "FKL48", "tarif_inacbg_rp", "biaya_tagih_rp", "biaya_verifikasi_rp", "selisih_rp", "peer_biaya_p50_rp", "topup_subakut_rp", "topup_khusus_rp",
         "sisa_di_luar_tarif_rp"}
_cache: dict[tuple, tuple[float, dict]] = {}
_parts: dict[str, int] = {}  # edition → the bronze part (fkrtl_bagian_N) that holds it
_sha: dict[str, str] = {}
_lock = threading.Lock()


def _iso(v: Any) -> Any:
    if hasattr(v, "isoformat"):
        return v.isoformat()[:10]
    if isinstance(v, float) and v != v:
        return None
    if hasattr(v, "item"):
        return v.item()
    return v


def _file(*path: str) -> tuple[dict, Path]:
    """A dataset of the project in Files, as the caller (403/404 raise): its item and a local path to read."""
    import drive

    from aip import ml as aip_ml

    node = aip_ml._child(None, PROJECT)
    for name in path:
        node = node and aip_ml._child(node["id"], name)
    if not node:
        raise HTTPException(404, f"{'/'.join(path)} tidak ada di {PROJECT}")
    item = drive._item(node["id"])
    return item, aip_ml._local(item, Path(tempfile.gettempdir()))


def _query(path: Path, sql: str, args: list) -> list[dict]:
    import duckdb

    con = duckdb.connect()
    try:
        cur = con.execute(sql.replace("{src}", f"read_parquet('{path.as_posix()}')"), args)
        cols = [d[0] for d in cur.description]
        return [{c: _iso(v) for c, v in zip(cols, row, strict=True)} for row in cur.fetchall()]
    finally:
        con.close()


def _idn(n: float, d: int = 0) -> str:
    """A number in Indonesian notation: 1.234.567; 0,090."""
    return f"{n:,.{d}f}".replace(",", "_").replace(".", ",").replace("_", ".")


def _layer(lid: str, judul: str, wadah: str, proses: str = "", **extra: Any) -> dict:
    return {"id": lid, "judul": judul, "wadah": wadah, "proses": proses, **extra}


def _closed(lid: str, judul: str, e: Exception) -> dict:
    why = getattr(e, "detail", None) or str(e)
    return _layer(lid, judul, "", tertutup=f"tidak terbaca untuk Anda: {str(why)[:200]}")


def _sha256(p: Path) -> str:
    key = f"{p}:{p.stat().st_mtime_ns}"
    if key not in _sha:
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        _sha[key] = h.hexdigest()
    return _sha[key]


def _raw_and_bronze(edisi: str, kid: str) -> list[dict]:
    """The source file the claim came in (its name, rows and fingerprint from the bronze manifest) and its row in bronze,
    the source's own columns and codes with their labels."""
    from aip import vertex as aip_vertex

    out: list[dict] = []
    manifest = aip_vertex.DIR.parent.parent / "bpjs-sampel" / "bronze" / "_manifest.json"
    try:
        src = next((m for m in json.loads(manifest.read_text("utf-8")) if m.get("tabel") == "fkrtl" and m.get("edisi") == edisi), {})
    except (OSError, ValueError):
        src = {}
    row, part, labels = None, None, {}
    for n in ([_parts[edisi]] if edisi in _parts else [1, 2]):
        try:
            _, path = _file("bronze", f"fkrtl_bagian_{n}.parquet")
        except HTTPException as e:
            out.append(_closed("bronze", "Data Mentah", e))
            return out
        got = _query(path, f"SELECT {', '.join(RAW)} FROM {{src}} WHERE edisi = ? AND FKL02 = ? LIMIT 1", [edisi, kid])
        if got:
            row, part, _parts[edisi] = got[0], n, n
            break
    if part:
        try:
            _, kat = _file("bronze", "_meta", f"katalog_fkrtl_bagian_{part}.parquet")
            labels = {r["kolom"]: r["label"] for r in _query(kat, "SELECT kolom, any_value(label) AS label FROM {src} GROUP BY 1", [])}
        except HTTPException:
            labels = {}
    out.append(_layer("mentah", "Arsip Sumber", f"Files · {PROJECT} / raw / fkrtl_bagian_{part or '?'} / {src.get('file', '?')}",
                      "diterima dari BPJS Kesehatan (Stata .dta)",
                      catatan=(f"{src.get('rows', 0):,} baris · sha256 {str(src.get('sha256', ''))[:16]}… · edisi {edisi}".replace(",", ".")
                               if src else "manifest bronze tidak terbaca")))
    out.append(_layer("bronze", "Data Mentah", f"Files · bronze / fkrtl_bagian_{part or '?'}.parquet", f"transform bronze_fkrtl_bagian_{part or '?'}: .dta → Parquet, kolom dan nilai apa adanya",
                      kolom=[{"kode": c, "nama": labels.get(c, c), "nilai": row.get(c), "uang": c in MONEY} for c in RAW] if row else [],
                      catatan="" if row else "baris klaim ini tidak ditemukan di Data Mentah"))
    return out


def _silver(edisi: str, kid: str) -> tuple[dict, dict]:
    try:
        _, path = _file("silver", "kunjungan_fkrtl.parquet")
    except HTTPException as e:
        return _closed("silver", "Data Bersih", e), {}
    got = _query(path, f"SELECT {', '.join(c for c, _, _ in SILVER)} FROM {{src}} WHERE edisi = ? AND kunjungan_fkrtl_id = ? LIMIT 1", [edisi, kid])
    row = got[0] if got else {}
    return _layer("silver", "Data Bersih", "Files · silver / kunjungan_fkrtl.parquet",
                  f"Pipeline Builder {P!r} · node kunjungan_fkrtl: nama kolom, tipe data, kode → label (Mapping join), kolom turunan, flag aturan",
                  kolom=[{"nama": n, "nilai": row.get(c), "turunan": how if how and how != "label" else "", "label": how == "label", "uang": c in MONEY}
                         for c, n, how in SILVER] if row else [],
                  catatan="" if row else "baris klaim ini tidak ditemukan di Data Bersih"), row


def _gold(cid: str) -> tuple[dict, dict]:
    try:
        _, path = _file("gold", "klaim_berisiko.parquet")
    except HTTPException as e:
        return _closed("gold", "Siap Analisis", e), {}
    got = _query(path, f"SELECT {', '.join(c for c, _, _ in GOLD)}, biaya_tagih_rp FROM {{src}} WHERE klaim_id = ? LIMIT 1", [cid])
    row = got[0] if got else {}
    if not row:
        return _layer("gold", "Siap Analisis · Nexus", "Files · gold / klaim_berisiko.parquet → Nexus Klaim Berisiko (BPJS)", f"Pipeline Builder {P!r} · node klaim_berisiko",
                      catatan="tidak lolos skrining Siap Analisis (tanpa flag calon ganda, selisih verifikasi atau LOS ekstrem): klaim ini ditemukan dari Data Bersih "
                              "oleh penanda otomatis atau agen, tidak punya objek Klaim Berisiko"), {}
    return _layer("gold", "Siap Analisis · Nexus", "Files · gold / klaim_berisiko.parquet → objek Nexus Klaim Berisiko (BPJS)",
                  f"Pipeline Builder {P!r} · node klaim_berisiko (DuckDB): pembanding peer (Join), skor aturan (Formula); dataset itu yang mendasari tipe objeknya",
                  kolom=[{"nama": n, "nilai": row.get(c), "turunan": how, "uang": c in MONEY} for c, n, how in GOLD]), row


def _national(cid: str) -> list[dict]:
    """The claim in the first pipeline's national table (every claim, 5.4 million) and in the second pipeline's facts —
    the rows the live type Klaim FKRTL (BPJS) serves the swarm, whether or not the claim passed the screening."""
    from aip import aturan

    out: list[dict] = []
    try:
        _, path = _file("gold", "klaim_fkrtl.parquet")
        got = _query(path, f"SELECT {', '.join(c for c, _, _ in ALL)} FROM {{src}} WHERE klaim_id = ? LIMIT 1", [cid])
        row = got[0] if got else {}
        out.append(_layer("semua", "Siap Analisis · semua klaim", "Files · gold / klaim_fkrtl.parquet",
                          f"Pipeline Builder {P!r} · node klaim_fkrtl: setiap klaim dengan bobot sampel, edisi dan klaim kanonik",
                          kolom=[{"nama": n, "nilai": row.get(c), "turunan": how, "uang": c in MONEY or c.endswith("_rp")} for c, n, how in ALL] if row else [],
                          catatan="" if row else "baris klaim ini tidak ditemukan di tabel semua klaim"))
    except HTTPException as e:
        out.append(_closed("semua", "Siap Analisis · semua klaim", e))
    try:
        _, path = _file("gold", "klaim_fkrtl_fakta.parquet")
        rules = [r for r in aturan._rules() if r["lapisan"] == "fakta" and r.get("kolom")]
        cols = [r["kolom"] for r in rules] + [c for c, _, _ in FACT_DETAIL] + ["jumlah_fakta"]
        got = _query(path, f"SELECT {', '.join(cols)} FROM {{src}} WHERE klaim_id = ? LIMIT 1", [cid])
        row = got[0] if got else {}
        facts = [{"nama": r["nama"], "kode": r["kolom"], "nilai": row.get(r["kolom"]), "turunan": r["kondisi"], "tag": r.get("tag_label")} for r in rules]
        held = [f["nama"] for f in facts if f["nilai"] is True]
        out.append(_layer("fakta", "Fakta Klaim · Nexus", "Files · gold / klaim_fkrtl_fakta.parquet → objek Nexus Klaim FKRTL (BPJS)",
                          f"Pipeline Builder {P2!r} (pipeline kedua): fakta tiap klaim — bukan putusan; agen AI Agent Swarm membacanya lewat tipe live Klaim FKRTL (BPJS)",
                          kolom=(facts + [{"nama": n, "nilai": row.get(c), "turunan": how} for c, n, how in FACT_DETAIL]) if row else [],
                          jumlah_fakta=row.get("jumlah_fakta"), fakta_benar=held,
                          catatan="" if row else "baris klaim ini tidak ditemukan di Fakta Klaim"))
    except HTTPException as e:
        out.append(_closed("fakta", "Fakta Klaim · Nexus", e))
    return out


def _board(version: str, seg: str, used: str) -> tuple[str, list[dict]]:
    """The cross-validated benchmark that chose the segment's model (the version's report.json: the segment's task and
    its leaderboard): each technique's AUPRC and whether it is significantly worse than the winner — the other models,
    which score no claim of their own."""
    from aip import ml as aip_ml

    try:
        rep = json.loads((aip_ml._dir() / "versions" / version / "report.json").read_text("utf-8"))
    except (OSError, ValueError):
        return "", []
    task = ((rep.get("segmen") or {}).get(seg) or {}).get("tugas") or seg
    rows = []
    for r in ((rep.get("tugas") or {}).get(task) or {}).get("papan") or []:
        a = (r.get("rata") or {}).get("auprc") or {}
        t = r.get("uji_vs_terbaik") or {}
        rows.append({"teknik": r["model"], "keluarga": r.get("keluarga"), "pembanding": bool(r.get("pembanding")), "auprc": a.get("mean"), "sd": a.get("sd"),
                     "lebih_buruk_nyata": bool(t.get("berbeda_nyata")), "p": t.get("p"), "dipakai": r["model"] == used})
    return task, rows


def _ml(cid: str) -> tuple[dict, dict]:
    """The deployed model run on the claim's row of its feature table, as score_all scores every claim."""
    import duckdb

    import ml_klaim as M
    from aip import ml as aip_ml

    cur = aip_ml.current()
    if not cur:
        return _layer("ml", "Inferensi ML", "", catatan="belum ada model terlatih"), {}
    d = aip_ml._dir()
    pkl = d / "versions" / cur["version"] / "model.pkl"
    feats = sorted((d / "cache").glob(f"fitur-{cur['source_item']}-*-v{M.FEATURES_VERSION}.parquet"), key=lambda p: p.stat().st_mtime)
    model = cur.get("model") or {}
    art = {"versi": cur["version"], "dilatih": cur.get("trained_at"), "pickle": f"aip/ml/versions/{cur['version']}/model.pkl",
           "ukuran": pkl.stat().st_size if pkl.exists() else None, "sha256": _sha256(pkl)[:16] + "…" if pkl.exists() else None,
           "registri": f"Model Risiko Koreksi Klaim BPJS (ML) v{model.get('version', '?')}", "tautan": model.get("link"),
           "fitur_tabel": feats[-1].name if feats else None, "sumber": f"Data Bersih kunjungan_fkrtl (item {cur['source_item']})"}
    if not feats:
        return _layer("ml", "Inferensi ML", art["pickle"], catatan="tabel fitur tidak ada di cache", ml=art), {}
    con = duckdb.connect()
    try:
        df = con.execute(f"SELECT * FROM read_parquet('{feats[-1].as_posix()}') WHERE klaim_id = ? LIMIT 1", [cid]).df()
        if not len(df):
            return _layer("ml", "Inferensi ML", art["pickle"], catatan="klaim ini tidak ada di tabel fitur model (di luar cakupan model)", ml=art), {}
        con.register("fitur", df)
        seg = next((s for s, (_, sql) in M.SEGMENTS.items() if con.execute(f"SELECT count(*) FROM fitur WHERE {sql}").fetchone()[0]), None)
    finally:
        con.close()
    if not seg:
        return _layer("ml", "Inferensi ML", art["pickle"], catatan="klaim ini tidak masuk segmen model", ml=art), {}
    bundle = aip_ml._loaded()["bundle"]
    part = bundle["segments"][seg]
    risk = float(M.predict(part, df)[0])
    why = M.reasons(part, df)[0]
    pub = aip_ml._loaded()["klaim"]
    hit = pub[pub["klaim_id"] == cid]
    y = df.iloc[0].get("y")
    task, board = _board(cur["version"], seg, part.get("name"))
    out = {"segmen": seg, "teknik": part.get("name"), "ambang": float(part["threshold"]), "risiko": risk, "ditandai": risk >= float(part["threshold"]),
           "benchmark": board, "benchmark_tugas": task,
           "label_nyata": bool(y == 1) if y == y else None, "alasan": json.loads(json.dumps(why, default=_iso)),
           "dipublikasikan": bool(len(hit)), "risiko_publikasi": float(hit.iloc[0]["risiko"]) if len(hit) else None,
           "fitur": [{"nama": M.LABELS.get(c, c), "kode": c, "nilai": _iso(df.iloc[0][c])} for c in
                     ("biaya_tagih", "tarif_inacbg", "rasio_tagih_tarif", "los", "idx_los", "los_di_atas_p90", "kembar", "kunjungan_peserta_faskes",
                      "dx_sekunder", "ada_prosedur") if c in df.columns]}
    return _layer("ml", "Inferensi ML", art["pickle"], f"model per segmen ({seg}: {part.get('name')}), dijalankan pada baris fitur klaim ini",
                  ml={**art, **out}), out


def _tags(cid: str) -> list[dict]:
    have = I._viewer_markings()
    vs = [v for v in (I.view(x) for x in I._all().values()) if I._visible(v, have) and str(v.get("kunci")) == cid]
    return [{"indikasi": v["tag_label"], "kode": v["tag"], "kekuatan": v["kekuatan"], "oleh": "penanda otomatis" if v.get("otomatis") else ", ".join(v.get("agen_pendukung") or [])[:80],
             "teks": str(v.get("bukti") or "")[:600], "status": v.get("status"), "pada": v.get("dibuat_pada"), "konteks": v.get("konteks") or {}}
            for v in sorted(vs, key=lambda v: -v["tingkat"])]


def trace(cid: str, fid: str, request: Any = None, run: Any = None) -> dict:
    """The claim's lineage: a list of layers from the source file to the case file, cached ten minutes per viewer.
    run: the engagement whose case file it is — its own Box gives the case file's figure (karantina.box_of)."""
    import auth

    from aip import ml as aip_ml
    from aip import paket

    p = auth.current() or {}
    src = (run or {}).get("ulang_laporan") or (run or {}).get("id")  # a report rewrite: the Box of the engagement it rewrites
    key = (cid, fid, src, p.get("id"), tuple(sorted(I._viewer_markings() or ())))
    with _lock:
        hit = _cache.get(key)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    if ":" not in cid:
        raise HTTPException(400, "klaim harus berbentuk <edisi>:<id kunjungan>")
    edisi, kid = cid.split(":", 1)

    def ml_layer() -> dict:
        try:
            return _ml(cid)[0]
        except Exception as e:  # noqa: BLE001 - the lineage stands without the inference; say why
            return _layer("ml", "Inferensi ML", "", catatan=f"inferensi tidak bisa dijalankan: {str(e)[:200]}")

    # the five reads side by side, each in a copy of this request's context (the caller's access goes with it)
    with ThreadPoolExecutor(5) as pool:
        jobs = [pool.submit(contextvars.copy_context().run, fn) for fn in
                (lambda: _raw_and_bronze(edisi, kid), lambda: [_silver(edisi, kid)[0]], lambda: [_gold(cid)[0]], lambda: _national(cid), lambda: [ml_layer()])]
        layers = [x for j in jobs for x in j.result()]
    tags = _tags(cid)
    layers.append(_layer("indikasi", "Indikasi", "Nexus · Indikasi Fraud (AI Agent Swarm)", "penanda otomatis (aturan lapisan semantik) dan agen swarm, dengan buktinya",
                         bukti=tags, catatan="" if tags else "tidak ada tag pada klaim ini"))
    # the Box rule on this claim, with the inputs the Box used (its published ML score, not the one recomputed above)
    have = I._viewer_markings()
    own = K.box_of(src) if src else None
    box = next((r for r in (own if own is not None else K._load().values()) if str(r.get("faskes_profil_id")) == fid and K._visible(r, have)), None)
    contrib = next((c for c in (box or {}).get("klaim_kontributor") or [] if c.get("klaim_id") == cid), None)
    national = paket._national(request)
    r_med, _ = K._correction_median({str(r.get("klaim_id") or r["_kunci"]): r for r in national})
    k = next((r for r in national if str(r.get("klaim_id") or r.get("_kunci")) == cid), {})
    m = next((r for r in I._objects(S.T_ML_KLAIM) if str(r.get("klaim_id") or r.get("_kunci")) == cid), {})
    tk = next((t["konteks"] for t in tags if t["konteks"].get("biaya_tagih_rp")), {})
    loss = K.claim_loss(cid, k, m, {t["kode"] for t in tags}, r_med, tk)
    paid, parts = loss["dibayar"], loss["parts"]
    peer = I._f(k.get("peer_biaya_p50_rp")) or 0
    sisa = I._f(k.get("sisa_di_luar_tarif_rp")) or 0
    rules = [{"komponen": "Tagihan di luar tarif INA-CBG + top-up", "nilai": round(parts.get("di_atas_tarif", 0)),
              "rumus": f"tagihan − tarif INA-CBG − top-up special CMG = Rp {_idn(sisa)}" + (" — skema COVID: tidak dihitung" if I.covid_scheme(cid) else
                                                                                         "" if sisa > I.SISA_MIN else " — tidak melebihi tarif")},
             {"komponen": "Dibayar di atas 1,5× median peer setarif", "nilai": round(parts.get("di_atas_peer", 0)),
              "rumus": f"maks(0, dibayar Rp {_idn(paid)} − {_idn(K.PEER_BAND, 1)} × median peer Rp {_idn(peer)})"
                       + ("" if (I._f(k.get("peer_klaim")) or 0) >= 30 and not I.covid_scheme(cid) else " — peer < 30 klaim atau skema COVID: tidak dihitung")},
             {"komponen": "Calon klaim ganda (separuh pembayaran)", "nilai": round(parts.get("klaim_ganda", 0)),
              "rumus": f"{_idn(100 * K.DUPLICATE_SHARE)}% × dibayar Rp {_idn(paid)} bila bertag KLAIM_GANDA atau KLONING_KLAIM"},
             {"komponen": "Ekspektasi koreksi model ML", "nilai": round(parts.get("ekspektasi_model", 0)),
              "rumus": f"risiko ML terpublikasi {_idn(I._f(m.get('risiko')) or 0, 4)} × tagihan × rasio koreksi median {_idn(r_med, 3)}"
                       + ("" if m else " — skor klaim ini tidak termasuk yang dipublikasikan: 0")},
             {"komponen": "Estimasi AI Agent Swarm kantor cabang (per modus)", "nilai": round(parts.get("estimasi_cabang", 0)),
              "rumus": (f"{tk.get('dasar_kerugian') or 'taksiran per modus'} = Rp {_idn(I._f(tk.get('estimasi_kerugian_rp')) or 0)}"
                        f" ({tk.get('model_penyaring') or 'model'} + rule engine + AI Agent Swarm)") if tk.get("estimasi_kerugian_rp") else "tidak ada taksiran kantor cabang: 0"}]
    layers.append(_layer("box", "Box Karantina", "Nexus · Karantina Faskes (AI Agent Swarm)", "aturan per klaim aip/karantina.py claim_loss: komponen terbesar dihitung",
                         aturan=rules, dikoreksi=loss["dikoreksi"], selisih=round(loss["selisih"]), dipilih=round(max(parts.values(), default=0) if not loss["dikoreksi"] else 0),
                         kontributor=contrib))
    est = I._f((box or {}).get("estimasi_kerugian_rp")) or 0
    mine = I._f((contrib or {}).get("nilai_rp")) or 0
    layers.append(_layer("berkas", "Berkas kasus", f"{(box or {}).get('nama') or fid}", "laporan lengkap AI Agent Swarm",
                         estimasi_faskes=round(est), klaim_ini=round(mine), porsi_pct=round(100 * mine / est, 1) if est else None))
    out = {"klaim": cid, "edisi": edisi, "kunjungan": kid, "lapis": layers, "dibaca_pada": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "ml_versi": (aip_ml.current() or {}).get("version")}
    with _lock:
        _cache[key] = (time.time(), out)
    return out
