"""Demo Grid, fase 5 sesi 3: sensor gardu distribusi — meter trafo per fasa + suhu minyak lewat MQTT streaming,
skor susut teknis (TL) dan risiko overload/penuaan mendekati real-time, rekomendasi L2 tanpa kendali SCADA
(dipanggil demo_grid_e2e.build, langkah "sensor_gardu"; dipasang server.py di /api/demo/grid/sensor-gardu).

  simulator sensor (thread API, fiktif) -> MQTT Broker (login demo-grid-dt-sim publish / demo-grid-dt-sync subscribe,
  topik spBv1.0/GridDemo/DDATA/HE-DT-DEMO-01/<kode_dt>) -> streaming sync -> ingest stream sensor_gardu_15menit
  -> "Pipeline sensor gardu grid (demo)" (streaming): validasi -> time series sync "Sensor gardu distribusi 15 menit
  (demo)" (kVA per gardu) + stream sensor_bersih -> tipe Nexus "Substation Sensor (demo)" (sensor dari Gardu Distribusi).
  Detektor di API: TL per jam (rugi besi + rugi tembaga trafo + I2R JTR) dan risiko overload dari suhu hotspot
  (model termal IEC 60076-7 yang disederhanakan: kenaikan oli sebanding K^2 dengan jeda termal, hotspot = oli +
  gradien belitan, laju penuaan relatif 2^((hotspot-98)/6)) -> rekomendasi sebagai objek Perintah Kerja berstatus
  usulan (rekomendasi L2: operator yang memutuskan; tidak ada jalur kendali ke SCADA).

Semua gardu distribusi demo disensor (meter trafo 3 fasa). Backfill 48 jam lalu live 15 menit; store-and-forward
seperti sesi 5.1. Fiktif, berlabel "(demo)"; aset OSM nyata tidak diberi angka demo. Read-only ke SCADA.
"""

from __future__ import annotations

import json
import logging
import math
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import auth

log = logging.getLogger("bluesandai.demo_grid_sensor_gardu")
router = APIRouter(prefix="/api/demo/grid/sensor-gardu")

TOPIC_ROOT = "spBv1.0/GridDemo"
SIM_USER = "demo-grid-dt-sim"
SYNC_USER = "demo-grid-dt-sync"
HEAD_END = "HE-DT-DEMO-01"
STREAM = "sensor_gardu_15menit (demo)"
SYNC = "Sync sensor gardu MQTT grid (demo)"
PIPELINE = "Pipeline sensor gardu grid (demo)"
VERSION = 2  # v2: graf kompleks (sumber konteks gardu, cabang seri/agregasi, join, TL & risiko sebagai output)
TS_OUT = "Sensor gardu distribusi 15 menit (demo)"
TYPE = ("Substation Sensor (demo)", "SensorGarduDemo", "kode_dt", "judul")
LINK = "Substation sensor (grid demo)"
REGISTER = "register_sensor_gardu"
ARCHIVE = "sensor_gardu_15menit_arsip"
INTERVAL_S = 900
BACKFILL_H = 48
PACE_S = 2.5
WIB = timezone(timedelta(hours=7))

SCHEMA = [("ts", "Long"), ("seq", "Long"), ("head_end", "String"), ("dt", "String"), ("kva", "Double"), ("beban_pct", "Double"),
          ("v_l1", "Double"), ("v_l2", "Double"), ("v_l3", "Double"), ("i_l1", "Double"), ("i_l2", "Double"), ("i_l3", "Double"),
          ("i_netral", "Double"), ("suhu_oli", "Double"), ("suhu_hotspot", "Double"), ("laju_penuaan", "Double"), ("kualitas", "String")]

SQL_BERSIH = """-- Bacaan sensor gardu 15 menit yang valid: status beban dan ketidakseimbangan fasa dari arus.
SELECT 'dt:' || dt AS seri_sensor, dt AS kode_dt,
       strftime('%Y-%m-%dT%H:%M:%SZ', ts / 1000, 'unixepoch') AS waktu_utc,
       strftime('%Y-%m-%d %H:%M', ts / 1000 + 25200, 'unixepoch') AS waktu_wib, ts,
       kva, beban_pct, v_l1, i_l1, i_l2, i_l3, i_netral, suhu_oli, suhu_hotspot, laju_penuaan,
       CASE WHEN MAX(i_l1, i_l2, i_l3) <= 0 THEN NULL ELSE ROUND(MIN(i_l1, i_l2, i_l3) / MAX(i_l1, i_l2, i_l3), 3) END AS rasio_fasa,
       CASE WHEN beban_pct >= 100 THEN 'Overload' WHEN beban_pct >= 85 THEN 'Beban tinggi' ELSE 'Normal' END AS status_beban
FROM input
WHERE kualitas <> 'BAD' AND kva >= 0"""

SQL_SERI = """-- Seri waktu beban gardu (kVA, 15 menit) untuk Time Series Catalog -> objek Sensor Gardu.
SELECT seri_sensor, waktu_utc, kva FROM input"""

SQL_JAM_S = """-- Agregasi per jam per gardu dari bacaan bersih: beban rata-rata & puncak, hotspot maksimum, arus per fasa.
SELECT kode_dt, strftime('%Y-%m-%d %H:00', ts / 1000 + 25200, 'unixepoch') AS jam_wib,
       ROUND(AVG(kva), 2) AS kva_rata, ROUND(MAX(kva), 2) AS kva_maks, ROUND(MAX(beban_pct), 1) AS beban_maks_pct,
       ROUND(MAX(suhu_hotspot), 1) AS hotspot_maks, ROUND(MAX(laju_penuaan), 2) AS penuaan_maks,
       ROUND(AVG(i_l1), 1) AS i_l1, ROUND(AVG(i_l2), 1) AS i_l2, ROUND(AVG(i_l3), 1) AS i_l3, ROUND(AVG(i_netral), 1) AS i_netral
FROM input
GROUP BY kode_dt, jam_wib"""

SQL_TL = """-- Susut teknis per gardu per jam (setelah join konteks gardu): trafo besi+tembaga K^2 dan JTR 3*I^2*R dengan
-- faktor ketidakseimbangan 1+1,6*(In/I)^2 (gaya pipeline susut). kWh hilang dalam satu jam.
SELECT kode_dt, kode_ulp, jam_wib, kva_rata,
       ROUND((rugi_besi_w + rugi_tembaga_w * (kva_rata / kva_rating) * (kva_rata / kva_rating)) / 1000.0, 3) AS rugi_trafo_kwh,
       ROUND(3 * ((i_l1 + i_l2 + i_l3) / 3) * ((i_l1 + i_l2 + i_l3) / 3) * (panjang_jtr_km * r_jtr_ohm_km / 3)
             * (1 + 1.6 * (i_netral / MAX((i_l1 + i_l2 + i_l3) / 3, 0.001)) * (i_netral / MAX((i_l1 + i_l2 + i_l3) / 3, 0.001))) / 1000.0, 3) AS rugi_jtr_kwh
FROM input"""

SQL_RISIKO = """-- Risiko overload & penuaan per gardu per jam: tingkat dari beban dan hotspot (IEC 60076-7 sederhana).
SELECT kode_dt, jam_wib, beban_maks_pct, hotspot_maks, penuaan_maks,
       CASE WHEN beban_maks_pct >= 100 OR hotspot_maks >= 110 THEN 'Overload'
            WHEN beban_maks_pct >= 85 OR hotspot_maks >= 95 THEN 'Waspada' ELSE 'Normal' END AS tingkat_risiko
FROM input"""

_lock = threading.RLock()
_sim: dict[str, Any] = {"thread": None, "stop": None, "client": None, "error": None}
_thermal: dict[str, float] = {}


def _e():
    import demo_grid_e2e as e

    return e


def _st() -> dict:
    return _e().STATE.setdefault("sensor_gardu", {})


# ------------------------------------------------------------------------------------------------
# gardu dan bacaannya (deterministik per interval)
# ------------------------------------------------------------------------------------------------

_cache: dict[str, Any] = {}


def gardu() -> list[dict]:
    """Semua gardu distribusi demo dengan yang dibutuhkan simulator (rating, rugi trafo, JTR, beban puncak simulasi)."""
    if "gardu" in _cache:
        return _cache["gardu"]
    import demo_grid_data as gd

    sim = gd.simulate()
    out = []
    for d in gd.network()["dts"]:
        days = sim["dts"].get(d["kode_dt"]) or []
        peak = sum(x["kva_puncak"] for x in days) / max(1, len(days))
        spread = days[0]["i"] if days else [1.0, 1.0, 1.0]
        mx = max(spread) or 1.0
        i_avg0 = (sum(spread) / 3) or 1.0
        out.append({"kode_dt": d["kode_dt"], "kode_penyulang": d["kode_penyulang"], "kode_ulp": d["kode_ulp"], "kva": d["kva"],
                    "rugi_besi_w": d["rugi_besi_w"], "rugi_tembaga_w": d["rugi_tembaga_w"], "panjang_jtr_km": d["panjang_jtr_km"],
                    "r_jtr_ohm_km": d["r_jtr_ohm_km"], "k_puncak": peak / d["kva"] if d["kva"] else 0.5,
                    "spread": [s / mx for s in spread], "rasio_netral": (days[0]["i_n"] / i_avg0) if days else 0.1,
                    "industri": "KWS" in d["kode_penyulang"]})
    _cache["gardu"] = out
    return out


def reading(g: dict, t_end: int, seq: int) -> dict | None:
    """Satu interval 15 menit berakhir t_end (epoch detik): beban per fasa, suhu oli/hotspot (IEC 60076-7 sederhana)."""
    import demo_grid_iot as gi

    rnd = random.Random(f"dt:{g['kode_dt']}:{t_end}")
    if rnd.random() < 0.003:
        return None
    wib = datetime.fromtimestamp(t_end - INTERVAL_S, WIB)
    prof = "industri_3shift" if g["industri"] else "rumah"
    sh = gi.shape(prof, wib.weekday())
    frac = sh[wib.hour] / max(sh)  # 0..1 di dalam hari
    k_ratio = g["k_puncak"] * (0.45 + 0.55 * frac) * (1 + rnd.gauss(0, 0.03))
    kva = k_ratio * g["kva"]
    i_tot = kva * 1000 / (math.sqrt(3) * 400)
    cur = [round(i_tot * s * (1 + rnd.gauss(0, 0.02)), 1) for s in g["spread"]]
    i_n = round((sum(cur) / 3) * g["rasio_netral"] * (1 + rnd.gauss(0, 0.05)), 1)  # arus netral dari ketidakseimbangan simulasi
    amb = 26 + 5 * math.sin((wib.hour - 9) / 24 * 2 * math.pi)  # suhu lingkungan harian (demo)
    target_oil = amb + 52 * min(1.7, k_ratio) ** 2  # kenaikan oli jenuh sebanding K^2 (ONAN, disederhanakan)
    prev = _thermal.get(g["kode_dt"], target_oil)
    oil = prev + (target_oil - prev) * (INTERVAL_S / 7200)  # jeda termal oli ±2 jam
    _thermal[g["kode_dt"]] = oil
    hotspot = oil + 21 * min(1.7, k_ratio) ** 1.3  # gradien hotspot belitan
    return {"ts": t_end * 1000, "seq": seq, "head_end": HEAD_END, "dt": g["kode_dt"], "kva": round(kva, 2),
            "beban_pct": round(100 * k_ratio, 1),
            "v_l1": round(400 * (1 + rnd.gauss(0, 0.004)), 1), "v_l2": round(400 * (1 + rnd.gauss(0, 0.004)), 1),
            "v_l3": round(400 * (1 + rnd.gauss(0, 0.004)), 1),
            "i_l1": cur[0], "i_l2": cur[1], "i_l3": cur[2], "i_netral": i_n,
            "suhu_oli": round(oil, 1), "suhu_hotspot": round(hotspot, 1),
            "laju_penuaan": round(2 ** ((hotspot - 98) / 6), 2), "kualitas": "GOOD"}


def tl_jam(g: dict, kva: float, arus: list[float]) -> dict:
    """Susut teknis satu jam pada beban ini: trafo (besi tetap + tembaga K^2) dan JTR (3*I^2*R dengan faktor
    ketidakseimbangan 1+1,6*(In/I)^2, gaya perhitungan pipeline susut). kWh per jam."""
    k = kva / g["kva"] if g["kva"] else 0.0
    trafo = (g["rugi_besi_w"] + g["rugi_tembaga_w"] * k * k) / 1000
    i_avg = sum(arus) / 3 if arus else 0.0
    r_total = g["panjang_jtr_km"] * g["r_jtr_ohm_km"] / 3
    jtr = 3 * i_avg ** 2 * r_total * (1 + 1.6 * g["rasio_netral"] ** 2) / 1000
    return {"rugi_trafo_kwh": round(trafo, 3), "rugi_jtr_kwh": round(jtr, 3), "tl_kwh": round(trafo + jtr, 3), "k_beban": round(k, 3)}


# ------------------------------------------------------------------------------------------------
# simulator (thread API -> MQTT), pola sesi 5.1 dengan state sendiri
# ------------------------------------------------------------------------------------------------

def _sim_file():
    return _e().DIR / "sensor_sim.json"


def _sim_state() -> dict:
    try:
        return json.loads(_sim_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _sim_save(st: dict) -> None:
    _sim_file().write_text(json.dumps(st), encoding="utf-8")


def _secret() -> str | None:
    try:
        return json.loads((_e().DIR / "sensor_secret.json").read_text(encoding="utf-8")).get(SIM_USER)
    except (OSError, ValueError):
        return None


def _sync_status() -> str | None:
    import streaming as S

    sid = _sim_state().get("sync_id") or _st().get("sync_id")
    if not sid:
        return None
    with S._db() as con:
        row = con.execute("SELECT record FROM syncs WHERE id = ?", (sid,)).fetchone()
    return json.loads(row[0]).get("status") if row else None


def _connect():
    import paho.mqtt.client as mqtt

    import mqtt_broker

    port = int(((mqtt_broker._state().get("ports") or {}).get("mqtt")) or 1883)
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="demo-grid-dt-simulator", protocol=mqtt.MQTTv311)
    c.username_pw_set(SIM_USER, _secret())
    c.max_inflight_messages_set(500)
    c.max_queued_messages_set(0)
    c.connect("localhost", port, keepalive=60)
    c.loop_start()
    return c


def _publish(c: Any, t_end: int, st: dict) -> int:
    n, infos = 0, []
    for g in gardu():
        st["seq"] = int(st.get("seq") or 0) + 1
        r = reading(g, t_end, st["seq"])
        if r is None:
            continue
        infos.append(c.publish(f"{TOPIC_ROOT}/DDATA/{HEAD_END}/{g['kode_dt']}", json.dumps(r), qos=1))
        n += 1
    for i in infos:
        i.wait_for_publish(timeout=30)
    return n


def _run(stop: threading.Event) -> None:
    st = _sim_state()
    for _ in range(60):
        if stop.is_set() or _sync_status() == "running":
            break
        stop.wait(2)
    c = None
    while not stop.is_set():
        try:
            if c is None:
                c = _connect()
                _sim["client"] = c
            now = int(time.time()) // INTERVAL_S * INTERVAL_S
            last = int(st.get("last_interval") or (now - BACKFILL_H * 3600))
            last = max(last, now - BACKFILL_H * 3600)
            while last + INTERVAL_S <= now and not stop.is_set():
                last += INTERVAL_S
                n = _publish(c, last, st)
                st.update(last_interval=last, published=int(st.get("published") or 0) + n,
                          updated_at=datetime.now(timezone.utc).isoformat())
                _sim_save(st)
                if last + INTERVAL_S <= now:
                    stop.wait(PACE_S)
            _sim["error"] = None
            stop.wait(max(2, now + INTERVAL_S - time.time() + 5))
        except Exception as ex:  # noqa: BLE001
            _sim["error"] = str(ex)[:300]
            log.warning("demo grid DT sensor simulator: %s", ex)
            try:
                if c is not None:
                    c.loop_stop(); c.disconnect()
            except Exception:  # noqa: BLE001
                pass
            c = None
            stop.wait(30)
    if c is not None:
        c.loop_stop(); c.disconnect()


def sim_start() -> dict:
    import streaming as S

    with _lock:
        st = _sim_state()
        sid = st.get("sync_id")
        if not sid or not _secret():
            raise HTTPException(409, "Bangun dulu langkah sensor gardu (POST /api/demo/grid/e2e)")
        if _sync_status() != "running":
            S._start(sid)
        st["enabled"] = True
        _sim_save(st)
        t = _sim.get("thread")
        if not (t and t.is_alive()):
            stop = threading.Event()
            t = threading.Thread(target=_run, args=(stop,), daemon=True, name="demo-grid-dt-sim")
            _sim.update(thread=t, stop=stop)
            t.start()
    return sim_status()


def sim_stop() -> dict:
    with _lock:
        st = _sim_state()
        st["enabled"] = False
        _sim_save(st)
        if _sim.get("stop"):
            _sim["stop"].set()
    return sim_status()


def sim_status() -> dict:
    st = _sim_state()
    t = _sim.get("thread")
    return {"enabled": bool(st.get("enabled")), "running": bool(t and t.is_alive()), "gardu": len(gardu()),
            "published": st.get("published") or 0,
            "last_interval": datetime.fromtimestamp(st["last_interval"], timezone.utc).isoformat() if st.get("last_interval") else None,
            "error": _sim.get("error"), "sync_status": _sync_status()}


@router.on_event("startup")
def _resume() -> None:
    def run() -> None:
        try:
            time.sleep(25)
            if _sim_state().get("enabled"):
                sim_start()
        except Exception as ex:  # noqa: BLE001
            _sim["error"] = str(ex)[:300]
            log.warning("demo grid DT sensor simulator did not resume: %s", ex)

    threading.Thread(target=run, daemon=True, name="demo-grid-dt-resume").start()


# ------------------------------------------------------------------------------------------------
# build: login broker, register, sync, pipeline streaming, tipe Nexus, detektor risiko
# ------------------------------------------------------------------------------------------------

def _credentials() -> dict:
    import mqtt_broker as mb

    out = {}
    secret_file = _e().DIR / "sensor_secret.json"
    try:
        secrets = json.loads(secret_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        secrets = {}
    for user, access, label in ((SIM_USER, "write", "Demo: simulator sensor gardu (fiktif), hanya publish"),
                                (SYNC_USER, "read", "Demo: streaming sync sensor gardu, hanya subscribe")):
        have = next((c for c in mb._creds() if c["username"] == user), None)
        if have and secrets.get(user):
            out[user] = have["id"]
            continue
        if have:
            mb.delete_credential(have["id"])
        r = mb.create_credential(mb.CredentialIn(username=user, label=label, topics=[mb.TopicIn(pattern=f"{TOPIC_ROOT}/#", access=access)]))
        secrets[user] = r["password"]
        out[user] = r["id"]
    secret_file.write_text(json.dumps(secrets), encoding="utf-8")
    return out


def _register_rows() -> list[dict]:
    return [{"kode_dt": g["kode_dt"], "judul": f"Sensor {g['kode_dt']} · {g['kode_penyulang']}", "kode_penyulang": g["kode_penyulang"],
             "kode_ulp": g["kode_ulp"], "kva_rating": g["kva"], "rugi_besi_w": g["rugi_besi_w"], "rugi_tembaga_w": g["rugi_tembaga_w"],
             "panjang_jtr_km": g["panjang_jtr_km"], "r_jtr_ohm_km": g["r_jtr_ohm_km"], "head_end": HEAD_END, "interval_menit": 15,
             "protokol": "MQTT · Sparkplug B (namespace), payload JSON", "seri_sensor": f"dt:{g['kode_dt']}",
             "nama_sensor": "Beban sensor gardu", "satuan": "kVA"} for g in gardu()]


def _content(stream_id: str, items: dict, previews: dict, folder: str, project: str, uid) -> dict:
    """Graf kompleks (pola pipeline audit JKN): 3 sumber (stream + register sensor + status gardu batch), cabang seri &
    agregasi per jam, join konteks, TL dan risiko sebagai output tersendiri. Mentah -> bersih -> seri/TL/risiko."""
    import demo_jkn_pipeline as base

    now = datetime.now(timezone.utc).isoformat()

    def src(nid: str, name: str, item: str | None, rows: list[dict], x: int, y: int, color: str, desc: str) -> dict:
        ds = f"ds_{nid}"
        ref = {"kind": "ingest", "streamId": item} if nid == "s_dt" else {"kind": "drive", "itemId": item}
        return {"node": {"id": nid, "kind": "source", "name": name, "x": x, "y": y, "color": color, "datasetId": ds, "description": desc},
                "ds": (ds, {"id": ds, "name": name, "origin": ("Streaming · " if nid == "s_dt" else "Files · ") + project,
                            "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in (SCHEMA if nid == "s_dt" else base.schema_of(rows))],
                            "rows": rows[:50], "ref": ref})}

    parts = [
        src("s_dt", STREAM, stream_id, [], 0, 300, "lg-mentah", "Ingest stream streaming sync MQTT: meter trafo per fasa + suhu minyak (mentah)"),
        src("s_reg", REGISTER, items.get("register"), previews.get("register") or [], 0, 60, "lg-konteks",
            "Register sensor gardu: rating trafo, rugi besi/tembaga, JTR tiap gardu"),
        src("s_gardu", "gardu_distribusi_status", items.get("gardu"), previews.get("gardu") or [], 0, 560, "lg-konteks",
            "Status gardu dari pipeline susut (batch): pembanding status beban & susut bulanan"),
    ]
    nodes = [p["node"] for p in parts]
    datasets = dict(p["ds"] for p in parts)
    nodes += [
        {"id": "t_bersih", "kind": "transform", "name": "sensor_bersih", "input": "s_dt", "x": 320, "y": 300, "color": "lg-bersih",
         "description": "Validasi bacaan + status beban (Normal/Beban tinggi/Overload) + rasio fasa",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_BERSIH}}]},
        {"id": "t_seri", "kind": "transform", "name": "seri_beban_sensor", "input": "t_bersih", "x": 640, "y": 430, "color": "lg-seri",
         "description": "Seri kVA per gardu untuk Time Series Catalog (objek Sensor Gardu)",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_SERI}}]},
        {"id": "t_jam", "kind": "transform", "name": "agregasi_jam_gardu", "input": "t_bersih", "x": 640, "y": 180, "color": "lg-jam",
         "description": "Agregasi per jam: beban rata/puncak, hotspot & penuaan maksimum, arus per fasa",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_JAM_S}}]},
        {"id": "j_konteks", "kind": "join", "name": "konteks_gardu", "left": "t_jam", "right": "s_reg", "x": 960, "y": 180, "color": "lg-konteks",
         "leftKey": "kode_dt", "rightKey": "kode_dt", "keys": [{"left": "kode_dt", "right": "kode_dt"}], "how": "left",
         "leftColumns": None, "rightColumns": ["kva_rating", "rugi_besi_w", "rugi_tembaga_w", "panjang_jtr_km", "r_jtr_ohm_km", "kode_ulp"],
         "description": "Konteks fisik gardu untuk perhitungan susut teknis"},
        {"id": "t_tl", "kind": "transform", "name": "tl_gardu_jam", "input": "j_konteks", "x": 1280, "y": 180, "color": "lg-tl",
         "description": "Susut teknis per jam: trafo (besi + tembaga K2) dan JTR (3I2R + ketidakseimbangan)",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_TL}}]},
        {"id": "t_risiko", "kind": "transform", "name": "risiko_gardu_jam", "input": "t_jam", "x": 1280, "y": 360, "color": "lg-tl",
         "description": "Risiko overload & penuaan per jam (beban/hotspot, IEC 60076-7 sederhana)",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_RISIKO}}]},
        {"id": "j_status", "kind": "join", "name": "banding_status_gardu", "left": "t_risiko", "right": "s_gardu", "x": 1600, "y": 360, "color": "lg-konteks",
         "leftKey": "kode_dt", "rightKey": "kode_dt", "keys": [{"left": "kode_dt", "right": "kode_dt"}], "how": "left",
         "leftColumns": None, "rightColumns": ["status_gardu", "susut_pct"],
         "description": "Bandingkan risiko streaming dengan status gardu batch (Jul-Sep)"},
        {"id": "t_banding", "kind": "transform", "name": "status_banding_gardu", "input": "j_status", "x": 1920, "y": 360, "color": "lg-tl",
         "description": "Gardu yang risikonya kini lebih tinggi dari status batch-nya",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query":
             "SELECT kode_dt, jam_wib, tingkat_risiko, status_gardu, beban_maks_pct, hotspot_maks FROM input WHERE tingkat_risiko <> 'Normal'"}}]},
    ]
    location = {"id": folder, "name": f"{project} / iot / gardu"}
    return {"type": "streaming", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes,
            "outputs": [{"id": "o_bersih", "name": "sensor_bersih", "node": "t_bersih", "kind": "dataset", "columns": None,
                         "writeMode": "default", "location": location, "x": 960, "y": 520},
                        {"id": "o_seri", "name": TS_OUT, "node": "t_seri", "kind": "timeSeries",
                         "timeSeries": {"seriesId": "seri_sensor", "timestamp": "waktu_utc", "value": "kva"},
                         "columns": None, "writeMode": "default", "location": location, "x": 960, "y": 640},
                        {"id": "o_tl", "name": "tl_gardu_jam", "node": "t_tl", "kind": "dataset", "columns": None,
                         "writeMode": "default", "location": location, "x": 1600, "y": 180},
                        {"id": "o_risiko", "name": "risiko_gardu_jam", "node": "t_risiko", "kind": "dataset", "columns": None,
                         "writeMode": "default", "location": location, "x": 1600, "y": 480},
                        {"id": "o_banding", "name": "status_banding_gardu", "node": "t_banding", "kind": "dataset", "columns": None,
                         "writeMode": "default", "location": location, "x": 2240, "y": 360}],
            "legend": [{"id": "lg-mentah", "name": "Data mentah (stream)", "hex": "#64748b"}, {"id": "lg-bersih", "name": "Validasi & status", "hex": "#0ea5e9"},
                       {"id": "lg-jam", "name": "Agregasi per jam", "hex": "#d97706"}, {"id": "lg-konteks", "name": "Konteks gardu (register & batch)", "hex": "#2c9c9c"},
                       {"id": "lg-seri", "name": "Seri beban (time series)", "hex": "#6b46c1"}, {"id": "lg-tl", "name": "TL & risiko overload", "hex": "#dc2626"}],
            "location": location, "buildSettings": {"streamingProfile": "xs", "maxDurationMinutes": None},
            "textNodes": [
                {"id": "note_mentah", "x": 0, "y": -170, "w": 900, "h": 130, "color": "lg-mentah",
                 "text": "MENTAH -> BERSIH: bacaan meter trafo per fasa + suhu minyak 15 menit dari MQTT divalidasi; status beban per bacaan "
                         "(Normal <85%, Beban tinggi <100%, Overload) dan rasio fasa dihitung di sini."},
                {"id": "note_jam", "x": 640, "y": -170, "w": 900, "h": 130, "color": "lg-jam",
                 "text": "PER JAM: agregasi beban/hotspot dicabang ke seri kVA (objek Sensor Gardu) dan ke perhitungan TL: join register gardu memberi "
                         "rating, rugi trafo dan JTR; risiko overload dari beban & hotspot (model termal IEC 60076-7 yang disederhanakan)."},
                {"id": "note_risiko", "x": 1280, "y": -170, "w": 900, "h": 130, "color": "lg-tl",
                 "text": "RISIKO & REKOMENDASI: risiko per jam dibandingkan dengan status gardu batch; detektor di API mengubah gardu Overload menjadi "
                         "Perintah Kerja usulan (rekomendasi L2: penyeimbangan/uprating) — operator memutuskan, tidak ada kendali ke SCADA."}],
            "meta": {"version": VERSION, "description": "Demo: sensor gardu streaming — graf kompleks mentah->bersih->seri/TL/risiko overload & penuaan."}}


def emulate_sensor(rows: list[dict], register: list[dict]) -> dict[str, int]:
    """Emulasi graf (SQL saja) atas bacaan contoh."""
    import demo_jkn_pipeline as base

    nodes = [{"id": "s_dt", "kind": "source", "name": STREAM},
             {"id": "s_reg", "kind": "source", "name": REGISTER},
             {"id": "t_bersih", "kind": "sql", "name": "sensor_bersih", "input": "s_dt", "sql": SQL_BERSIH},
             {"id": "t_jam", "kind": "sql", "name": "agregasi_jam_gardu", "input": "t_bersih", "sql": SQL_JAM_S},
             {"id": "j_konteks", "kind": "join", "name": "konteks_gardu", "left": "t_jam", "right": "s_reg",
              "key": ("kode_dt", "kode_dt"), "right_cols": ["kva_rating", "rugi_besi_w", "rugi_tembaga_w", "panjang_jtr_km", "r_jtr_ohm_km", "kode_ulp"]},
             {"id": "t_tl", "kind": "sql", "name": "tl_gardu_jam", "input": "j_konteks", "sql": SQL_TL},
             {"id": "t_risiko", "kind": "sql", "name": "risiko_gardu_jam", "input": "t_jam", "sql": SQL_RISIKO}]
    out = base.run({STREAM: rows, REGISTER: register}, nodes)
    return {k: len(v) for k, v in out.items()}


def _sensor_type(register_id: str) -> dict:
    import ontology
    import ontology_datasources as ods
    import ontology_model as om
    import ontology_security as osec

    import demo_grid_akses as ak
    import demo_grid_e2e as e

    name, api, pk, title = TYPE
    out: dict[str, Any] = {}
    t = next((x for x in ontology._all("object-types") if x["display_name"] == name), None)
    if not t:
        import demo_jkn_pipeline as base

        rows = _register_rows()
        props = [e._prop(c, e.PTYPE[ty], "gardu") for c, ty in base.schema_of(rows)]
        t = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=name, plural_name=name, api_name=api, primary_key=pk, title_property=title, icon="device", color="#d97706",
            description="Demo: sensor gardu distribusi (meter trafo 3 fasa + suhu minyak, fiktif) — streaming 15 menit; sensor dari Gardu Distribusi, seri kVA.",
            properties=[ontology.Property(**p) for p in props]))
        out["created"] = True
    if (ontology._object_type(t["id"]).get("backing_dataset") or {}).get("dataset_id") != register_id:
        ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=register_id, columns=None, map_unmapped=True))
    gd = e._type("gardu")
    if gd and LINK not in {x.get("display_name") for x in ontology._all("link-types")}:
        om.create_link_type(om.LinkTypeIn(display_name=LINK, kind="foreign_key", cardinality="many_to_one", foreign_key="kode_dt",
                                          source=om.LinkSide(object_type_id=t["id"], display_name="Sensor gardu", plural_display_name="Sensor gardu"),
                                          target=om.LinkSide(object_type_id=gd["id"], display_name="Gardu distribusi")))
        out["link"] = True
    groups = (e.STATE.get("akses") or {}).get("groups") or {}
    if groups.get("up3"):
        sec = ontology._object_type(t["id"]).get("security") or {}
        op = {**(sec.get("object_policy") or {"markings": []}), "granular": ak.policy([groups["up3"], groups.get("analis"), groups.get("ops")])}
        if (sec.get("object_policy") or {}).get("granular") != op["granular"]:
            osec.set_security(t["id"], osec.SecurityIn(object_policy=op, property_policies=sec.get("property_policies") or []))
            out["policy"] = "per ULP/grup aset"
    out["type_id"] = t["id"]
    return out


def _tsp(type_id: str) -> str | None:
    import ontology
    import timeseries
    import ts_ontology as tso

    import demo_grid_e2e as e

    s = next((x for x in timeseries.all_syncs("timeseries") if x.get("name") == TS_OUT), None)
    if not s:
        return None
    rec = ontology._object_type(type_id)
    if ((rec.get("time_series") or {}).get("properties") or {}).get("seri_sensor"):
        return s["id"]
    gd = e._type("gardu")
    tso.add_tsp(type_id, tso.AddTsp(property="seri_sensor", syncs=[s["id"]], unit=tso.Formatting(value="kVA"),
                                    interpolation=tso.Formatting(value="LINEAR"), make_default=True,
                                    sensor=tso.SensorConfig(links=[tso.SensorLink(root_object_type_id=gd["id"], foreign_key="kode_dt",
                                                                                  sensor_name_property="nama_sensor")])))
    return s["id"]


def scan(create: bool = True) -> dict:
    """TL per jam terakhir + risiko overload dari stream sensor; rekomendasi L2 = Perintah Kerja usulan (idempoten per gardu+tanggal)."""
    import streaming as S

    stream_id = _st().get("stream_id")
    if not stream_id:
        return {"error": "stream belum ada"}
    reg = {g["kode_dt"]: g for g in gardu()}
    last: dict[str, dict] = {}
    total_tl = 0.0
    after = 0
    while True:
        page = S.read_records(stream_id, after=after, limit=5000)
        rows = page.get("rows") or []
        if not rows:
            break
        for r in rows:
            k = r.get("dt")
            if k and int(r.get("ts") or 0) >= int((last.get(k) or {}).get("ts") or 0):
                last[k] = r
        after = int(page.get("last_seq") or after)
        if len(rows) < 5000:
            break
    risiko, tl_rows = [], []
    for kode, r in sorted(last.items()):
        g = reg.get(kode)
        if not g:
            continue
        tl = tl_jam(g, float(r.get("kva") or 0), [float(r.get("i_l1") or 0), float(r.get("i_l2") or 0), float(r.get("i_l3") or 0)])
        total_tl += tl["tl_kwh"]
        tl_rows.append({"kode_dt": kode, **tl})
        beban, hot = float(r.get("beban_pct") or 0), float(r.get("suhu_hotspot") or 0)
        if beban >= 100 or hot >= 110:
            risiko.append({"kode_dt": kode, "kode_ulp": g["kode_ulp"], "beban_pct": beban, "suhu_hotspot": hot,
                           "laju_penuaan": r.get("laju_penuaan"), "tingkat": "Overload"})
        elif beban >= 85 or hot >= 95:
            risiko.append({"kode_dt": kode, "kode_ulp": g["kode_ulp"], "beban_pct": beban, "suhu_hotspot": hot,
                           "laju_penuaan": r.get("laju_penuaan"), "tingkat": "Waspada"})
    made = _rekomendasi(risiko, reg) if create else []
    return {"gardu_terbaca": len(last), "tl_kwh_jam_terakhir": round(total_tl, 1), "tl_teratas": sorted(tl_rows, key=lambda x: -x["tl_kwh"])[:8],
            "risiko": risiko, "rekomendasi_baru": made, "pada": datetime.now(timezone.utc).isoformat()}


def _rekomendasi(risiko: list[dict], reg: dict) -> list[str]:
    import ontology

    e = _e()
    t = e._type("perintah")
    if not t:
        return []
    objs = ontology.load_objects(t["id"])
    today = datetime.now(WIB).strftime("%Y-%m-%d")
    made = []
    for r in risiko:
        if r["tingkat"] != "Overload":
            continue
        pk = f"PK-SENSOR-{r['kode_dt']}-{today}"
        if pk in objs:
            continue
        g = reg[r["kode_dt"]]
        jenis = "Penyeimbangan beban" if g["rasio_netral"] > 0.25 else "Sisip / uprating trafo"
        objs[pk] = {"properties": {
            "id_perintah": pk, "judul": f"Usulan sensor: {jenis.lower()} {r['kode_dt']} (demo)", "kode_dt": r["kode_dt"],
            "kode_penyulang": g["kode_penyulang"], "id_temuan": "", "jenis_pekerjaan": jenis,
            "uraian": f"Rekomendasi L2 dari sensor gardu (streaming): beban {r['beban_pct']}% rating, hotspot {r['suhu_hotspot']} C, "
                      f"laju penuaan relatif {r['laju_penuaan']}x. Tanpa kendali SCADA — operator memutuskan.",
            "estimasi_biaya_rp": 0, "estimasi_penghematan_kwh_bulan": 0, "tanggal_target": today,
            "status_pekerjaan": "Usulan sensor (demo)", "pelaksana": ""},
            "created_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()}
        made.append(pk)
    if made:
        ontology.save_objects(t["id"], objs, changed=made)
    return made


GRAPH = "Demo: Risiko overload gardu (sensor streaming)"


def _portal(pid: str) -> list[str]:
    import agentic_apps

    return [agentic_apps.register(agentic_apps.AppIn(
        name="Sensor gardu & risiko overload (demo)", kind="page", href="/demo-grid?bagian=sensor-gardu", icon="device", collection="Grid Management",
        description="Demo: sensor gardu distribusi streaming (beban per fasa, suhu minyak), TL per jam, risiko overload, rekomendasi L2.",
        tags=["grid", "sensor", "streaming", "demo"]))["id"],
            agentic_apps.register(agentic_apps.AppIn(
        name="Pipeline sensor gardu grid (demo)", kind="page", href=f"/pipeline/{pid}", icon="pipeline", collection="Grid Management",
        description="Demo: pipeline streaming sensor gardu -> seri kVA + stream bersih untuk TL & risiko overload.",
        tags=["grid", "sensor", "streaming", "demo"]))["id"]]


def build(state: dict, save) -> dict:
    import uuid

    import drive
    import mqtt_broker as mb
    import pipeline_datasets
    import pipeline_runtime as rt
    import stream_datasets
    import streaming as S

    e = _e()
    st = state.setdefault("sensor_gardu", {})
    out: dict[str, Any] = {}
    project = e._folder(None, e.PROJECT, "project")
    raw_folder = e._folder(e._folder(e._folder(project, "raw"), "iot"), "gardu")
    folder = e._folder(e._folder(project, "iot"), "gardu")
    if not mb.running():
        mb.start()
    out["logins"] = _credentials()
    reg = e._put(folder, REGISTER, _register_rows())
    st["register_id"] = reg
    port = int((mb._state().get("ports") or {}).get("mqtt") or 1883)
    secrets = json.loads((e.DIR / "sensor_secret.json").read_text(encoding="utf-8"))
    sid = st.get("sync_id")
    if sid:
        try:
            S._sync_row(sid)
        except HTTPException:
            sid = None
    if not sid:
        stream_id = st.get("stream_id")
        try:
            if stream_id:
                S._stream(stream_id)
        except HTTPException:
            stream_id = None
        if not stream_id:
            stream_id = S._create_stream(S.StreamIn(name=STREAM, schema=[S.ColumnIn(name=c, type=t) for c, t in SCHEMA],
                                                    keys=S.KeysIn(partition=["dt"])))["id"]
        rec = S.create_sync(S.SyncIn(name=SYNC, kind="mqtt", stream_id=stream_id, project_id=project, start=False, profiles=["default"],
                                     config={"host": "localhost", "port": port, "topics": f"{TOPIC_ROOT}/DDATA/{HEAD_END}/#", "user": SYNC_USER,
                                             "password": secrets[SYNC_USER], "qos": 1, "client_id": "bsai-demo-grid-dt", "value_format": "json"}))
        sid = rec["id"]
        st.update(sync_id=sid, stream_id=stream_id)
        save()
    out["sync_id"], out["stream_id"] = sid, st["stream_id"]
    sim = _sim_state()
    sim.update(sync_id=sid, stream_id=st["stream_id"])
    _sim_save(sim)
    try:
        if not stream_datasets._archive(st["stream_id"]):
            stream_datasets.set_archive(st["stream_id"], stream_datasets.ArchiveIn(folder_id=raw_folder, every_minutes=15, name=ARCHIVE))
        out["archive"] = True
    except Exception as ex:  # noqa: BLE001
        out["archive"] = f"belum: {getattr(ex, 'detail', ex)}"
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

        susut = e._folder(project, "susut")
        gardu_item = next((f["id"] for f in drive.list_files(susut) if f["name"] == "gardu_distribusi_status.parquet"
                           and not f.get("trashed_at")), None)
        items = {"register": reg, "gardu": gardu_item}
        previews = {"register": _register_rows(), "gardu": read_item(gardu_item)}
        t0 = int(time.time()) // INTERVAL_S * INTERVAL_S
        sample = [r for r in (reading(g, t0 - k * INTERVAL_S, i) for k in range(4) for i, g in enumerate(gardu())) if r]
        out["emulasi"] = emulate_sensor(sample, previews["register"])
        body = _content(st["stream_id"], items, previews, folder, e.PROJECT, lambda: uuid.uuid4().hex[:8])
        if pid:
            body["createdAt"] = current.get("createdAt") or body["createdAt"]
            pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=body))
        else:
            pid = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=e._folder(project, "pipelines"), content=body))["id"]
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
    nt = _sensor_type(reg)
    st["type_id"] = nt["type_id"]
    out["nexus"] = nt
    out["tsp_sync"] = _tsp(nt["type_id"])
    st["ts_sync_id"] = out["tsp_sync"]
    out["portal"] = _portal(pid)
    save()
    try:
        sim_start()
        out["simulator"] = "started"
    except Exception as ex:  # noqa: BLE001
        out["simulator"] = f"belum: {getattr(ex, 'detail', ex)}"
    out["deteksi_awal"] = scan(create=True)
    st["deteksi"] = out["deteksi_awal"]
    save()
    return out


# ------------------------------------------------------------------------------------------------
# halaman /demo-grid: GET /api/demo/grid/sensor-gardu
# ------------------------------------------------------------------------------------------------

@router.get("")
def overview() -> dict:
    """Sensor gardu live: simulator, sync, stream, job, seri, TL & risiko terakhir."""
    import mqtt_broker as mb
    import pipeline_runtime as rt
    import streaming as S
    import timeseries

    auth.require_user()
    e = _e()
    st = e.STATE.get("sensor_gardu") or {}
    out: dict[str, Any] = {"built": bool(st.get("pipeline_id")), "pipeline_id": st.get("pipeline_id"), "type_id": st.get("type_id"),
                           "simulator": sim_status(), "deteksi": st.get("deteksi"), "topik": f"{TOPIC_ROOT}/DDATA/{HEAD_END}/<kode_dt>"}
    try:
        b = mb.status_public()
        sm = b.get("summary") or {}
        out["broker"] = {"running": b.get("status") == "running", "clients": sm.get("clients"), "messages_per_min": sm.get("messages_last_minute")}
    except Exception as ex:  # noqa: BLE001
        out["broker"] = {"running": False, "error": str(ex)[:120]}
    if st.get("stream_id"):
        with S._db() as con:
            n = con.execute("SELECT COUNT(*), MAX(at) FROM records WHERE stream_id = ?", (st["stream_id"],)).fetchone()
        out["stream"] = {"id": st["stream_id"], "name": STREAM, "records": n[0], "last_at": n[1]}
    if st.get("pipeline_id"):
        bs = rt._builds(st["pipeline_id"], 3)
        if bs:
            out["job"] = {"id": bs[0]["id"], "status": bs[0]["status"], "error": bs[0].get("error")}
    s = next((x for x in timeseries.all_syncs("timeseries") if x.get("name") == TS_OUT), None)
    if s:
        out["series"] = {"sync_id": s["id"], "points": s.get("points_total"), "last_write_at": s.get("last_write_at")}
    return out


def overview_numbers() -> dict:
    """Angka saja (blok arsitektur)."""
    import streaming as S

    st = _e().STATE.get("sensor_gardu") or {}
    det = st.get("deteksi") or {}
    out = {"pipeline_id": st.get("pipeline_id"), "gardu": len(gardu()), "published": sim_status()["published"],
           "tl_kwh": det.get("tl_kwh_jam_terakhir"), "risiko": len(det.get("risiko") or [])}
    if st.get("stream_id"):
        with S._db() as con:
            out["stream_records"] = con.execute("SELECT COUNT(*) FROM records WHERE stream_id = ?", (st["stream_id"],)).fetchone()[0]
    return out


class SimIn(BaseModel):
    enabled: bool


@router.post("/simulator")
def set_simulator(req: SimIn) -> dict:
    e = _e()
    project = e.STATE.get("project_id")
    p = auth.current()
    if auth.enabled() and not (p and (auth._is_admin(p) or p.get("service") or (project and auth.role_for(project, p) == "owner"))):
        raise HTTPException(403, "Hanya administrator atau Owner Project demo yang dapat menyalakan simulator")
    return sim_start() if req.enabled else sim_stop()


@router.post("/deteksi")
def deteksi() -> dict:
    auth.require_user()
    with _lock:
        out = scan(create=True)
    _st()["deteksi"] = out
    _e()._save()
    return out
