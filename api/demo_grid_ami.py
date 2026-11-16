"""Demo Grid, fase 5 sesi 1: AMI streaming — fictional smart meters publish over MQTT into the platform's broker, a
streaming sync lands them in an ingest stream, a streaming pipeline cleans them into a time series (called by
demo_grid_e2e.build, step "ami"; mounted by server.py under /api/demo/grid/ami).

  simulator (thread in the API, fictional)  →  MQTT Broker (Mosquitto, login demo-grid-ami-sim, publish only)
    topic spBv1.0/GridDemo/DDATA/<head-end>/<meter>: the Sparkplug B topic namespace; the payload is JSON (the
    head-end gateway transcodes Sparkplug's protobuf metrics), one 15-minute interval per message
  →  streaming sync "Sync AMI head-end MQTT grid (demo)" (login demo-grid-ami-sync, subscribe only, QoS 1)
  →  ingest stream "ami_meter_15menit (demo)" (archived every 15 minutes into raw/iot/ami)
  →  "Pipeline AMI streaming grid (demo)" (streaming job): validated readings → time series sync "Beban AMI pelanggan
     15 menit (demo)" (kW per meter), the stream ami_bersih and the meter events ami_peristiwa (for the hourly NTL
     scoring of session 5.2)
  →  Nexus "Grid AMI Meter (demo)": a sensor object type of Pelanggan (series id seri_ami), rows per ULP like Pelanggan.

The pilot: every TM customer and the AMI customers of three distribution transformers. Readings follow the customers'
load profiles (demo_grid_iot.shape) and the planted patterns active now (a bypass or magnet meters less than flows); three
new events start inside the first 48 hours (a bypass, a magnet, a shunted CT phase) for the streaming detection of
session 5.2 — their truth stays in the demo state, never in the stream. On start the simulator back-fills 48 hours, then
publishes every 15 minutes; after an API restart it forwards what it missed (store and forward, at most 48 hours).
Read-only towards SCADA: nothing here controls anything. Everything is fictional and titled "(demo)".
"""

from __future__ import annotations

import json
import logging
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import auth

log = logging.getLogger("bluesandai.demo_grid_ami")
router = APIRouter(prefix="/api/demo/grid/ami")

TOPIC_ROOT = "spBv1.0/GridDemo"
SIM_USER = "demo-grid-ami-sim"
SYNC_USER = "demo-grid-ami-sync"
PILOT_DT = ["DT-K05-05", "DT-K06-01", "DT-K06-05"]
HEAD_END = {"TR": "HE-AMI-DEMO-01", "TM": "HE-AMR-TM-DEMO-01"}
STREAM = "ami_meter_15menit (demo)"
SYNC = "Sync AMI head-end MQTT grid (demo)"
PIPELINE = "Pipeline AMI streaming grid (demo)"
VERSION = 2  # bump to regenerate the pipeline file from the spec (v2: the preview sample holds meter events)
TS_OUT = "Beban AMI pelanggan 15 menit (demo)"
TYPE = ("Grid AMI Meter (demo)", "MeterAmiGridDemo", "no_meter", "judul")
LINK = "Customer AMI meter (grid demo)"
REGISTER = "register_meter_ami_pilot"
ARCHIVE = "ami_meter_15menit_arsip"
INTERVAL_S = 900
BACKFILL_H = 48
WIB = timezone(timedelta(hours=7))
# patterns that make the meter record less than flows (a bypass, a magnet, a shunted CT phase, a CT ratio change, a
# direct connection); the others are billing or reading frauds (the AMI meter itself reads right) or legitimate changes
METER_LOSS = {"NTL-01", "NTL-02", "NTL-07", "NTL-08", "NTL-14"}
LEGIT = {"X-01", "X-02", "X-03", "X-05"}

SCHEMA = [("ts", "Long"), ("seq", "Long"), ("head_end", "String"), ("meter", "String"), ("id_pelanggan", "String"), ("interval_menit", "Integer"),
          ("kwh", "Double"), ("kw", "Double"), ("kvarh", "Double"), ("pf", "Double"), ("v_l1", "Double"), ("v_l2", "Double"), ("v_l3", "Double"),
          ("i_l1", "Double"), ("i_l2", "Double"), ("i_l3", "Double"), ("event", "String"), ("kualitas", "String")]

SQL_BERSIH = """-- Bacaan AMI 15 menit yang valid: kualitas bukan BAD, kWh tidak negatif; waktu UTC (seri waktu) dan WIB; seri = meter.
-- Rasio arus fasa (pelanggan TM, 3 fasa): arus fasa terkecil / terbesar — mendekati 0 bila satu CT di-shunt.
SELECT 'ami:' || meter AS seri_ami, meter AS no_meter, id_pelanggan, head_end,
       strftime('%Y-%m-%dT%H:%M:%SZ', ts / 1000, 'unixepoch') AS waktu_utc,
       strftime('%Y-%m-%d %H:%M', ts / 1000 + 25200, 'unixepoch') AS waktu_wib,
       ts, kwh, kw, pf, v_l1, i_l1, i_l2, i_l3,
       CASE WHEN i_l2 IS NULL OR MAX(i_l1, i_l2, i_l3) <= 0 THEN NULL
            ELSE ROUND(MIN(i_l1, i_l2, i_l3) / MAX(i_l1, i_l2, i_l3), 3) END AS rasio_arus_fasa,
       event, kualitas
FROM input
WHERE kualitas <> 'BAD' AND kwh >= 0"""

SQL_SERI = """-- Seri waktu daya per meter (kW, 15 menit) untuk Time Series Catalog → objek Meter AMI.
SELECT seri_ami, waktu_utc, kw FROM input"""

SQL_PERISTIWA = """-- Peristiwa meter (buka tutup, magnet, sag tegangan, ...) dan ketidakseimbangan arus fasa TM: masukan deteksi per jam (sesi 5.2).
SELECT no_meter, id_pelanggan, waktu_utc, waktu_wib,
       CASE WHEN event <> '' THEN event ELSE 'arus_fasa_timpang' END AS peristiwa, rasio_arus_fasa, kw
FROM input
WHERE event <> '' OR (rasio_arus_fasa IS NOT NULL AND rasio_arus_fasa < 0.2)"""

_lock = threading.RLock()
_sim: dict[str, Any] = {"thread": None, "stop": None, "client": None, "error": None, "last_batch": None}


def _e():
    import demo_grid_e2e as e

    return e


def _st() -> dict:
    return _e().STATE.setdefault("ami", {})


# ------------------------------------------------------------------------------------------------
# the pilot's meters and their readings (deterministic: the same interval always reads the same)
# ------------------------------------------------------------------------------------------------

_cache: dict[str, Any] = {}


def meters() -> list[dict]:
    """The pilot's meters with what the simulator needs (profiles and the patterns stay internal)."""
    if "meters" in _cache:
        return _cache["meters"]
    import demo_grid_data as gd

    cs = gd.customers()
    plant = gd.plant()["pelanggan"]
    pats: dict[str, list[tuple[str, dict]]] = {}
    for code, lst in plant.items():
        for x in lst:
            pats.setdefault(x["id_pelanggan"], []).append((code, x))
    out = []
    for c in cs:
        if not (c["tegangan"] == "TM" or (c["ami"] and c["kode_dt"] in PILOT_DT)):
            continue
        out.append({"no_meter": c["no_meter"], "id_pelanggan": c["id_pelanggan"], "tegangan": c["tegangan"], "fase": c["fase"], "profil": c["profil"],
                    "base_kwh": c["base_kwh"], "kode_dt": c["kode_dt"], "kode_penyulang": c["kode_penyulang"], "kode_ulp": c["kode_ulp"],
                    "tarif": c["tarif"], "daya_va": c["daya_va"], "head_end": HEAD_END[c["tegangan"]], "pola": pats.get(c["id_pelanggan"], [])})
    _cache["meters"] = out
    return out


def planted(t0: int) -> list[dict]:
    """Three new events inside the first 48 hours of the stream (truth for session 5.2, never published)."""
    ms = meters()
    clean = [m for m in ms if not m["pola"]]
    pick = lambda cond: next(m for m in sorted(clean, key=lambda m: m["no_meter"]) if cond(m))  # noqa: E731
    e1 = pick(lambda m: m["kode_dt"] == "DT-K05-05" and m["tarif"].startswith(("R", "B")) and m["daya_va"] >= 1300)
    e2 = pick(lambda m: m["kode_dt"] == "DT-K06-01" and m["tarif"].startswith(("R", "B")) and m["daya_va"] >= 900)
    e3 = pick(lambda m: m["tegangan"] == "TM" and m["profil"].startswith("industri"))
    return [{"id": "AMI-E1", "no_meter": e1["no_meter"], "id_pelanggan": e1["id_pelanggan"], "pola": "NTL-01", "uraian": "Bypass meter (demo)",
             "mulai": t0 - 18 * 3600, "porsi": 0.85},
            {"id": "AMI-E2", "no_meter": e2["no_meter"], "id_pelanggan": e2["id_pelanggan"], "pola": "NTL-02", "uraian": "Magnet pada meter (demo)",
             "mulai": t0 - 9 * 3600, "porsi": 0.5},
            {"id": "AMI-E3", "no_meter": e3["no_meter"], "id_pelanggan": e3["id_pelanggan"], "pola": "NTL-07", "uraian": "Shunt CT fasa L2 (demo)",
             "mulai": t0 - 30 * 3600, "porsi": 1 / 3}]


def reading(m: dict, t_end: int, events: list[dict], seq: int) -> Optional[dict]:
    """One 15-minute interval ending at t_end (epoch seconds, UTC) as the meter reports it; None = lost in transit."""
    import demo_grid_data as gd
    import demo_grid_iot as gi

    rnd = random.Random(f"ami:{m['no_meter']}:{t_end}")
    if rnd.random() < 0.003:
        return None  # a reading the head-end never got (a gap, as AMI has)
    wib = datetime.fromtimestamp(t_end - INTERVAL_S, WIB)
    d = wib.date()
    day = gd._day_factor(m["profil"], d, random.Random(f"ami-day:{m['no_meter']}:{d}"))
    true_kwh = m["base_kwh"] * day * gi.shape(m["profil"], d.weekday())[wib.hour] / 4 * (1 + rnd.gauss(0, 0.07))
    loss, phase_lost, event = 0.0, None, ""
    for code, p in m["pola"]:
        if str(p.get("mulai") or "") > str(d):
            continue
        if code in LEGIT:
            true_kwh *= 1 - float(p.get("porsi") or 0)
        elif p.get("kali_beban") or p.get("lebih_daya"):
            true_kwh *= float(p.get("kali_beban") or p.get("lebih_daya"))
        elif code == "NTL-07":
            phase_lost = p.get("fasa") or "L1"
        elif code in METER_LOSS:
            loss = max(loss, float(p.get("porsi") or 0))
            if code == "NTL-02" and rnd.random() < 0.12:
                event = "magnet"
    for ev in events:
        if ev["no_meter"] != m["no_meter"] or t_end <= ev["mulai"]:
            continue
        if ev["pola"] == "NTL-07":
            phase_lost = "L2"
        else:
            loss = max(loss, ev["porsi"])
            if ev["pola"] == "NTL-01" and t_end - ev["mulai"] <= INTERVAL_S:
                event = "cover_open"  # the terminal cover opened when the bypass went in
            if ev["pola"] == "NTL-02" and rnd.random() < 0.15:
                event = "magnet"
    true_kwh = max(0.0, true_kwh)
    pf = round(min(0.99, max(0.7, (0.9 if m["tegangan"] == "TM" else 0.88) + rnd.gauss(0, 0.025))), 3)
    kw_true = true_kwh * 4
    if m["tegangan"] == "TM":
        v = [round(11547 * (1 + rnd.gauss(0, 0.006)), 1) for _ in range(3)]
        ph = [max(0.0, kw_true * 1000 / 3 / (v[i] * pf) * (1 + rnd.gauss(0, 0.03))) for i in range(3)]
        if phase_lost:
            ph[int(phase_lost[-1]) - 1] *= 0.02  # the shunted CT: the meter sees almost no current on that phase
        metered = true_kwh * (2 / 3 + 0.02 / 3) if phase_lost else true_kwh  # the meter sums what its CTs see
        currents = [round(x, 2) for x in ph]
    else:
        v1 = round(229 - 7 * min(1.5, kw_true / max(0.45, m["daya_va"] / 1000)) + rnd.gauss(0, 1.5), 1)
        v = [v1, None, None]
        metered = true_kwh
        currents = [round(kw_true * 1000 * (1 - loss) / (v1 * pf), 2), None, None]
    metered *= 1 - loss
    if not event and rnd.random() < 0.002:
        event = "voltage_sag"
    return {"ts": t_end * 1000, "seq": seq, "head_end": m["head_end"], "meter": m["no_meter"], "id_pelanggan": m["id_pelanggan"], "interval_menit": 15,
            "kwh": round(metered, 4), "kw": round(metered * 4, 3), "kvarh": round(metered * ((1 / pf ** 2 - 1) ** 0.5), 4), "pf": pf,
            "v_l1": v[0], "v_l2": v[1], "v_l3": v[2], "i_l1": currents[0], "i_l2": currents[1], "i_l3": currents[2], "event": event,
            "kualitas": "ESTIMATED" if rnd.random() < 0.004 else "GOOD"}


# ------------------------------------------------------------------------------------------------
# the simulator: a thread of the API publishing to the broker
# ------------------------------------------------------------------------------------------------

def _sim_file():
    return _e().DIR / "ami_sim.json"


def _sim_state() -> dict:
    try:
        return json.loads(_sim_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _sim_save(st: dict) -> None:
    _sim_file().write_text(json.dumps(st, indent=1), encoding="utf-8")


def _secret() -> Optional[str]:
    try:
        return json.loads((_e().DIR / "ami_secret.json").read_text(encoding="utf-8")).get(SIM_USER)
    except (OSError, ValueError):
        return None


def _sync_status() -> Optional[str]:
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
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="demo-grid-ami-simulator", protocol=mqtt.MQTTv311)
    c.username_pw_set(SIM_USER, _secret())
    c.max_inflight_messages_set(500)
    c.max_queued_messages_set(0)
    c.connect("localhost", port, keepalive=60)
    c.loop_start()
    return c


def _publish_interval(c: Any, t_end: int, events: list[dict], st: dict) -> int:
    n = 0
    infos = []
    for m in meters():
        st["seq"] = int(st.get("seq") or 0) + 1
        r = reading(m, t_end, events, st["seq"])
        if r is None:
            continue
        infos.append(c.publish(f"{TOPIC_ROOT}/DDATA/{m['head_end']}/{m['no_meter']}", json.dumps(r), qos=1))
        n += 1
    for i in infos:
        i.wait_for_publish(timeout=30)
    return n


PACE_S = 2.5  # between intervals sent late: the sync drains ~150 messages/s and the broker queues only 10,000 per client


def _received(stream_id: str, since_ms: int) -> set[tuple[str, int]]:
    """(meter, interval end) already in the ingest stream."""
    import streaming as S

    out = set()
    with S._db() as con:
        for (rec,) in con.execute("SELECT record FROM records WHERE stream_id = ?", (stream_id,)):
            r = json.loads(rec)
            if int(r.get("ts") or 0) >= since_ms:
                out.add((str(r.get("meter")), int(r["ts"])))
    return out


def _fill_gaps(c: Any, st: dict, events: list[dict], stop: threading.Event) -> int:
    """Store and forward: re-send the readings of the last 48 hours the stream never got (a broker that dropped them)."""
    last = int(st.get("last_interval") or 0)
    if not last or not st.get("stream_id"):
        return 0
    first = max(int(st.get("t0") or last) - BACKFILL_H * 3600, last - BACKFILL_H * 3600) + INTERVAL_S
    have = _received(st["stream_id"], first * 1000)
    sent, infos = 0, []
    for t in range(first, last + INTERVAL_S, INTERVAL_S):
        for m in meters():
            if stop.is_set():
                return sent
            if (m["no_meter"], t * 1000) in have:
                continue
            st["seq"] = int(st.get("seq") or 0) + 1
            r = reading(m, t, events, st["seq"])
            if r is None:
                continue
            infos.append(c.publish(f"{TOPIC_ROOT}/DDATA/{m['head_end']}/{m['no_meter']}", json.dumps(r), qos=1))
            sent += 1
            if len(infos) >= 300:
                for i in infos:
                    i.wait_for_publish(timeout=30)
                infos = []
                stop.wait(PACE_S)
    for i in infos:
        i.wait_for_publish(timeout=30)
    st["resent"] = int(st.get("resent") or 0) + sent
    return sent


def _run(stop: threading.Event) -> None:
    st = _sim_state()
    # wait (up to 2 minutes) for the streaming sync: the broker queues only so much for a sync that is not connected
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
                for he in HEAD_END.values():  # the edge node's birth certificate (Sparkplug NBIRTH)
                    c.publish(f"{TOPIC_ROOT}/NBIRTH/{he}", json.dumps({"timestamp": int(time.time() * 1000), "bdSeq": int(st.get("bdseq") or 0),
                                                                     "metrics": [{"name": "meters", "value": sum(m["head_end"] == he for m in meters())}]}), qos=1)
                st["bdseq"] = int(st.get("bdseq") or 0) + 1
            now = int(time.time()) // INTERVAL_S * INTERVAL_S
            t0 = int(st.get("t0") or now)
            st.setdefault("t0", t0)
            events = st.get("events") or planted(t0)
            st["events"] = events
            if not _sim.get("filled"):
                n = _fill_gaps(c, st, events, stop)
                _sim["filled"] = True
                _sim["last_fill"] = {"resent": n, "at": datetime.now(timezone.utc).isoformat()}
                _sim_save(st)
            last = int(st.get("last_interval") or (now - BACKFILL_H * 3600))
            last = max(last, now - BACKFILL_H * 3600)  # store and forward: at most 48 hours
            fresh = _sim_state().get("events")  # injected events (session 5.2) apply without a simulator restart
            if fresh and fresh != events:
                events = fresh
            while last + INTERVAL_S <= now and not stop.is_set():
                last += INTERVAL_S
                n = _publish_interval(c, last, events, st)
                st.update(last_interval=last, published=int(st.get("published") or 0) + n, updated_at=datetime.now(timezone.utc).isoformat())
                _sim["last_batch"] = {"interval_end": datetime.fromtimestamp(last, timezone.utc).isoformat(), "messages": n}
                _sim_save(st)
                if last + INTERVAL_S <= now:
                    stop.wait(PACE_S)  # catching up: no faster than the sync drains
            _sim["error"] = None
            stop.wait(max(2, now + INTERVAL_S - time.time() + 5))
        except Exception as ex:  # noqa: BLE001
            _sim["error"] = str(ex)[:300]
            log.warning("demo grid AMI simulator: %s", ex)
            try:
                if c is not None:
                    c.loop_stop()
                    c.disconnect()
            except Exception:  # noqa: BLE001
                pass
            c = None
            stop.wait(30)
    if c is not None:
        c.loop_stop()
        c.disconnect()


def sim_start() -> dict:
    """Start the simulator and its streaming sync (in the API process); idempotent."""
    import streaming as S

    with _lock:
        st = _sim_state()
        sid = st.get("sync_id")
        if not sid or not _secret():
            raise HTTPException(409, "Bangun dulu langkah AMI (POST /api/demo/grid/e2e): broker, login dan sync belum ada")
        if _sync_status() != "running":
            S._start(sid)  # acts as the sync's owner (who created it), not as the caller
        st["enabled"] = True
        _sim_save(st)
        t = _sim.get("thread")
        if not (t and t.is_alive()):
            stop = threading.Event()
            _sim["filled"] = False
            t = threading.Thread(target=_run, args=(stop,), daemon=True, name="demo-grid-ami-sim")
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
    return {"enabled": bool(st.get("enabled")), "running": bool(t and t.is_alive()), "meters": len(meters()), "published": st.get("published") or 0,
            "last_interval": datetime.fromtimestamp(st["last_interval"], timezone.utc).isoformat() if st.get("last_interval") else None,
            "started": datetime.fromtimestamp(st["t0"], timezone.utc).isoformat() if st.get("t0") else None,
            "resent": st.get("resent") or 0, "last_fill": _sim.get("last_fill"), "error": _sim.get("error"), "sync_status": _sync_status()}


@router.on_event("startup")
def _resume() -> None:
    """After an API restart: the simulator picks up where it stopped (the sync resumes by itself)."""
    def run() -> None:
        try:
            time.sleep(20)  # the broker's and the syncs' own startup first
            if _sim_state().get("enabled"):
                sim_start()
        except Exception as ex:  # noqa: BLE001
            _sim["error"] = str(ex)[:300]
            log.warning("demo grid AMI simulator did not resume: %s", ex)

    threading.Thread(target=run, daemon=True, name="demo-grid-ami-resume").start()


# ------------------------------------------------------------------------------------------------
# the build step (in-process, as the demo's owner)
# ------------------------------------------------------------------------------------------------

def _credentials() -> dict:
    """Two broker logins: the simulator publishes, the sync subscribes. A missing password is reissued."""
    import mqtt_broker as mb

    out = {}
    secret_file = _e().DIR / "ami_secret.json"
    try:
        secrets = json.loads(secret_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        secrets = {}
    for user, access, label in ((SIM_USER, "write", "Demo: simulator meter AMI grid (fiktif), hanya publish"),
                                (SYNC_USER, "read", "Demo: streaming sync AMI grid, hanya subscribe")):
        have = next((c for c in mb._creds() if c["username"] == user), None)
        if have and secrets.get(user):
            out[user] = have["id"]
            continue
        if have:
            mb.delete_credential(have["id"])
        r = mb.create_credential(mb.CredentialIn(username=user, label=label, topics=[mb.TopicIn(pattern=f"{TOPIC_ROOT}/#", access=access)]))
        secrets[user] = r["password"]
        out[user] = r["id"]
        out[f"{user}_new"] = True
    secret_file.write_text(json.dumps(secrets), encoding="utf-8")
    return out


def _register_rows() -> list[dict]:
    rows = []
    for m in meters():
        rows.append({"no_meter": m["no_meter"], "judul": f"Meter {m['no_meter']} · {m['kode_dt'] or m['kode_penyulang']}", "id_pelanggan": m["id_pelanggan"],
                     "kode_dt": m["kode_dt"], "kode_penyulang": m["kode_penyulang"], "kode_ulp": m["kode_ulp"], "tegangan": m["tegangan"], "fase": m["fase"],
                     "head_end": m["head_end"], "jenis_meter": "AMR TM 3 fasa (demo)" if m["tegangan"] == "TM" else "AMI TR (demo)",
                     "interval_menit": 15, "protokol": "MQTT · Sparkplug B (namespace), payload JSON", "seri_ami": f"ami:{m['no_meter']}",
                     "nama_sensor": "Beban AMI 15 menit", "satuan": "kW"})
    return rows


def _content(stream_id: str, sample: list[dict], folder: str, project: str, uid) -> tuple[dict, dict]:
    import demo_jkn_pipeline as base

    now = datetime.now(timezone.utc).isoformat()
    nodes = [
        {"id": "s_ami", "kind": "source", "name": "ami_meter_15menit", "x": 0, "y": 160, "color": "lg-ami"},
        {"id": "t_bersih", "kind": "transform", "name": "ami_bersih", "input": "s_ami", "x": 340, "y": 160, "color": "lg-bersih",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_BERSIH}}]},
        {"id": "t_seri", "kind": "transform", "name": "seri_beban_ami", "input": "t_bersih", "x": 680, "y": 40, "color": "lg-seri",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_SERI}}]},
        {"id": "t_peristiwa", "kind": "transform", "name": "ami_peristiwa", "input": "t_bersih", "x": 680, "y": 300, "color": "lg-seri",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_PERISTIWA}}]},
    ]
    nodes[0]["datasetId"] = "ds_ami"
    nodes[0]["description"] = "Ingest stream dari streaming sync MQTT (head-end AMI/AMR, topik spBv1.0/GridDemo/DDATA/#)"
    datasets = {"ds_ami": {"id": "ds_ami", "name": STREAM, "origin": f"Streaming · {STREAM}", "createdAt": now, "refreshedAt": now,
                           "columns": [{"name": c, "type": t} for c, t in SCHEMA], "rows": sample[:50], "ref": {"kind": "ingest", "streamId": stream_id}}}
    location = {"id": folder, "name": f"{project} / iot / ami"}
    outs = {"ami_bersih": "o_bersih", "ami_peristiwa": "o_peristiwa", TS_OUT: "o_seri"}
    outputs = [
        {"id": "o_bersih", "name": "ami_bersih", "node": "t_bersih", "kind": "dataset", "columns": None, "writeMode": "default", "location": location, "x": 1020, "y": 160},
        {"id": "o_peristiwa", "name": "ami_peristiwa", "node": "t_peristiwa", "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
         "x": 1020, "y": 300},
        {"id": "o_seri", "name": TS_OUT, "node": "t_seri", "kind": "timeSeries", "timeSeries": {"seriesId": "seri_ami", "timestamp": "waktu_utc", "value": "kw"},
         "columns": None, "writeMode": "default", "location": location, "x": 1020, "y": 40},
    ]
    body = {"type": "streaming", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes, "outputs": outputs,
            "legend": [{"id": "lg-ami", "name": "AMI head-end (MQTT)", "hex": "#2c9c9c"}, {"id": "lg-bersih", "name": "Validasi", "hex": "#0ea5e9"},
                       {"id": "lg-seri", "name": "Seri & peristiwa", "hex": "#6b46c1"}],
            "location": location,
            "buildSettings": {"streamingProfile": "xs", "maxDurationMinutes": None},
            "textNodes": [{"id": "note_ami", "x": 0, "y": -120, "w": 1000, "h": 110, "color": "lg-ami",
                           "text": "Streaming: meter AMI/AMR fiktif → MQTT Broker (topik Sparkplug B) → streaming sync → ingest stream → validasi → seri waktu kW "
                                   "per meter (objek Meter AMI) + stream bersih dan peristiwa untuk skor NTL per jam (sesi 5.2). Tidak ada jalur balik ke SCADA."}],
            "meta": {"version": VERSION, "description": "Demo: AMI streaming — bacaan 15 menit meter pilot dari MQTT ke time series."}}
    base.schema_of  # noqa: B018  (the same helpers as the batch pipelines)
    return body, outs


def emulate(rows: list[dict]) -> dict[str, list[dict]]:
    """The pipeline's SQL over sample readings in sqlite (as the batch demos check their specs)."""
    import demo_jkn_pipeline as base

    nodes = [{"id": "s_ami", "kind": "source", "name": "ami_meter_15menit"},
             {"id": "t_bersih", "kind": "sql", "name": "ami_bersih", "input": "s_ami", "sql": SQL_BERSIH},
             {"id": "t_seri", "kind": "sql", "name": "seri_beban_ami", "input": "t_bersih", "sql": SQL_SERI},
             {"id": "t_peristiwa", "kind": "sql", "name": "ami_peristiwa", "input": "t_bersih", "sql": SQL_PERISTIWA}]
    return base.run({"ami_meter_15menit": rows}, nodes)


def _meter_type(register_id: str) -> dict:
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
        props = [e._prop(c, e.PTYPE[ty], "pelanggan") for c, ty in base.schema_of(rows)]
        for p in props:
            if p["api_name"] == pk:
                p["render_hints"] = sorted(set(p.get("render_hints") or []) | {"identifier", "searchable"})
            p["display_name"] = {"no_meter": "No. meter", "seri_ami": "Seri beban AMI", "head_end": "Head-end", "nama_sensor": "Nama sensor"}.get(
                p["api_name"], p["display_name"])
        t = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=name, plural_name=name, api_name=api, primary_key=pk, title_property=title, icon="activity", color="#2c9c9c",
            description="Demo: meter AMI/AMR pilot (fiktif) — bacaan 15 menit lewat MQTT dan streaming; sensor dari Pelanggan, seri beban kW.",
            properties=[ontology.Property(**p) for p in props]))
        out["created"] = True
    if (ontology._object_type(t["id"]).get("backing_dataset") or {}).get("dataset_id") != register_id:
        ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=register_id, columns=None, map_unmapped=True))
    pl = e._type("pelanggan")
    if pl and LINK not in {x.get("display_name") for x in ontology._all("link-types")}:
        om.create_link_type(om.LinkTypeIn(display_name=LINK, kind="foreign_key", cardinality="many_to_one", foreign_key="id_pelanggan",
                                          source=om.LinkSide(object_type_id=t["id"], display_name="Meter AMI", plural_display_name="Meter AMI"),
                                          target=om.LinkSide(object_type_id=pl["id"], display_name="Pelanggan")))
        out["link"] = True
    groups = (e.STATE.get("akses") or {}).get("groups") or {}
    if groups.get("up3"):
        sec = ontology._object_type(t["id"]).get("security") or {}
        op = {**(sec.get("object_policy") or {"markings": []}), "granular": ak.policy([groups["up3"]])}
        if (sec.get("object_policy") or {}).get("granular") != op["granular"]:
            osec.set_security(t["id"], osec.SecurityIn(object_policy=op, property_policies=sec.get("property_policies") or []))
            out["policy"] = "per ULP (UP3 semua)"
    out["type_id"] = t["id"]
    return out


def _tsp(type_id: str) -> Optional[str]:
    """seri_ami becomes the sensor time series once the streaming job has registered its sync."""
    import ontology
    import timeseries
    import ts_ontology as tso

    import demo_grid_e2e as e

    s = next((x for x in timeseries.all_syncs("timeseries") if x.get("name") == TS_OUT), None)
    if not s:
        return None
    rec = ontology._object_type(type_id)
    if ((rec.get("time_series") or {}).get("properties") or {}).get("seri_ami"):
        return s["id"]
    pl = e._type("pelanggan")
    tso.add_tsp(type_id, tso.AddTsp(property="seri_ami", syncs=[s["id"]], unit=tso.Formatting(value="kW"), interpolation=tso.Formatting(value="LINEAR"),
                                    make_default=True, sensor=tso.SensorConfig(links=[tso.SensorLink(root_object_type_id=pl["id"], foreign_key="id_pelanggan",
                                                                                                     sensor_name_property="nama_sensor")])))
    return s["id"]


def build(state: dict, save) -> dict:
    import uuid

    import drive
    import mqtt_broker as mb
    import pipeline_datasets
    import pipeline_runtime as rt
    import stream_datasets
    import streaming as S

    e = _e()
    st = state.setdefault("ami", {})
    out: dict[str, Any] = {}
    project = e._folder(None, e.PROJECT, "project")
    raw_folder = e._folder(e._folder(e._folder(project, "raw"), "iot"), "ami")
    folder = e._folder(e._folder(project, "iot"), "ami")
    if not mb.running():
        mb.start()
    out["broker"] = mb._state().get("ports")
    out["logins"] = _credentials()
    sim = _sim_state()
    # the meter register (no identity: meter, customer id, network place)
    reg = e._put(folder, REGISTER, _register_rows())
    st["register_id"] = reg
    # the ingest stream (typed) and the streaming sync (created stopped: it runs in the API, started with the simulator)
    port = int((mb._state().get("ports") or {}).get("mqtt") or 1883)
    secrets = json.loads((e.DIR / "ami_secret.json").read_text(encoding="utf-8"))
    sid = st.get("sync_id")
    if sid:
        try:
            rec, _, _ = S._sync_row(sid)
        except HTTPException:
            sid = None
    if sid and out["logins"].get(f"{SYNC_USER}_new"):
        S._stop(sid)
        S.delete_sync(sid)
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
                                                    keys=S.KeysIn(partition=["meter"])))["id"]
        rec = S.create_sync(S.SyncIn(name=SYNC, kind="mqtt", stream_id=stream_id, project_id=project, start=False, profiles=["default"],
                                     config={"host": "localhost", "port": port, "topics": f"{TOPIC_ROOT}/DDATA/#", "user": SYNC_USER,
                                             "password": secrets[SYNC_USER], "qos": 1, "client_id": "bsai-demo-grid-ami", "value_format": "json"}))
        sid = rec["id"]
        st.update(sync_id=sid, stream_id=stream_id)
        save()
    out["sync_id"], out["stream_id"] = sid, st["stream_id"]
    sim.update(sync_id=sid, stream_id=st["stream_id"])
    _sim_save(sim)
    try:
        if not stream_datasets._archive(st["stream_id"]):
            stream_datasets.set_archive(st["stream_id"], stream_datasets.ArchiveIn(folder_id=raw_folder, every_minutes=15, name=ARCHIVE))
        out["archive"] = True
    except Exception as ex:  # noqa: BLE001
        out["archive"] = f"belum: {getattr(ex, 'detail', ex)}"
    # the streaming pipeline
    t0 = int(time.time()) // INTERVAL_S * INTERVAL_S
    # the preview sample: ordinary readings and some with meter events or a shunted CT phase (so every node shows rows)
    allr = [r for r in (reading(m, t0 - k * INTERVAL_S, planted(t0), i) for k in range(4) for i, m in enumerate(meters())) if r]
    odd = [r for r in allr if r["event"] or (r["i_l2"] is not None and min(r["i_l1"], r["i_l2"], r["i_l3"]) < 0.2 * max(r["i_l1"], r["i_l2"], r["i_l3"], 1e-9))]
    sample = allr[:40] + odd[:10]
    em = emulate(sample)
    out["emulasi"] = {k: len(v) for k, v in em.items()}
    pid = st.get("pipeline_id")
    current = None
    if pid:
        try:
            current = json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(pid)))
        except Exception:  # noqa: BLE001
            current, pid = None, None
    if not pid or (current.get("meta") or {}).get("version") != VERSION:
        body, _ = _content(st["stream_id"], sample, folder, e.PROJECT, lambda: uuid.uuid4().hex[:8])
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
        st["build_id"] = b["id"]
        st["deploy_needed"] = False
        save()
        out["deployed"] = b["id"]
    else:
        out["job"] = running[0]["id"]
    mt = _meter_type(reg)
    st["type_id"] = mt["type_id"]
    out["nexus"] = mt
    out["tsp_sync"] = _tsp(mt["type_id"])
    st["ts_sync_id"] = out["tsp_sync"]
    save()
    return out


# ------------------------------------------------------------------------------------------------
# the page's section: GET /api/demo/grid/ami
# ------------------------------------------------------------------------------------------------

def _count(con: Any, sql: str, *args: Any) -> Any:
    try:
        return con.execute(sql, args).fetchone()
    except Exception:  # noqa: BLE001
        return None


@router.get("")
def overview() -> dict:
    """The AMI chain live: broker, simulator, sync, stream, streaming job, time series; the pilot's load (Project readers)."""
    import mqtt_broker as mb
    import pipeline_runtime as rt
    import streaming as S
    import timeseries

    auth.require_user()
    e = _e()
    st = e.STATE.get("ami") or {}
    out: dict[str, Any] = {"built": bool(st.get("pipeline_id")), "pipeline_id": st.get("pipeline_id"), "type_id": st.get("type_id"),
                           "simulator": sim_status(), "pilot": {"meter": len(meters()), "gardu": PILOT_DT,
                                                                 "tm": sum(m["tegangan"] == "TM" for m in meters())},
                           "topik": f"{TOPIC_ROOT}/DDATA/<head-end>/<meter>", "head_end": list(HEAD_END.values())}
    try:
        b = mb.status_public()
        sm = b.get("summary") or {}
        out["broker"] = {"running": b.get("status") == "running", "clients": sm.get("clients"), "messages_per_min": sm.get("messages_last_minute"),
                         "address": (b.get("addresses") or {}).get("this_machine")}
    except Exception as ex:  # noqa: BLE001
        out["broker"] = {"running": False, "error": str(ex)[:120]}
    sid, stream_id = st.get("sync_id"), st.get("stream_id")
    if sid:
        with S._db() as con:
            row = _count(con, "SELECT record FROM syncs WHERE id = ?", sid)
            n = _count(con, "SELECT SUM(records) FROM metrics WHERE sync_id = ?", sid)
        rec = json.loads(row[0]) if row else {}
        out["sync"] = {"id": sid, "name": rec.get("name"), "status": rec.get("status"), "error": rec.get("error"), "records": (n or [None])[0]}
    if stream_id:
        with S._db() as con:
            n = _count(con, "SELECT COUNT(*), MAX(at) FROM records WHERE stream_id = ?", stream_id)
        out["stream"] = {"id": stream_id, "name": STREAM, "records": n[0] if n else None, "last_at": n[1] if n else None}
    if st.get("pipeline_id"):
        bs = rt._builds(st["pipeline_id"], 5)
        if bs:
            b = bs[0]
            out["job"] = {"id": b["id"], "status": b["status"], "started_at": b.get("started_at"),
                          "records": next((m for m in reversed(b.get("logs") or []) if "records processed" in (m.get("msg") or "")), {}).get("msg")}
    s = next((x for x in timeseries.all_syncs("timeseries") if x.get("name") == TS_OUT), None)
    if s:
        out["series"] = {"sync_id": s["id"], "points": s.get("points_total"), "last_write_at": s.get("last_write_at")}
        project = e.STATE.get("project_id")
        if project and auth.role_for(project):
            out["beban_pilot"] = _pilot_load(s["id"])
    out["kejadian_tertanam"] = len(_sim_state().get("events") or [])
    return out


def overview_numbers() -> dict:
    """Counts only (the architecture page's blocks)."""
    import streaming as S
    import timeseries

    st = _e().STATE.get("ami") or {}
    sim = sim_status()
    out = {"meters": sim["meters"], "published": sim["published"], "sync_status": sim["sync_status"]}
    if st.get("stream_id"):
        with S._db() as con:
            n = _count(con, "SELECT COUNT(*) FROM records WHERE stream_id = ?", st["stream_id"])
        out["stream_records"] = n[0] if n else None
    s = next((x for x in timeseries.all_syncs("timeseries") if x.get("name") == TS_OUT), None)
    out["points"] = (s or {}).get("points_total")
    return out


def _pilot_load(sync_id: str) -> list[dict]:
    """Total kW of the pilot per 15 minutes over the last 48 hours (TR and TM apart)."""
    import timeseries

    since = (datetime.now(timezone.utc) - timedelta(hours=BACKFILL_H)).isoformat()
    tm = {f"ami:{m['no_meter']}" for m in meters() if m["tegangan"] == "TM"}
    agg: dict[str, dict] = {}
    with timeseries._db() as con:
        for series, ts, v in con.execute("SELECT series_id, ts, value FROM points WHERE sync_id = ? AND ts >= ?", (sync_id, since)):
            a = agg.setdefault(ts[:16], {"t": ts[:16], "tr": 0.0, "tm": 0.0})
            a["tm" if series in tm else "tr"] += float(v or 0)
    return [{"t": a["t"], "tr": round(a["tr"], 1), "tm": round(a["tm"], 1)} for a in sorted(agg.values(), key=lambda a: a["t"])]


class SimIn(BaseModel):
    enabled: bool


@router.post("/simulator")
def set_simulator(req: SimIn) -> dict:
    """Start or stop the meter simulator (administrators and Owners of the demo's Project)."""
    e = _e()
    project = e.STATE.get("project_id")
    p = auth.current()
    if auth.enabled() and not (p and (auth._is_admin(p) or p.get("service") or (project and auth.role_for(project, p) == "owner"))):
        raise HTTPException(403, "Hanya administrator atau Owner Project demo yang dapat menyalakan simulator")
    return sim_start() if req.enabled else sim_stop()
