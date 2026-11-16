"""Demo Grid, fase 5 sesi 2: skor NTL per jam & deteksi bypass dalam hitungan jam — dari stream ami_bersih /
ami_peristiwa (sesi 5.1) menjadi skor per jam dan peristiwa "dugaan bypass" di Nexus (dipanggil oleh
demo_grid_e2e.build, langkah "ntl_stream"; dipasang server.py di /api/demo/grid/ntl).

  ami_bersih + ami_peristiwa -> "Pipeline NTL per jam grid (demo)" (streaming): agregasi per jam per meter ->
  fitur per jam -> langkah Python-function memanggil live deployment model NTL (skorNtlPelangganGridDemo,
  pola pipeline skor NTL batch di demo_grid_ml) -> stream skor_ntl_jam
  -> detektor di modul ini (proses API): CUSUM penurunan mendadak + event tamper + arus fasa timpang + skor model
  -> tipe Nexus "AMI Event (demo)" (sumber "AMI streaming", kebijakan baris per ULP) + Object Monitor +
  notifikasi ke grup ULP.

Model NTL yang ada dilatih atas fitur per siklus tagihan (perubahan Q2->Q3, bulan estimasi, ...). Per jam fitur itu
tidak ada, jadi langkah model memakai ADAPTOR PER JAM yang jujur: perubahan_pct diisi dari rasio terhadap baseline
jam-yang-sama, rasio_vs_peer dari pangsa neraca gardu per jam, event_tamper dari ami_peristiwa, rasio_arus_fasa_min
dari bacaan TM; fitur khas siklus tagihan diisi nilai netral (sama seperti NEUTRAL di model_adapters/ntl.py).
Skor per jam karena itu skor peringatan dini, bukan pengganti skor siklus tagihan; alasannya dicatat di dataset
fitur (kolom adaptor) dan di dokumen analisis §14.

Kebenaran kejadian (data/demo-grid-e2e/ami_sim.json "events", termasuk bypass suntikan) hanya dipakai untuk
mengukur latensi deteksi dan false positive — tidak pernah menjadi input fitur atau model. Fiktif, berlabel
"(demo)"; tetap read-only ke SCADA (tidak ada kendali apa pun).
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import auth

log = logging.getLogger("bluesandai.demo_grid_ntl_stream")
router = APIRouter(prefix="/api/demo/grid/ntl")

PIPELINE = "Pipeline NTL per jam grid (demo)"
VERSION = 2  # v2: graf kompleks (sumber register & fitur batch, cabang peristiwa, join konteks, 3 output)
TYPE = ("AMI Event (demo)", "PeristiwaAmiDemo", "id_peristiwa", "judul")
LINK_P = "Customer AMI event (grid demo)"
LINK_M = "AMI meter event (grid demo)"
MONITOR = "Dugaan bypass AMI streaming (demo)"
WIB = timezone(timedelta(hours=7))
# CUSUM penurunan: akumulasi (ambang referensi - rasio baseline); picu saat melewati H.
CUSUM_K, CUSUM_H = 0.80, 1.00
SKOR_PICU = 0.75  # skor model per jam yang ikut memicu (adaptasi per jam, lihat docstring modul)
_lock = threading.RLock()

SQL_JAM = """-- Agregasi per jam per meter dari bacaan bersih 15 menit: energi per jam, arus fasa minimum (TM), event tamper per jam.
SELECT no_meter, id_pelanggan,
       strftime('%Y-%m-%d %H:00', ts / 1000 + 25200, 'unixepoch') AS jam_wib,
       ROUND(SUM(kwh), 4) AS kwh_jam, COUNT(*) AS bacaan,
       MIN(rasio_arus_fasa) AS rasio_arus_fasa_min, ROUND(AVG(kw), 3) AS kw_rata,
       SUM(CASE WHEN event <> '' THEN 1 ELSE 0 END) AS event_tamper
FROM input
GROUP BY no_meter, id_pelanggan, jam_wib"""

SQL_FITUR = """-- Fitur per jam untuk adaptor model (setelah join konteks register + cabang peristiwa): tamper magnet/buka tutup
-- dari cabang peristiwa; fitur khas siklus tagihan netral (adaptor per jam, lihat docstring modul).
SELECT no_meter, id_pelanggan, jam_wib, kwh_jam, bacaan, rasio_arus_fasa_min, kw_rata,
       COALESCE(tamper_jam, 0) AS event_tamper, kode_dt, kode_penyulang, kode_ulp, tegangan,
       0.0 AS perubahan_pct, 1.0 AS rasio_vs_peer, 80.0 AS kwh_per_kva_bulan, 0.6 AS rasio_puncak_vs_daya,
       0.0 AS bulan_estimasi, 0.0 AS bulan_stand_sama, 0.0 AS hari_nol, 0.3 AS porsi_malam, 0.45 AS faktor_beban,
       0.0 AS event_fasa, 0.2 AS porsi_wbp, 0.99 AS rasio_tegangan_fasa_min, 0.0 AS hari_melebihi_kontrak,
       1.0 AS rasio_tagih_vs_amr, 0.0 AS ntl_gardu_pct, 0.0 AS porsi_turun_rute_baca, 0.0 AS potensi_rp_bulan
FROM input"""

SQL_SKOR = """-- Skor NTL per jam dari fungsi model (live deployment): persentil anomali, probabilitas, skor gabungan.
SELECT no_meter, id_pelanggan, jam_wib, kwh_jam, event_tamper, rasio_arus_fasa_min, kode_dt, kode_ulp,
       CAST(get_json_object(hasil_model, '$.skor_anomali') AS DOUBLE) AS skor_anomali,
       CAST(get_json_object(hasil_model, '$.prob_temuan') AS DOUBLE) AS prob_temuan,
       CAST(get_json_object(hasil_model, '$.skor_ntl') AS DOUBLE) AS skor_ntl,
       get_json_object(hasil_model, '$.alasan_ml') AS alasan_ml
FROM input"""

SQL_EVT = """-- Peristiwa per jam dari bacaan bersih (cabang peristiwa): magnet/buka tutup (tamper) dan arus fasa timpang TM.
SELECT no_meter, strftime('%Y-%m-%d %H:00', ts / 1000 + 25200, 'unixepoch') AS jam_wib,
       SUM(CASE WHEN event IN ('magnet', 'cover_open') THEN 1 ELSE 0 END) AS tamper_jam,
       SUM(CASE WHEN rasio_arus_fasa IS NOT NULL AND rasio_arus_fasa < 0.2 THEN 1 ELSE 0 END) AS fasa_timpang_jam,
       MIN(rasio_arus_fasa) AS rasio_arus_fasa_min
FROM input
GROUP BY no_meter, jam_wib"""

SQL_KANDIDAT = """-- Kandidat dugaan awal per jam (bahan detektor CUSUM di API): tamper, fasa timpang, atau skor model sangat tinggi.
SELECT no_meter, id_pelanggan, jam_wib, kode_dt, kode_ulp, skor_ntl, event_tamper, rasio_arus_fasa_min,
       CASE WHEN event_tamper > 0 THEN 'event tamper'
            WHEN rasio_arus_fasa_min < 0.2 THEN 'arus fasa timpang'
            ELSE 'skor model sangat tinggi' END AS picu_awal
FROM input
WHERE event_tamper > 0 OR (rasio_arus_fasa_min IS NOT NULL AND rasio_arus_fasa_min < 0.2) OR skor_ntl >= 0.9"""

SQL_GARDU_JAM = """-- Neraca AMI per gardu per jam: total kWh pilot, meter aktif, meter dengan bacaan sangat rendah (bahan neraca gardu per jam).
SELECT kode_dt, jam_wib, ROUND(SUM(kwh_jam), 2) AS kwh_pilot_jam, COUNT(*) AS meter_aktif,
       SUM(CASE WHEN kwh_jam < 0.05 THEN 1 ELSE 0 END) AS meter_kwh_sangat_rendah
FROM input
WHERE kode_dt <> ''
GROUP BY kode_dt, jam_wib"""


def _e():
    import demo_grid_e2e as e

    return e


def _st() -> dict:
    return _e().STATE.setdefault("ntl_stream", {})


# ------------------------------------------------------------------------------------------------
# fitur per jam + CUSUM (murni, tanpa platform — diuji langsung)
# ------------------------------------------------------------------------------------------------

def hourly(readings: list[dict], events: list[dict]) -> dict[str, list[dict]]:
    """Per meter: baris per jam (WIB) dari bacaan bersih 15 menit + event per jam; rasio terhadap baseline
    jam-yang-sama (rata-rata jam yang sama di hari-hari sebelumnya, maks 7 hari) dan pangsa neraca gardu per jam
    (per DT: kWh meter / total kWh AMI di DT jam itu, dibandingkan pangsa baselinenya)."""
    tamper: dict[tuple[str, str], int] = {}
    for ev in events:
        tamper[(ev["no_meter"], ev["waktu_wib"][:13] + ":00")] = tamper.get((ev["no_meter"], ev["waktu_wib"][:13] + ":00"), 0) + 1
    per: dict[str, dict[str, dict]] = {}
    dt_hour: dict[tuple[str, str], float] = {}
    meta: dict[str, dict] = {}
    for r in readings:
        jam = r["waktu_wib"][:13] + ":00"
        m = per.setdefault(r["no_meter"], {})
        h = m.setdefault(jam, {"jam_wib": jam, "kwh": 0.0, "n": 0, "fasa": None})
        h["kwh"] += float(r.get("kwh") or 0)
        h["n"] += 1
        f = r.get("rasio_arus_fasa")
        if f is not None:
            h["fasa"] = float(f) if h["fasa"] is None else min(h["fasa"], float(f))
        meta[r["no_meter"]] = r
    for meter, hours in per.items():
        dt = (meta[meter].get("_dt") or "")
        for jam, h in hours.items():
            if dt:
                dt_hour[(dt, jam)] = dt_hour.get((dt, jam), 0.0) + h["kwh"]
    out: dict[str, list[dict]] = {}
    for meter, hours in per.items():
        rows = []
        hist: dict[str, list[float]] = {}
        share_hist: dict[str, list[float]] = {}
        dt = meta[meter].get("_dt") or ""
        for jam in sorted(hours):
            h = hours[jam]
            hod = jam[11:13]
            base = hist.get(hod) or []
            baseline = sum(base[-7:]) / len(base[-7:]) if base else None
            total_dt = dt_hour.get((dt, jam), 0.0) if dt else 0.0
            share = h["kwh"] / total_dt if total_dt > 0 else None
            sbase = share_hist.get(hod) or []
            share_base = sum(sbase[-7:]) / len(sbase[-7:]) if sbase else None
            rows.append({"no_meter": meter, "id_pelanggan": meta[meter].get("id_pelanggan"), "jam_wib": jam,
                         "kwh_jam": round(h["kwh"], 4), "bacaan": h["n"],
                         "rasio_arus_fasa_min": h["fasa"], "event_tamper": tamper.get((meter, jam), 0),
                         "baseline_kwh": round(baseline, 4) if baseline is not None else None,
                         "rasio_baseline": round(h["kwh"] / baseline, 3) if baseline else None,
                         "rasio_neraca_gardu": round(share / share_base, 3) if share is not None and share_base else None})
            hist.setdefault(hod, []).append(h["kwh"])
            if share is not None:
                share_hist.setdefault(hod, []).append(share)
        out[meter] = rows
    return out


def cusum(rows: list[dict]) -> list[dict]:
    """Deteksi perubahan mendadak per meter: CUSUM satu arah pada rasio baseline, ATAU event tamper meter, ATAU arus
    fasa timpang. Skor model per jam hanya bukti pendukung (terlalu bising sebagai pemicu tunggal: 14% baris jam
    bersih >= 0,75 pada data pilot). Satu dugaan per episode: setelah picu, jeda 6 jam tanpa picu sebelum siap lagi."""
    out = []
    for meter, hs in rows.items() if isinstance(rows, dict) else []:
        s, cooldown = 0.0, 0
        for h in hs:
            rasio, sebab = h.get("rasio_baseline"), []
            if rasio is not None and (h.get("bacaan") or 0) >= 3:
                s = max(0.0, s + (CUSUM_K - rasio))
            if h.get("event_tamper"):
                sebab.append(f"event tamper {h['event_tamper']}x")
            if h.get("rasio_arus_fasa_min") is not None and h["rasio_arus_fasa_min"] < 0.2:
                sebab.append(f"arus fasa timpang (rasio {h['rasio_arus_fasa_min']})")
            if s >= CUSUM_H:
                sebab.append(f"CUSUM {s:.2f} (rasio baseline {rasio})")
            if sebab:
                skor = h.get("skor_ntl")
                if skor is not None and skor >= SKOR_PICU:
                    sebab.append(f"skor NTL per jam {skor} (pendukung)")
                if cooldown == 0:
                    out.append({**h, "cusum": round(s, 3), "sebab": "; ".join(sebab)})
                cooldown = 6
            elif cooldown > 0:
                cooldown -= 1
                if cooldown == 0:
                    s = 0.0
    return sorted(out, key=lambda d: (d["jam_wib"], d["no_meter"]))


def model_rows(hours: dict[str, list[dict]]) -> list[dict]:
    """Adaptor per jam -> baris input fungsi model NTL (demo_grid_ml.INPUT_COLS). Fitur khas siklus tagihan diisi
    netral; yang terisi dari data per jam: perubahan_pct (rasio baseline), rasio_vs_peer (neraca gardu),
    event_tamper, rasio_arus_fasa_min. potensi_rp_bulan 0: nilai rupiah dinilai di siklus tagihan, bukan per jam."""
    import demo_grid_ami as ga
    import demo_grid_data as gd

    cust = {c["id_pelanggan"]: c for c in gd.customers()}
    reg = {m["no_meter"]: m for m in ga.meters()}
    out = []
    for meter, hs in hours.items():
        m = reg.get(meter) or {}
        c = cust.get(m.get("id_pelanggan") or "") or {}
        for h in hs:
            rasio = h.get("rasio_baseline")
            out.append({"id_pelanggan": h.get("id_pelanggan"), "potensi_rp_bulan": 0.0,
                        "tegangan": c.get("tegangan") or m.get("tegangan"), "ami": "Ya" if c.get("ami") else "Tidak",
                        "jenis_meter": c.get("jenis_meter"), "segmen": c.get("segmen"),
                        "perubahan_pct": round((rasio - 1) * 100, 1) if rasio is not None else 0.0,
                        "rasio_vs_peer": h.get("rasio_neraca_gardu") if h.get("rasio_neraca_gardu") is not None else 1.0,
                        "kwh_per_kva_bulan": 80.0, "rasio_puncak_vs_daya": 0.6, "bulan_estimasi": 0.0, "bulan_stand_sama": 0.0,
                        "hari_nol": 0.0, "porsi_malam": 0.3, "faktor_beban": 0.45,
                        "event_tamper": float(min(h.get("event_tamper") or 0, 5)),
                        "event_fasa": 1.0 if (h.get("rasio_arus_fasa_min") is not None and h["rasio_arus_fasa_min"] < 0.2) else 0.0,
                        "porsi_wbp": 0.2,
                        "rasio_arus_fasa_min": h.get("rasio_arus_fasa_min") if h.get("rasio_arus_fasa_min") is not None else 0.95,
                        "rasio_tegangan_fasa_min": 0.99, "hari_melebihi_kontrak": 0.0, "rasio_tagih_vs_amr": 1.0,
                        "ntl_gardu_pct": 0.0, "porsi_turun_rute_baca": 0.0,
                        "_jam": h})
    return out


def score_hours(hours: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """Skor tiap baris jam lewat live deployment (execute_function_rows, pola emulate_scoring demo_grid_ml)."""
    import model_deployments

    import demo_grid_ml as ml

    rows = model_rows(hours)
    cols = ml.INPUT_COLS
    scored: dict[str, list[dict]] = {}
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        outs = model_deployments.execute_function_rows(ml.FUNCTION_API, [{c: r.get(c) for c in cols} for r in chunk])
        for r, o in zip(chunk, outs):
            h = dict(r["_jam"])
            h.update(skor_anomali=o.get("skor_anomali"), prob_temuan=o.get("prob_temuan"), skor_ntl=o.get("skor_ntl"),
                     alasan_ml=o.get("alasan_ml"))
            scored.setdefault(h["no_meter"], []).append(h)
    for v in scored.values():
        v.sort(key=lambda h: h["jam_wib"])
    return scored


# ------------------------------------------------------------------------------------------------
# membaca stream sesi 5.1 (bersih, seperti SQL_BERSIH) dan menjalankan detektor
# ------------------------------------------------------------------------------------------------

def _bersih_records() -> tuple[list[dict], list[dict]]:
    """(bacaan bersih, peristiwa) dari ingest stream AMI: saringan SQL_BERSIH + SQL_PERISTIWA dalam Python."""
    import streaming as S

    import demo_grid_ami as ga

    stream_id = (_e().STATE.get("ami") or {}).get("stream_id")
    if not stream_id:
        return [], []
    reg = {m["no_meter"]: m for m in ga.meters()}
    readings, events, after = [], [], 0
    while True:
        page = S.read_records(stream_id, after=after, limit=5000)
        rows = page.get("rows") or []
        if not rows:
            break
        for r in rows:
            if r.get("kualitas") == "BAD" or float(r.get("kwh") or 0) < 0:
                continue
            ts = int(r.get("ts") or 0)
            wib = datetime.fromtimestamp(ts / 1000 + 25200, timezone.utc).strftime("%Y-%m-%d %H:%M")
            fasa = None
            if r.get("i_l2") is not None and r.get("i_l1") is not None and r.get("i_l3") is not None:
                mx = max(float(r["i_l1"]), float(r["i_l2"]), float(r["i_l3"]))
                fasa = round(min(float(r["i_l1"]), float(r["i_l2"]), float(r["i_l3"])) / mx, 3) if mx > 0 else None
            b = {"no_meter": r.get("meter"), "id_pelanggan": r.get("id_pelanggan"), "waktu_wib": wib,
                 "kwh": float(r.get("kwh") or 0), "kw": float(r.get("kw") or 0), "rasio_arus_fasa": fasa,
                 "event": r.get("event") or "", "_dt": (reg.get(r.get("meter")) or {}).get("kode_dt")}
            readings.append(b)
            if b["event"] or (fasa is not None and fasa < 0.2):
                events.append({**b, "peristiwa": b["event"] or "arus_fasa_timpang"})
        after = int(page.get("last_seq") or after)
        if len(rows) < 5000:
            break
    return readings, events


def _jam_epoch(jam_wib: str) -> int:
    return int(datetime.strptime(jam_wib, "%Y-%m-%d %H:%M").replace(tzinfo=WIB).timestamp())


def scan(create: bool = True) -> dict:
    """Satu putaran deteksi atas seluruh stream: fitur per jam -> skor model -> CUSUM; peristiwa baru masuk Nexus
    (idempoten per meter+jam) dan diteruskan sebagai notifikasi. Kebenaran hanya untuk latensi & false positive."""
    import demo_grid_ami as ga

    readings, events = _bersih_records()
    hours = hourly(readings, [e for e in events if e.get("event") in ("magnet", "cover_open")])  # tamper = magnet/buka tutup; voltage_sag bukan tamper
    scored = score_hours(hours) if hours else {}
    dets = cusum(scored)
    reg = {m["no_meter"]: m for m in ga.meters()}
    truth = (ga._sim_state().get("events") or [])
    planted_loss = {m["no_meter"] for m in ga.meters() if any(c in ga.METER_LOSS for c, _ in m["pola"])}
    latensi, fp = [], 0
    for ev in truth:
        # agregasi per jam: dugaan jam H baru diketahui di akhir jam itu -> latensi diukur dari mulai ke akhir jam deteksi
        hit = next((d for d in dets if d["no_meter"] == ev["no_meter"] and _jam_epoch(d["jam_wib"]) + 3600 > int(ev["mulai"])), None)
        latensi.append({"kejadian": ev["id"], "no_meter": ev["no_meter"], "pola": ev["pola"],
                        "mulai_wib": datetime.fromtimestamp(int(ev["mulai"]), WIB).strftime("%Y-%m-%d %H:%M"),
                        "terdeteksi_wib": hit["jam_wib"] if hit else None,
                        "latensi_jam": round(max(0.0, (_jam_epoch(hit["jam_wib"]) + 3600 - int(ev["mulai"])) / 3600), 2) if hit else None})
    truth_meters = {ev["no_meter"] for ev in truth}
    for d in dets:
        if d["no_meter"] not in truth_meters and d["no_meter"] not in planted_loss:
            fp += 1
    made = _write_events(dets, reg) if create and dets else []
    if create:
        # the AMI streams' other Nexus types (meter health, substation hourly balance) follow the same round
        try:
            __import__("demo_grid_ami_nexus").refresh()
        except Exception as exc:  # noqa: BLE001 - detection does not depend on them
            log.warning("ami_nexus refresh: %s", exc)
    return {"bacaan": len(readings), "meter_jam": sum(len(v) for v in hours.values()), "dugaan": len(dets),
            "baru": made, "latensi": latensi, "false_positive": fp,
            "meter_tanpa_kejadian": len([m for m in reg if m not in truth_meters and m not in planted_loss]),
            "pada": datetime.now(timezone.utc).isoformat()}


def _write_events(dets: list[dict], reg: dict) -> list[str]:
    import ontology

    tid = _st().get("type_id")
    if not tid:
        return []
    objs = ontology.load_objects(tid)
    made = []
    for d in dets:
        pk = f"AMI-{d['no_meter']}-{d['jam_wib'][:13].replace(' ', '-')}"
        if pk in objs:
            continue
        m = reg.get(d["no_meter"]) or {}
        objs[pk] = {"properties": {
            "id_peristiwa": pk, "judul": f"Dugaan bypass {d['no_meter']} · {d['jam_wib']} WIB (demo)",
            "no_meter": d["no_meter"], "id_pelanggan": d.get("id_pelanggan"), "kode_dt": m.get("kode_dt"),
            "kode_penyulang": m.get("kode_penyulang"), "kode_ulp": m.get("kode_ulp"), "jam_deteksi": d["jam_wib"],
            "skor_ntl_jam": d.get("skor_ntl"), "cusum": d.get("cusum"), "rasio_baseline": d.get("rasio_baseline"),
            "bukti": d.get("sebab"), "sumber": "AMI streaming", "status_peristiwa": "Baru (demo)"},
            "created_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()}
        made.append(pk)
    if made:
        ontology.save_objects(tid, objs, changed=made)
        _notify(dets, reg, made)
    return made


def _notify(dets: list[dict], reg: dict, made: list[str]) -> None:
    import notify

    by_ulp: dict[str, list[dict]] = {}
    for d in dets:
        pk = f"AMI-{d['no_meter']}-{d['jam_wib'][:13].replace(' ', '-')}"
        if pk in made:
            by_ulp.setdefault((reg.get(d["no_meter"]) or {}).get("kode_ulp") or "-", []).append(d)
    all_users = auth._users() if hasattr(auth, "_users") else []
    for ulp, ds in by_ulp.items():
        targets = [u["id"] for u in all_users
                   if (u.get("username") or "").startswith("demo.grid.")
                   and ((u.get("attributes") or {}).get("kode_ulp") in (None, ulp) or "manajer" in (u.get("username") or ""))]
        for uid in dict.fromkeys(targets):
            notify.deliver(uid, f"Dugaan bypass AMI streaming: {len(ds)} meter di {ulp} (demo)",
                           "\n".join(f"{d['no_meter']} sejak {d['jam_wib']} WIB — {d.get('sebab')}" for d in ds[:10]),
                           link="/demo-grid", source="AMI streaming (demo)")


# ------------------------------------------------------------------------------------------------
# Nexus: tipe "AMI Event (demo)" + Object Monitor
# ------------------------------------------------------------------------------------------------

PROPS = [("id_peristiwa", "ID peristiwa", "string"), ("judul", "Judul", "string"), ("no_meter", "No. meter", "string"),
         ("id_pelanggan", "ID pelanggan", "string"), ("kode_dt", "Gardu distribusi", "string"), ("kode_penyulang", "Penyulang", "string"),
         ("kode_ulp", "ULP", "string"), ("jam_deteksi", "Jam deteksi (WIB)", "string"), ("skor_ntl_jam", "Skor NTL per jam", "double"),
         ("cusum", "CUSUM", "double"), ("rasio_baseline", "Rasio vs baseline", "double"), ("bukti", "Bukti", "string"),
         ("sumber", "Sumber", "string"), ("status_peristiwa", "Status", "string")]


def _peristiwa_type() -> dict:
    import ontology
    import ontology_model as om
    import ontology_security as osec

    import demo_grid_akses as ak
    import demo_grid_e2e as e

    name, api, pk, title = TYPE
    out: dict[str, Any] = {}
    t = next((x for x in ontology._all("object-types") if x["display_name"] == name), None)
    if not t:
        props = [{**e._prop(c, ty, "temuan"), "display_name": lbl} for c, lbl, ty in PROPS]
        t = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=name, plural_name=name, api_name=api, primary_key=pk, title_property=title, icon="bell", color="#dc2626",
            description="Demo: dugaan bypass dari deteksi streaming AMI (skor NTL per jam + CUSUM) — sumber 'AMI streaming', baris per ULP.",
            properties=[ontology.Property(**p) for p in props], generate_primary_key=True))
        ontology.ensure_objects(t["id"])
        out["created"] = True
    links = {x.get("display_name") for x in ontology._all("link-types")}
    pl, mt = e._type("pelanggan"), next((x for x in ontology._all("object-types") if x["display_name"] == "Grid AMI Meter (demo)"), None)
    if pl and LINK_P not in links:
        om.create_link_type(om.LinkTypeIn(display_name=LINK_P, kind="foreign_key", cardinality="many_to_one", foreign_key="id_pelanggan",
                                          source=om.LinkSide(object_type_id=t["id"], display_name="Peristiwa AMI", plural_display_name="Peristiwa AMI"),
                                          target=om.LinkSide(object_type_id=pl["id"], display_name="Pelanggan")))
        out["link_pelanggan"] = True
    if mt and LINK_M not in links:
        om.create_link_type(om.LinkTypeIn(display_name=LINK_M, kind="foreign_key", cardinality="many_to_one", foreign_key="no_meter",
                                          source=om.LinkSide(object_type_id=t["id"], display_name="Peristiwa AMI", plural_display_name="Peristiwa AMI"),
                                          target=om.LinkSide(object_type_id=mt["id"], display_name="Meter AMI")))
        out["link_meter"] = True
    groups = (e.STATE.get("akses") or {}).get("groups") or {}
    if groups.get("up3"):
        sec = ontology._object_type(t["id"]).get("security") or {}
        op = {**(sec.get("object_policy") or {"markings": []}), "granular": ak.policy([groups["up3"]])}
        if (sec.get("object_policy") or {}).get("granular") != op["granular"]:
            osec.set_security(t["id"], osec.SecurityIn(object_policy=op, property_policies=sec.get("property_policies") or []))
            out["policy"] = "per ULP (UP3 semua)"
    # lineage: the detector turns these streams into the events (the streams feed the Nexus type)
    import streaming

    fed = sorted(s["id"] for s in streaming.list_streams() if s.get("name") in ("skor_ntl_jam", "kandidat_dugaan_jam", "ami_peristiwa"))
    rec = ontology._object_type(t["id"])
    if fed and rec.get("fed_by_streams") != fed:
        rec["fed_by_streams"] = fed
        ontology._put("object-types", rec)
        out["fed_by_streams"] = fed
    out["type_id"] = t["id"]
    return out


def _monitor(type_id: str) -> dict:
    import object_monitors as om

    have = next((m for m in om.list_monitors() if m.get("name") == MONITOR), None)
    if have:
        return {"monitor_id": have["id"], "existing": True}
    subs = [{"user": u["id"], "notify": True, "email": False}
            for u in (auth._users() if hasattr(auth, "_users") else []) if (u.get("username") or "").startswith("demo.grid.")]
    m = om.create_monitor(om.MonitorIn(
        name=MONITOR, description="Demo: peristiwa dugaan bypass baru dari deteksi streaming AMI (skor per jam + CUSUM) "
                                  "diteruskan ke tim ULP terkait dan manajer UP3.",
        search={"object_type_id": type_id, "filters": [{"property": "sumber", "op": "eq", "value": "AMI streaming"}]},
        condition=om.Condition(kind="objects_added"), subscribers=subs[:12], every_minutes=5, enabled=True))
    return {"monitor_id": m["id"]}


# ------------------------------------------------------------------------------------------------
# integrasi Platform Apps: Portal (page) + Vertex dari modul ini sendiri
# ------------------------------------------------------------------------------------------------

GRAPH = "Demo: Dugaan bypass AMI (streaming)"


def _portal(pid: str) -> list[str]:
    import agentic_apps

    made = []
    for name, href, desc in (
        ("Skor NTL per jam & deteksi bypass (demo)", "/demo-grid",
         "Demo: skor NTL per jam dari stream AMI (adaptor per jam + CUSUM), latensi deteksi bypass, suntik bypass langsung."),
        ("Pipeline NTL per jam grid (demo)", f"/pipeline/{pid}",
         "Demo: pipeline streaming agregasi per jam -> fitur -> fungsi model NTL live deployment -> skor per jam."),
    ):
        made.append(agentic_apps.register(agentic_apps.AppIn(
            name=name, kind="page", href=href, icon="bell", collection="Grid Management", description=desc,
            tags=["grid", "ntl", "streaming", "demo"]))["id"])
    return made


def _vertex_graph() -> dict:
    import vertex

    import demo_grid_ami as ga

    if any(g["name"] == GRAPH for g in vertex.list_graphs()):
        return {"graph": GRAPH, "existing": True}
    e = _e()
    pt = next((x for x in __import__("ontology")._all("object-types") if x["display_name"] == TYPE[0]), None)
    pl, mt = e._type("pelanggan"), next((x for x in __import__("ontology")._all("object-types") if x["display_name"] == "Grid AMI Meter (demo)"), None)
    if not (pt and pl and mt):
        return {"graph": None}
    truth = (ga._sim_state().get("events") or [])[:3]
    reg = {m["no_meter"]: m for m in ga.meters()}
    layers = {pt["id"]: {"color": "#dc2626", "label_property": "judul", "column": 0},
              mt["id"]: {"color": "#2c9c9c", "label_property": "judul", "column": 1},
              pl["id"]: {"color": "#805ad5", "label_property": "judul", "column": 2}}
    nodes = []
    for ev in truth:
        m = reg.get(ev["no_meter"]) or {}
        nodes.append({"object_type_id": mt["id"], "primary_key": ev["no_meter"]})
        if m.get("id_pelanggan"):
            nodes.append({"object_type_id": pl["id"], "primary_key": m["id_pelanggan"]})
    import ontology

    for pk in list(ontology.stored_objects(pt["id"]))[:30]:
        nodes.append({"object_type_id": pt["id"], "primary_key": pk})
    g = vertex.create_graph(vertex.GraphIn(
        name=GRAPH, layout="flow", line_type="curved", layers=layers, nodes=nodes,
        description="Demo: peristiwa dugaan bypass dari deteksi streaming AMI (skor per jam + CUSUM) terhubung ke meter AMI "
                    "dan pelanggannya; kejadian tertanam AMI-E1/E2/E3 untuk evaluasi latensi."))
    return {"graph": g["id"]}


# ------------------------------------------------------------------------------------------------
# pipeline streaming per jam (sumber stream yang sama dengan pipeline AMI sesi 5.1)
# ------------------------------------------------------------------------------------------------

def _content(stream_id: str, items: dict, previews: dict, folder: str, project: str, uid, fn) -> dict:
    """Graf kompleks (pola pipeline audit JKN): 3 sumber (stream + register meter + fitur batch), cabang agregasi &
    peristiwa, join konteks, langkah model, 3 output. Mentah -> bersih -> per jam -> skor -> kandidat & neraca."""
    import demo_jkn_pipeline as base

    now = datetime.now(timezone.utc).isoformat()
    ga = __import__("demo_grid_ami")
    fn_id = "pyfn-ntl-jam"
    params = {}
    if fn:
        params = {f"pyarg_{i['name']}": i["name"] for i in fn["inputs"]}
        params["output"] = "hasil_model"

    def src(nid: str, name: str, item: str | None, rows: list[dict], x: int, y: int, color: str, desc: str) -> dict:
        ds = f"ds_{nid}"
        ref = {"kind": "ingest", "streamId": item} if nid == "s_ami" else {"kind": "drive", "itemId": item}
        return {"node": {"id": nid, "kind": "source", "name": name, "x": x, "y": y, "color": color, "datasetId": ds, "description": desc},
                "ds": (ds, {"id": ds, "name": name, "origin": ("Streaming · " if nid == "s_ami" else "Files · ") + project,
                            "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in (ga.SCHEMA if nid == "s_ami" else base.schema_of(rows))],
                            "rows": rows[:50], "ref": ref})}

    parts = [
        src("s_ami", "ami_meter_15menit (demo)", stream_id, [], 0, 300, "lg-mentah", "Ingest stream streaming sync MQTT (sesi 5.1): bacaan mentah 15 menit"),
        src("s_reg", "register_meter_ami_pilot", items.get("register"), previews.get("register") or [], 0, 60, "lg-konteks",
            "Register meter pilot (dataset sesi 5.1): gardu, penyulang, ULP, tegangan tiap meter"),
        src("s_fitur", "fitur_ntl_pelanggan", items.get("fitur"), previews.get("fitur") or [], 0, 560, "lg-konteks",
            "Fitur pelanggan siklus tagihan (Code Repository model NTL): konteks pembanding skor per jam"),
    ]
    nodes = [p["node"] for p in parts]
    datasets = dict(p["ds"] for p in parts)
    nodes += [
        {"id": "t_bersih", "kind": "transform", "name": "ami_bersih_jam", "input": "s_ami", "x": 320, "y": 300, "color": "lg-bersih",
         "description": "Validasi bacaan (kualitas, kWh) + rasio arus fasa TM",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": ga.SQL_BERSIH}}]},
        {"id": "t_jam", "kind": "transform", "name": "agregasi_jam", "input": "t_bersih", "x": 640, "y": 220, "color": "lg-jam",
         "description": "Agregasi per jam per meter: kWh, bacaan, arus fasa minimum",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_JAM}}]},
        {"id": "t_evt", "kind": "transform", "name": "peristiwa_jam", "input": "t_bersih", "x": 640, "y": 430, "color": "lg-jam",
         "description": "Cabang peristiwa: tamper (magnet/buka tutup) & fasa timpang per jam",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_EVT}}]},
        {"id": "j_konteks", "kind": "join", "name": "konteks_meter", "left": "t_jam", "right": "s_reg", "x": 960, "y": 220, "color": "lg-konteks",
         "leftKey": "no_meter", "rightKey": "no_meter", "keys": [{"left": "no_meter", "right": "no_meter"}], "how": "left",
         "leftColumns": None, "rightColumns": ["kode_dt", "kode_penyulang", "kode_ulp", "tegangan"],
         "description": "Konteks jaringan tiap meter: gardu, penyulang, ULP, tegangan"},
        {"id": "j_fitur", "kind": "join", "name": "fitur_dengan_peristiwa", "left": "j_konteks", "right": "t_evt", "x": 1280, "y": 300, "color": "lg-konteks",
         "leftKey": "no_meter", "rightKey": "no_meter",
         "keys": [{"left": "no_meter", "right": "no_meter"}, {"left": "jam_wib", "right": "jam_wib"}], "how": "left",
         "leftColumns": None, "rightColumns": ["tamper_jam", "fasa_timpang_jam"], "description": "Gabung agregasi jam dengan peristiwa jamnya"},
        {"id": "t_fitur", "kind": "transform", "name": "fitur_ntl_jam", "input": "j_fitur", "x": 1600, "y": 300, "color": "lg-jam",
         "description": "Adaptor per jam: fitur terukur dari stream; fitur khas siklus tagihan netral (jujur, lihat modul)",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_FITUR}}]},
        {"id": "t_skor", "kind": "transform", "name": "skor_model_jam", "input": "t_fitur", "x": 1920, "y": 300, "color": "lg-model",
         "description": "Fungsi model NTL dari live deployment, per baris jam",
         "steps": ([{"id": uid(), "kind": f"fn:{fn_id}", "params": params}] if fn else
                   [{"id": uid(), "kind": "sql", "params": {"query": "SELECT *, NULL AS hasil_model FROM input"}}])},
        {"id": "t_out", "kind": "transform", "name": "skor_ntl_jam", "input": "t_skor", "x": 2240, "y": 220, "color": "lg-model",
         "description": "Skor per jam terurai: anomali, probabilitas temuan, skor gabungan",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_SKOR}}]},
        {"id": "t_kandidat", "kind": "transform", "name": "kandidat_dugaan_jam", "input": "t_out", "x": 2240, "y": 430, "color": "lg-dugaan",
         "description": "Kandidat dugaan awal: tamper / fasa timpang / skor sangat tinggi (bahan CUSUM di API)",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_KANDIDAT}}]},
        {"id": "t_gardu", "kind": "transform", "name": "neraca_gardu_jam", "input": "j_konteks", "x": 1600, "y": 60, "color": "lg-dugaan",
         "description": "Neraca AMI per gardu per jam dari meter pilot di gardu itu",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_GARDU_JAM}}]},
    ]
    location = {"id": folder, "name": f"{project} / iot / ami"}
    body = {"type": "streaming", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes,
            "outputs": [
                {"id": "o_skor", "name": "skor_ntl_jam", "node": "t_out", "kind": "dataset", "columns": None, "writeMode": "default",
                 "location": location, "x": 2560, "y": 220},
                {"id": "o_kandidat", "name": "kandidat_dugaan_jam", "node": "t_kandidat", "kind": "dataset", "columns": None, "writeMode": "default",
                 "location": location, "x": 2560, "y": 430},
                {"id": "o_gardu", "name": "neraca_gardu_jam", "node": "t_gardu", "kind": "dataset", "columns": None, "writeMode": "default",
                 "location": location, "x": 1920, "y": 60}],
            "legend": [{"id": "lg-mentah", "name": "Data mentah (stream)", "hex": "#64748b"}, {"id": "lg-bersih", "name": "Validasi / bersih", "hex": "#0ea5e9"},
                       {"id": "lg-jam", "name": "Agregasi & fitur per jam", "hex": "#d97706"}, {"id": "lg-konteks", "name": "Konteks (register & fitur batch)", "hex": "#2c9c9c"},
                       {"id": "lg-model", "name": "Model NTL (live deployment)", "hex": "#805ad5"}, {"id": "lg-dugaan", "name": "Kandidat & neraca gardu", "hex": "#dc2626"}],
            "location": location, "buildSettings": {"streamingProfile": "xs", "maxDurationMinutes": None},
            "textNodes": [
                {"id": "note_mentah", "x": 0, "y": -170, "w": 900, "h": 130, "color": "lg-mentah",
                 "text": "MENTAH -> BERSIH: bacaan 15 menit dari ingest stream MQTT divalidasi (kualitas bukan BAD, kWh >= 0), dihitung rasio arus fasa TM; "
                         "register meter dan fitur siklus tagihan menjadi konteks (bukan input model per jam selain lewat adaptor)."},
                {"id": "note_jam", "x": 640, "y": -170, "w": 900, "h": 130, "color": "lg-jam",
                 "text": "PER JAM: agregasi kWh per meter-jam dicabang ke peristiwa per jam (tamper magnet/buka tutup, fasa timpang), digabung (join) dengan "
                         "konteks gardu/ULP, lalu adaptor per jam mengisi fitur model: yang terukur dari stream terisi, fitur khas tagihan netral."},
                {"id": "note_model", "x": 1600, "y": -170, "w": 900, "h": 130, "color": "lg-model",
                 "text": "MODEL & DUGAAN: fungsi model live deployment menilai tiap baris jam; kandidat dugaan awal dan neraca gardu per jam menjadi bahan "
                         "detektor CUSUM di API yang menulis Peristiwa AMI ke Nexus. Kebenaran kejadian tidak pernah masuk pipeline ini."}],
            "meta": {"version": VERSION, "description": "Demo: skor NTL per jam dari stream AMI — graf kompleks mentah->bersih->per jam->model->dugaan (adaptor per jam)."}}
    if fn:
        body["functions"] = [{"id": fn_id, "kind": "pyfn", "name": "skor NTL per jam (adaptor)",
                              "description": "Fungsi model dari live deployment model NTL (demo), dipanggil per baris jam",
                              "args": [], "fn": {"functionId": fn["id"], "name": fn["name"], "version": fn["version"],
                                                 "repoName": "model deployment", "inputs": fn["inputs"], "output": fn["output"]}}]
    return body


def emulate(rows: list[dict], register: list[dict], fitur: list[dict]) -> dict[str, int]:
    """Emulasi graf (tanpa langkah model) atas bacaan contoh: jumlah baris tiap keluaran."""
    import demo_jkn_pipeline as base

    ga = __import__("demo_grid_ami")
    nodes = [{"id": "s_ami", "kind": "source", "name": "ami_meter_15menit (demo)"},
             {"id": "s_reg", "kind": "source", "name": "register_meter_ami_pilot"},
             {"id": "s_fitur", "kind": "source", "name": "fitur_ntl_pelanggan"},
             {"id": "t_bersih", "kind": "sql", "name": "ami_bersih_jam", "input": "s_ami", "sql": ga.SQL_BERSIH},
             {"id": "t_jam", "kind": "sql", "name": "agregasi_jam", "input": "t_bersih", "sql": SQL_JAM},
             {"id": "t_evt", "kind": "sql", "name": "peristiwa_jam", "input": "t_bersih", "sql": SQL_EVT},
             {"id": "j_konteks", "kind": "join", "name": "konteks_meter", "left": "t_jam", "right": "s_reg",
              "key": ("no_meter", "no_meter"), "right_cols": ["kode_dt", "kode_penyulang", "kode_ulp", "tegangan"]},
             {"id": "j_fitur", "kind": "join", "name": "fitur_dengan_peristiwa", "left": "j_konteks", "right": "t_evt",
              "key": ("no_meter", "no_meter"), "right_cols": ["tamper_jam", "fasa_timpang_jam"]},  # emulasi: kunci tunggal (runner memakai 2 kunci)
             {"id": "t_fitur", "kind": "sql", "name": "fitur_ntl_jam", "input": "j_fitur", "sql": SQL_FITUR},
             {"id": "t_gardu", "kind": "sql", "name": "neraca_gardu_jam", "input": "j_konteks", "sql": SQL_GARDU_JAM}]
    out = base.run({"ami_meter_15menit (demo)": rows, "register_meter_ami_pilot": register, "fitur_ntl_pelanggan": fitur}, nodes)
    return {k: len(v) for k, v in out.items()}


def build(state: dict, save) -> dict:
    import uuid

    import drive
    import functions_registry as fr
    import pipeline_datasets
    import pipeline_runtime as rt

    e = _e()
    st = state.setdefault("ntl_stream", {})
    out: dict[str, Any] = {}
    ami = e.STATE.get("ami") or {}
    if not ami.get("stream_id"):
        raise RuntimeError("langkah ami (sesi 5.1) belum ada: stream AMI belum dibangun")
    project = e._folder(None, e.PROJECT, "project")
    folder = e._folder(e._folder(project, "iot"), "ami")
    fn = next((f for f in fr.model_functions() if f["id"] == fr.MODEL_PREFIX + __import__("demo_grid_ml").FUNCTION_API), None)
    out["model_function"] = fn["id"] if fn else None
    pid = st.get("pipeline_id")
    current = None
    if pid:
        try:
            current = json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(pid)))
        except Exception:  # noqa: BLE001
            current, pid = None, None
    if not pid or (current.get("meta") or {}).get("version") != VERSION:
        import io

        import pyarrow.parquet as pq

        def read_item(iid: str | None) -> list[dict]:
            if not iid:
                return []
            try:
                return pq.read_table(io.BytesIO(drive.read_bytes(drive._item(iid)))).to_pylist()
            except Exception:  # noqa: BLE001
                return []

        ml_folder = e._folder(project, "ml")
        fitur_item = next((f["id"] for f in drive.list_files(ml_folder) if f["name"] == "fitur_ntl_pelanggan.parquet"
                           and not f.get("trashed_at")), None)
        items = {"register": ami.get("register_id"), "fitur": fitur_item}
        previews = {"register": read_item(items["register"]), "fitur": read_item(fitur_item)}
        ga = __import__("demo_grid_ami")
        t0 = int(time.time()) // 900 * 900
        sample = [r for r in (ga.reading(m, t0 - k * 900, ga.planted(t0), i) for k in range(4) for i, m in enumerate(ga.meters())) if r]
        out["emulasi"] = emulate(sample, previews["register"], previews["fitur"])
        body = _content(ami["stream_id"], items, previews, folder, e.PROJECT, lambda: uuid.uuid4().hex[:8], fn)
        if pid:
            body["createdAt"] = current.get("createdAt") or body["createdAt"]
            pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=body))
        else:
            pid = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(
                name=PIPELINE, parent_id=e._folder(project, "pipelines"), content=body))["id"]
        st["pipeline_id"] = pid
        st["deploy_needed"] = True
        save()
    out["pipeline_id"] = pid
    running = [b for b in rt._builds(pid, 20) if b.get("status") in ("queued", "running")]
    if st.get("deploy_needed") or not running:
        b = rt.queue_build(rt.NewBuild(pipeline_id=pid, trigger="demo"))
        st.update(build_id=b["id"], deploy_needed=False)
        save()
        out["deployed"] = b["id"]
    else:
        out["job"] = running[0]["id"]
    nt = _peristiwa_type()
    st["type_id"] = nt["type_id"]
    out["nexus"] = nt
    out["portal"] = _portal(pid)
    out["vertex"] = _vertex_graph()
    out["monitor"] = _monitor(nt["type_id"]) if nt.get("type_id") else None
    st["monitor"] = (out["monitor"] or {}).get("monitor_id")
    save()
    out["deteksi_awal"] = scan(create=True)
    st["deteksi"] = out["deteksi_awal"]
    save()
    return out


# ------------------------------------------------------------------------------------------------
# halaman /demo-grid: GET /api/demo/grid/ntl, suntik bypass, jalankan deteksi
# ------------------------------------------------------------------------------------------------

@router.get("")
def overview() -> dict:
    """Skor per jam & deteksi: pipeline, peristiwa di Nexus (sebagai pembaca), latensi per kejadian, false positive."""
    import ontology
    import pipeline_runtime as rt

    auth.require_user()
    e = _e()
    st = e.STATE.get("ntl_stream") or {}
    out: dict[str, Any] = {"built": bool(st.get("pipeline_id")), "pipeline_id": st.get("pipeline_id"), "type_id": st.get("type_id"),
                           "monitor": st.get("monitor"), "deteksi": st.get("deteksi"),
                           "adaptor": "Fitur model per siklus tagihan tidak tersedia per jam: perubahan_pct dari rasio baseline jam-sama, "
                                      "rasio_vs_peer dari neraca gardu per jam, event_tamper & rasio arus fasa dari stream; sisanya netral. "
                                      "Skor per jam = peringatan dini, bukan pengganti skor siklus tagihan."}
    if st.get("pipeline_id"):
        bs = rt._builds(st["pipeline_id"], 3)
        if bs:
            out["job"] = {"id": bs[0]["id"], "status": bs[0]["status"], "error": bs[0].get("error")}
    if st.get("type_id"):
        try:
            rec = ontology._object_type(st["type_id"])
            objs = ontology._objects(st["type_id"])
            rows = [{**(ontology._public_object(rec, pk, o).get("properties") or {}), "_pk": pk}
                    for pk, o in objs.items() if ontology._can_see(rec, o)]
            out["peristiwa"] = sorted(rows, key=lambda r: r.get("jam_deteksi") or "")[-30:]
            out["peristiwa_total"] = len(rows)
        except Exception as ex:  # noqa: BLE001
            out["peristiwa_total"], out["peristiwa_error"] = 0, str(ex)[:160]
    return out


def overview_numbers() -> dict:
    """Angka saja (blok halaman arsitektur)."""
    import ontology

    st = _e().STATE.get("ntl_stream") or {}
    det = st.get("deteksi") or {}
    n = None
    if st.get("type_id"):
        try:
            n = ontology.object_count(st["type_id"])
        except Exception:  # noqa: BLE001
            n = None
    return {"pipeline_id": st.get("pipeline_id"), "peristiwa": n, "dugaan": det.get("dugaan"),
            "false_positive": det.get("false_positive"), "latensi": det.get("latensi")}


class SuntikIn(BaseModel):
    no_meter: str


@router.post("/suntik")
def suntik(req: SuntikIn) -> dict:
    """Suntik bypass mulai sekarang pada satu meter pilot (demo langsung): kebenaran dicatat di ami_sim.json seperti
    kejadian tertanam lain, simulator dimulai ulang agar suntikan berlaku dari interval berikutnya."""
    import demo_grid_ami as ga

    e = _e()
    project = e.STATE.get("project_id")
    p = auth.current()
    if auth.enabled() and not (p and (auth._is_admin(p) or p.get("service") or (project and auth.role_for(project, p) == "owner"))):
        raise HTTPException(403, "Hanya administrator atau Owner Project demo yang dapat menyuntik bypass")
    m = next((x for x in ga.meters() if x["no_meter"] == req.no_meter), None)
    if not m:
        raise HTTPException(404, "meter bukan bagian pilot AMI (demo)")
    with _lock:
        st = ga._sim_state()
        events = st.get("events") or ga.planted(int(st.get("t0") or 0))
        n = 1 + sum(1 for ev in events if str(ev.get("id") or "").startswith("AMI-SUNTIK"))
        ev = {"id": f"AMI-SUNTIK-{n}", "no_meter": m["no_meter"], "id_pelanggan": m["id_pelanggan"], "pola": "NTL-01",
              "uraian": "Bypass suntikan demo langsung (demo)", "mulai": int(time.time()), "porsi": 0.85}
        events.append(ev)
        st["events"] = events
        ga._sim_save(st)  # the simulator re-reads the events each round: the injection applies from the next interval
    return {"suntikan": ev, "mulai_wib": datetime.fromtimestamp(ev["mulai"], WIB).strftime("%Y-%m-%d %H:%M"),
            "simulator": ga.sim_status()}


@router.post("/deteksi")
def deteksi() -> dict:
    """Jalankan satu putaran deteksi sekarang (fitur per jam -> skor model -> CUSUM -> Nexus + notifikasi)."""
    auth.require_user()
    with _lock:
        out = scan(create=True)
    _st()["deteksi"] = out
    _e()._save()
    return out
