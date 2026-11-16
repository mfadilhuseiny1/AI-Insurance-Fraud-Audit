"""The realtime engine: a queue of arriving events, one worker that judges them in micro-batches, in arrival order.

Three kinds of event (each with its own contract): an FKRTL claim (aip/layanan.KlaimIn), an FKTP visit and a
non-capitation claim (kontrak.py). Per micro-batch:
  1 versions     an FKRTL claim id seen before is a resubmission (a hospital's amendment): its earlier version leaves
                 the graph and the stream history, so it is never its own duplicate
  2 members      the batch's members from the registry (referensi.anggota): sex, age, class entitlement, death year,
                 family — entity resolution of who each card belongs to
  3 model        FKRTL claims: the deployed production model's point-in-time features (aip/layanan.features) from the
                 feature store plus the stream's own history; the probability, the segment's threshold, the semantic
                 layer's claim rules; TreeSHAP reasons only for the claims that alert
  4 context      graf.Graf (the network, the member's own claims), aturan_rt (registry, code references, the hospital's
                 dispensing and result lines), rme (the claim against the hospital's SATUSEHAT medical record, when sent;
                 RME_* signals score, they are not model features), iot (the claim against the device sessions of a current-
                 clamp sensor, when sent; IOT_* signals, not model features either), fktp.FktpState (FKTP visits and non-capitation claims, each facility
                 against its own history); periodically the capitation units' contact rate
  5 decision     every signal's modes, tag and weight from modus.SIGNALS (a weight the case decisions recalibrated
                 overrides it: config "bobot"); score = 100·(1 − exp(−Σ w·s·(1 − m))); LOLOS / PERIKSA / TAHAN. The score
                 without the mitigation is kept beside it, so the context's effect is measured, not claimed
  6 cases        an alerted event joins the open case of its focus entity (facility, member or ring)
  7 integration  integrasi.write_tags: every alert a tag in the indikasi ledger at once; Box Karantina rebuilt from
                 the tags a while after a burst (debounced)

The worker acts as the engine's owner (the admin who switched it on; run_as.as_owner), never as the system. What the
graph and the facility state hold is restored from the stored events when the engine warms up again (a restart).
"""

from __future__ import annotations

import collections
import contextvars
import json
import logging
import math
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException

from aip.realtime import graf as G
from aip.realtime import modus as MO
from aip.realtime.store import Store, data_dir

log = logging.getLogger("aip.realtime")

REPLAY_EDISI = "reguler"
REPLAY_DAYS = 14
BATCH = 300
QUEUE_MAX = 30_000
BOX_DELAY = 120  # seconds after a burst of tags before Box Karantina is rebuilt
KEEP_CASE_EVENTS = 300
SEV3 = "Berat (rawat inap keparahan 3)"
DEFAULTS = {"aktif": False, "pemilik": None, "ambang_periksa": 45.0, "ambang_tahan": 75.0, "tulis_tag": True, "box_otomatis": True, "bobot": {},
            # the active-learning champion: "bayangan" records its probability on every event, "aktif" decides with it, "mati" off;
            # in "aktif" PERIKSA from 15 % and TAHAN from 50 % probability on the stream's scale (after the prior correction)
            "al_mode": "bayangan", "al_ambang_periksa": 0.3, "al_ambang_tahan": 0.7}
DECISIONS = ("LOLOS", "PERIKSA", "TAHAN")
JENIS = ("fkrtl", "fktp", "nonkap", "faskes")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read(name: str, default: Any) -> Any:
    try:
        return json.loads((data_dir() / name).read_text("utf-8"))
    except (OSError, ValueError):
        return default


def _write(name: str, data: Any) -> None:
    from aip.runs import _write as atomic

    atomic(data_dir() / name, data)


def config() -> dict:
    return {**DEFAULTS, **_read("konfigurasi.json", {})}


def set_config(**kv: Any) -> dict:
    cfg = {**config(), **kv}
    _write("konfigurasi.json", cfg)
    return cfg


def pct(values: list[float], q: float) -> Optional[float]:
    if not values:
        return None
    v = sorted(values)
    return round(v[min(len(v) - 1, int(q * len(v)))], 1)


def _d(v: Any) -> Optional[date]:
    if v is None or isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def score(sigs: list[dict], weights: dict[str, float], th_p: float, th_t: float) -> tuple[float, float, str, str]:
    """Each signal's modes, tag and weight from the catalogue (a recalibrated weight overrides it), its contribution with
    and without its mitigation; the score, the score without mitigation and both decisions."""
    total = raw = 0.0
    for s in sigs:
        meta = MO.SIGNALS.get(s["kode"])
        if meta:
            s["modus"], s["tag"], base, s["label"] = meta[0], meta[1], meta[2], meta[3]
            s["w"] = float(weights.get(s["kode"], base))
        else:
            s.setdefault("modus", [])
        m = 1.0
        for x in s["mitigasi"]:
            m *= 1 - x["faktor"]
        s["kontribusi"] = round(s["w"] * s["s"] * m, 4)
        s["kontribusi_tanpa_mitigasi"] = round(s["w"] * s["s"], 4)
        total += s["kontribusi"]
        raw += s["kontribusi_tanpa_mitigasi"]
    sigs.sort(key=lambda s: -s["kontribusi"])
    sc, sr = round(100 * (1 - math.exp(-total)), 1), round(100 * (1 - math.exp(-raw)), 1)
    dec = "TAHAN" if sc >= th_t else "PERIKSA" if sc >= th_p else "LOLOS"
    dec_raw = "TAHAN" if sr >= th_t else "PERIKSA" if sr >= th_p else "LOLOS"
    return sc, sr, dec, dec_raw


class Engine:
    def __init__(self) -> None:
        # the store opens on first use: at import the platform's data folder is not configured yet (aip/vertex.configure)
        self._store: Optional[Store] = None
        self.lock = threading.RLock()
        self.cv = threading.Condition()
        self.q: collections.deque = collections.deque()
        self.thread: Optional[threading.Thread] = None
        self.stop_flag = False
        self.pk: Optional[dict] = None
        self.con: Any = None
        self.graf: Optional[G.Graf] = None
        self.fstate: Any = None
        self.ref: Any = None
        self.window: Optional[tuple[date, date]] = None
        self.known_codes: set[str] = set()
        self.code_ref: dict[str, dict] = {}
        self.tarif_ref: dict[str, int] = {}
        self.los_ref: dict[str, tuple[float, float]] = {}
        self.resolver: Any = None
        self.feed: collections.deque = collections.deque(maxlen=600)
        self.seq = 0
        self.done: dict[str, dict] = {}
        self.lat: collections.deque = collections.deque(maxlen=40_000)  # (t, ms, batch ms per event)
        self.decided: collections.deque = collections.deque(maxlen=100_000)  # (t, decision)
        self.counts: collections.Counter = collections.Counter()
        self.kinds: collections.Counter = collections.Counter()
        self.signals: collections.Counter = collections.Counter()
        self.modes: collections.Counter = collections.Counter()
        self.versions: dict[str, int] = {}
        # which claim each medical-record encounter was first billed by, per sending source (rme.dipakai_ulang). In memory:
        # after a restart an encounter billed before it is not remembered (the claim-level duplicate rules still apply)
        self.rme_enc: collections.OrderedDict = collections.OrderedDict()
        # each member's encounters from earlier claims' records (rme.jejak), for the stay-in-context rules (planned readmission,
        # readmission after an unstable discharge, the doctor across hospitals); and each device's bound sessions from earlier
        # claims (iot.py binding check). In memory, bounded, like rme_enc
        self.rme_riwayat: collections.OrderedDict = collections.OrderedDict()
        self.iot_sesi: collections.OrderedDict = collections.OrderedDict()
        self.cases: dict[str, dict] = {}
        self.open_case: dict[tuple, str] = {}
        self.sources: dict[str, dict] = {}
        self.integration = {"tag_ditulis": 0, "tag_baru": 0, "box_terakhir": None, "box_galat": None, "box_terjadwal": False}
        self.box_timer: Optional[threading.Timer] = None
        self.error: Optional[str] = None
        self.warm_info: dict = {}
        self.started_at: Optional[float] = None
        self.batches = 0
        self.failed = 0
        self.warming = False
        self.ssl: dict[str, Any] = {}  # the self-supervised models per event kind (ssl.py)
        self.ssl_mon: dict[str, list[int]] = {}  # per kind: events scored by the current model, above p99, above p99.9 (drift)
        self.al: Any = None  # the active-learning champion (aktif.py)
        self.sim_model: Any = None  # the best committee of the last learning-curve simulation (to promote)

    def set_ssl(self, kind: str, m: Any) -> None:
        """A newly trained SSL model takes over its kind; its drift count starts again."""
        with self.lock:
            if m is None:
                self.ssl.pop(kind, None)
            else:
                self.ssl[kind] = m
            self.ssl_mon[kind] = [0, 0, 0]

    def _ssl_count(self, e: dict) -> None:
        r = e.get("ssl")
        m = self.ssl.get(e.get("jenis", "fkrtl"))
        if not r or m is None or r.get("versi") != m.versi or r.get("err") is None:
            return
        c = self.ssl_mon.setdefault(e.get("jenis", "fkrtl"), [0, 0, 0])
        c[0] += 1
        c[1] += int(r["err"] > m.meta["ambang"]["p99"])
        c[2] += int(r["err"] > m.meta["ambang"]["p999"])

    def _ssl_signal(self, kind: str, rec: Optional[dict], f: str) -> Optional[dict]:
        """ANOMALI_SSL with the fields the network could not reconstruct (what this record has vs records like it)."""
        m = self.ssl.get(kind)
        if not rec or m is None:
            return None
        s = m.signal(rec["err"])
        if not s:
            return None
        from aip.realtime import ssl as SSL

        why = "; ".join(f"{a['label']} {a['nilai']} (pola serupa: {a['pola']})" for a in (rec.get("alasan") or [])[:2])
        return G.sig("ANOMALI_SSL", "", None, s, 0, ("faskes", f),
                     f"galat rekonstruksi {rec['err']:.3f} di atas p99,9 {SSL.NAMA[kind]} held-out ({m.meta['ambang']['p999']:.3f})".replace(".", ",")
                     + (f": {why}" if why else ": tidak mirip pola yang dipelajari model self-supervised"))

    def _ssl_pre(self, items: list[dict], members: dict) -> dict[str, dict]:
        """The FKTP visits and non-capitation claims of a batch through their SSL models at once (their inputs do not depend
        on the stream's state: the visit, the card holder and the facility's history before the window)."""
        import pandas as pd

        from aip.realtime import ssl as SSL

        out: dict[str, dict] = {}
        for kind in ("fktp", "nonkap"):
            m = self.ssl.get(kind)
            its = [it for it in items if it["jenis"] == kind]
            if m is None or not its:
                continue
            try:
                rows = []
                for it in its:
                    o = it["obj"]
                    mem = members.get((o.edisi, int(o.peserta_id))) or {}
                    rows.append({**o.model_dump(), "jk": mem.get("jk"), "tgl_lahir": mem.get("tgl_lahir"), "unit_terdaftar": mem.get("unit_terdaftar"),
                                 "segmen": mem.get("segmen")})
                df = pd.DataFrame(rows)
                base = SSL.base_fktp(df, self.ref) if kind == "fktp" else SSL.base_nonkap(df, self.ref)
                for it, rec in zip(its, m.score_events(base)):
                    out[it["id"]] = rec
            except Exception:  # noqa: BLE001 - scored without it
                log.exception("realtime: ssl %s", kind)
        return out

    @property
    def store(self) -> Store:
        if self._store is None:
            with self.lock:
                if self._store is None:
                    st = Store()
                    self._store = st
                    self._load_cases()
        return self._store

    # -------------------------------------------------------------------------------------------------
    # life cycle
    # -------------------------------------------------------------------------------------------------
    def _load_cases(self) -> None:
        self.cases = self._store.cases()
        self.open_case = {(c["jenis"], c["kunci"]): c["id"] for c in self.cases.values() if c["status"] in ("baru", "ditelaah")}
        for r in self._store.rows("SELECT klaim, max(json_extract(rec, '$.versi')) FROM peristiwa GROUP BY klaim"):
            self.versions[r[0]] = int(r[1] or 1)
        self.seq = (self._store.rows("SELECT coalesce(max(seq), 0) FROM peristiwa") or [(0,)])[0][0]

    def running(self) -> bool:
        return bool(self.thread and self.thread.is_alive())

    def start(self, owner: Optional[str]) -> None:
        with self.lock:
            if self.running():
                return
            self.stop_flag = False
            self.error = None
            self.started_at = time.time()
            self.thread = threading.Thread(target=self._loop, args=(owner,), daemon=True, name="realtime-fraud")
            self.thread.start()

    def stop(self) -> None:
        self.stop_flag = True
        with self.cv:
            self.cv.notify_all()
        if self.thread:
            self.thread.join(timeout=10)

    def ready(self) -> bool:
        """Warm and restored (the stored events replayed into the graph): only then may events, a reset or the
        simulator touch the state."""
        return self.graf is not None and self.con is not None and self.ref is not None and not self.warming

    def warm(self) -> None:
        """The deployed package, the feature store in DuckDB (the replay window taken out of the member history, so a
        replayed claim is new when it arrives), the graph's baselines, the references (registry, codes, FKTP and
        non-capitation history) and the state the stored events held before a restart."""
        import duckdb

        from aip import layanan as L
        from aip.realtime import fktp as F
        from aip.realtime.referensi import Referensi

        t0 = time.time()
        self.warming = True
        pk = L._package()
        st = pk["store"]
        con = duckdb.connect()
        con.execute("SET memory_limit = '3GB'")
        con.execute("SET threads = 4")
        tmp = data_dir() / "duckdb"
        tmp.mkdir(exist_ok=True)
        con.execute(f"SET temp_directory = '{tmp.as_posix()}'")
        for name in ("ref_kode", "ref_dx", "faskes", "kode_inacbg"):
            if name in st:
                con.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet('{st[name]}')")
        end = con.execute(f"SELECT max(tgl_datang) FROM read_parquet('{st['peserta']}') WHERE edisi = '{REPLAY_EDISI}'").fetchone()[0]
        start = end - timedelta(days=REPLAY_DAYS - 1)
        con.execute(f"""CREATE TABLE peserta AS SELECT edisi, peserta_id, faskes_profil_id, tgl_datang, inacbg_kode, n FROM read_parquet('{st['peserta']}')
                        WHERE NOT (edisi = '{REPLAY_EDISI}' AND tgl_datang >= DATE '{start}')""")
        con.execute("CREATE TABLE rt_hist (klaim VARCHAR, edisi VARCHAR, peserta_id BIGINT, faskes_profil_id VARCHAR, tgl_datang DATE, inacbg_kode VARCHAR, n BIGINT)")
        pair_rate, sev, pop = G.build_baselines(con, REPLAY_EDISI, start)
        los_base = {f: float(v) for f, v in con.execute("SELECT faskes_profil_id, f_idx_los FROM faskes WHERE f_idx_los > 0").fetchall()}
        self.known_codes = {r[0] for r in con.execute("SELECT inacbg_kode FROM ref_kode").fetchall()}
        # the insurer's own reference tariff per code (median of the code's claims): used when a hospital sends none
        self.tarif_ref = {r[0]: int(r[1]) for r in con.execute("SELECT inacbg_kode, med_tarif FROM ref_kode WHERE med_tarif > 0").fetchall()}
        # the code's own length-of-stay norm (median, p90): what the hospital's pre-check compares a stay with
        try:
            self.los_ref = {r[0]: (float(r[1]), float(r[2])) for r in con.execute(
                "SELECT inacbg_kode, med_los, p90_los FROM ref_kode WHERE med_los IS NOT NULL AND p90_los IS NOT NULL").fetchall()}
        except Exception:  # noqa: BLE001 - an older feature store without the stay norms: the pre-check skips that rule
            log.warning("realtime: ref_kode has no med_los/p90_los")
            self.los_ref = {}
        if "kode_inacbg" in st:
            self.code_ref = {r[0]: {"inacbg_cmg": r[1], "inacbg_tipe_kasus": r[2], "inacbg_keparahan": r[3], "inacbg_deskripsi": r[4]}
                             for r in con.execute("SELECT inacbg_kode, inacbg_cmg, inacbg_tipe_kasus, inacbg_keparahan, inacbg_deskripsi FROM kode_inacbg").fetchall()}
        R = Referensi()
        R.build(con, start, REPLAY_EDISI, data_dir())
        from aip.realtime import aktif as AL
        from aip.realtime import ssl as SSL

        try:
            self.ssl = SSL.load_all()
            self.ssl_mon = {k: [0, 0, 0] for k in self.ssl}
            self.al = AL.load_champion()
        except Exception:  # noqa: BLE001 - the engine runs without them
            log.exception("realtime: ssl / al models")
        g = G.Graf(pair_rate, sev, pop, los_base)
        g.box = self._box_groups()
        fs = F.FktpState(R, g.deaths)
        if self.con is not None:
            try:
                self.con.close()
            except Exception:  # noqa: BLE001
                pass
        self.pk, self.con, self.graf, self.fstate, self.ref, self.window = pk, con, g, fs, R, (start, end)
        try:
            restored = self._restore()
        finally:
            self.warming = False
        rows = con.execute("SELECT count(*) FROM peserta").fetchone()[0]
        self.warm_info = {"pada": _now(), "detik": round(time.time() - t0, 1), "model_run": pk["run"], "model_versi": pk["dep"].get("model_versi"),
                          "riwayat_baris": rows, "jendela_replay": [str(start), str(end)], "edisi_replay": REPLAY_EDISI, "pasangan_baseline": len(pair_rate),
                          "faskes_baseline": len(sev), "keparahan_populasi": round(pop, 4), "referensi": R.info, "dipulihkan": restored}
        log.info("realtime: warm in %.1fs (%s history rows, restored %s)", time.time() - t0, rows, restored)

    def _restore(self) -> dict:
        """The graph, the facility state and the stream history rebuilt from the stored events (their inputs), in order:
        a restart loses nothing the engine had seen."""
        from aip.realtime.kontrak import FktpIn, NonkapIn

        n = {"fkrtl": 0, "fktp": 0, "nonkap": 0}
        hist = []
        for (rec,) in self.store.rows("SELECT rec FROM peristiwa ORDER BY seq"):
            e = json.loads(rec)
            # the counters the status shows
            self.counts[e["keputusan"]] += 1
            self.kinds[e.get("jenis", "fkrtl")] += 1
            self._ssl_count(e)
            if e["keputusan"] != "LOLOS":
                for s in e["sinyal"]:
                    if s.get("kontribusi", 0) > 0:
                        self.signals[s["kode"]] += 1
                for m in e.get("modus") or []:
                    self.modes[m] += 1
            gi = e.get("gi")
            if not gi:
                continue
            j = e.get("jenis", "fkrtl")
            try:
                if j == "fkrtl":
                    gi = {**gi, "d": _d(gi["d"]), "p": _d(gi["p"])}
                    self.graf.add(gi)
                    hist.append({"klaim": e["klaim"], "edisi": e["edisi"], "peserta_id": e["peserta"], "faskes_profil_id": e["faskes"],
                                 "tgl_datang": _d(e["tgl_datang"]), "inacbg_kode": e["kode"], "n": 1})
                elif j == "fktp":
                    v = FktpIn.model_validate(gi)
                    self.fstate.visit(v)
                    if (v.status_pulang or "").upper() == "MENINGGAL":
                        self.graf.deaths[int(v.peserta_id)] = v.tgl_datang
                elif j == "nonkap":
                    self.fstate.nonkap(NonkapIn.model_validate(gi), None, None)
                n[j] = n.get(j, 0) + 1
            except Exception:  # noqa: BLE001 - one bad record does not stop the restore
                log.exception("realtime: restore %s", e.get("id"))
        if hist:
            import pandas as pd

            self.con.register("rt_new", pd.DataFrame(hist))
            self.con.execute("INSERT INTO rt_hist SELECT klaim, edisi, peserta_id::BIGINT, faskes_profil_id, tgl_datang::DATE, inacbg_kode, n::BIGINT FROM rt_new")
            self.con.unregister("rt_new")
        return n

    def _box_groups(self) -> dict[str, str]:
        try:
            from aip import karantina as K

            return {f: r.get("kelompok") for f, r in K._load().items() if r.get("status") not in ("dibebaskan",)}
        except Exception:  # noqa: BLE001 - context only
            return {}

    def _loop(self, owner: Optional[str]) -> None:
        import run_as

        self.ensure()
        last_box = time.time()
        while not self.stop_flag:
            try:
                with run_as.as_owner(owner, "mesin fraud realtime"):
                    if not self.ready():
                        self.warm()
                    with self.cv:
                        while not self.q and not self.stop_flag:
                            self.cv.wait(timeout=1.0)
                            if time.time() - last_box > 60 and self.graf is not None:
                                self.graf.box = self._box_groups()
                                last_box = time.time()
                        items = [self.q.popleft() for _ in range(min(BATCH, len(self.q)))]
                    if items:
                        try:
                            self._process(items)
                        except Exception as e:  # noqa: BLE001 - one bad event must not drop its batch: each again, alone
                            log.exception("realtime: batch of %d failed, retrying one by one", len(items))
                            self.error = f"{type(e).__name__}: {str(getattr(e, 'detail', None) or e)[:400]}"
                            for it in items:
                                try:
                                    self._process([it])
                                except Exception:  # noqa: BLE001
                                    log.exception("realtime: event %s failed", it["id"])
                                    self.failed += 1
                                    self.done[it["id"]] = {"id": it["id"], "keputusan": "GAGAL"}
            except run_as.OwnerUnavailable as e:
                self.error = str(e)
                log.warning("realtime: %s", e)
                set_config(aktif=False)
                return
            except Exception as e:  # noqa: BLE001 - the engine records why and keeps serving the next batch
                log.exception("realtime: batch failed")
                self.error = f"{type(e).__name__}: {str(getattr(e, 'detail', None) or e)[:400]}"
                time.sleep(1)

    # -------------------------------------------------------------------------------------------------
    # ingest
    # -------------------------------------------------------------------------------------------------
    def ingest(self, objs: list[Any], sumber: str, meta: Optional[list[dict]] = None, jenis: str = "fkrtl",
               kinds: Optional[list[str]] = None) -> list[str]:
        """Queue events. kinds: one kind per event (a mixed batch from the simulator), else `jenis` for all."""
        if not self.running():
            raise HTTPException(503, "mesin fraud realtime tidak aktif: nyalakan di tab Realtime Fraud (admin)")
        with self.cv:
            if len(self.q) + len(objs) > QUEUE_MAX:
                raise HTTPException(429, f"antrean realtime penuh ({len(self.q)} peristiwa): coba lagi sebentar")
            now = time.time()
            ids = []
            for i, c in enumerate(objs):
                eid = "ev-" + uuid.uuid4().hex[:14]
                self.q.append({"id": eid, "obj": c, "jenis": kinds[i] if kinds else jenis, "sumber": sumber, "meta": (meta[i] if meta else None) or {},
                               "diterima": now})
                ids.append(eid)
            s = self.sources.setdefault(sumber, {"klaim": 0, "terakhir": None})
            s["klaim"] += len(objs)
            s["terakhir"] = _now()
            self.cv.notify_all()
        return ids

    def wait(self, ids: list[str], timeout: float = 15.0) -> list[Optional[dict]]:
        end = time.time() + timeout
        while time.time() < end and not all(i in self.done for i in ids):
            time.sleep(0.05)
        return [self.done.get(i) for i in ids]

    # -------------------------------------------------------------------------------------------------
    # one micro-batch
    # -------------------------------------------------------------------------------------------------
    def _process(self, items: list[dict]) -> None:
        from aip.realtime import integrasi

        t0 = time.time()
        cfg = config()
        weights = cfg.get("bobot") or {}
        th = (float(cfg["ambang_periksa"]), float(cfg["ambang_tahan"]))
        keys = []
        for it in items:
            o = it["obj"]
            keys.append((o.edisi, int(o.peserta_id)))
        members = self.ref.members(self.con, keys)
        fk = [it for it in items if it["jenis"] == "fkrtl"]
        evs: list[dict] = []
        superseded: list[dict] = []
        if fk:
            e1, superseded = self._fkrtl(fk, members, weights, th)
            evs += e1
        pre = self._ssl_pre(items, members)
        for it in items:
            if it["jenis"] == "fktp":
                evs.append(self._fktp(it, members, weights, th, pre.get(it["id"])))
            elif it["jenis"] == "nonkap":
                evs.append(self._nonkap(it, members, weights, th, pre.get(it["id"])))
        evs.sort(key=lambda e: e["diterima"])
        # the capitation units' contact rate, checked every 20 batches
        self.batches += 1
        if self.batches % 20 == 0:
            for f, s in self.fstate.low_contact():
                evs.append(self._facility_event(f, s, weights, th))
        self._adaptive(evs, cfg, th)
        alerts = [e for e in evs if e["keputusan"] != "LOLOS"]
        if any(e["jenis"] == "fkrtl" for e in alerts):
            self._reasons([e for e in alerts if e["jenis"] == "fkrtl"])
        for e in alerts:
            e["kasus"] = self._case(e)
        # the stream's history grows with this batch's FKRTL claims (after they were scored: point in time)
        hist = [{"klaim": e["klaim"], "edisi": e["edisi"], "peserta_id": e["peserta"], "faskes_profil_id": e["faskes"],
                 "tgl_datang": date.fromisoformat(e["tgl_datang"]), "inacbg_kode": e["kode"], "n": 1} for e in evs if e["jenis"] == "fkrtl"]
        if hist:
            import pandas as pd

            self.con.register("rt_new", pd.DataFrame(hist))
            self.con.execute("INSERT INTO rt_hist SELECT klaim, edisi, peserta_id::BIGINT, faskes_profil_id, tgl_datang::DATE, inacbg_kode, n::BIGINT FROM rt_new")
            self.con.unregister("rt_new")
        t_end = time.time()
        per = (t_end - t0) * 1000 / max(len(evs), 1)
        with self.lock:
            for e in evs:
                e["proses_ms_per_klaim"] = round(per, 2)
                if e["jenis"] == "fkrtl":
                    self.versions[e["klaim"]] = e["versi"]
                self.seq += 1
                e["seq"] = self.seq
        self.store.add_events(evs)
        if alerts and cfg.get("tulis_tag", True):
            try:
                n_all, n_new = integrasi.write_tags(alerts, self.graf, self.fstate)
                self.integration["tag_ditulis"] += n_all
                self.integration["tag_baru"] += n_new
                if cfg.get("box_otomatis", True):
                    self._schedule_box()
            except Exception as e:  # noqa: BLE001 - the decisions stand; the ledger write is reported
                log.exception("realtime: tags")
                self.integration["tag_galat"] = str(getattr(e, "detail", None) or e)[:300]
        self.store.put_cases([self.cases[cid] for cid in {e["kasus"] for e in alerts if e["kasus"]}])
        with self.lock:
            for e in evs:
                self.counts[e["keputusan"]] += 1
                self.kinds[e["jenis"]] += 1
                self._ssl_count(e)
                if e["keputusan"] != "LOLOS":
                    for s in e["sinyal"]:
                        if s["kontribusi"] > 0:
                            self.signals[s["kode"]] += 1
                    for m in e["modus"]:
                        self.modes[m] += 1
                self.lat.append((t_end, e["latensi_ms"], per))
                self.decided.append((t_end, e["keputusan"]))
                b = self.brief(e)
                self.feed.append(b)
                self.done[e["id"]] = b
            for it in superseded:
                self.done[it["id"]] = {"id": it["id"], "keputusan": "DIGANTIKAN", "klaim": f"{it['obj'].edisi}:{it['obj'].kunjungan_fkrtl_id}"}
            if len(self.done) > 20_000:
                for k2 in list(self.done)[:5000]:
                    self.done.pop(k2, None)

    def _adaptive(self, evs: list[dict], cfg: dict, th: tuple) -> None:
        """The active-learning champion on the batch (one call): its probability on every event (shadow), or the decision
        from it (active; the rule score is kept as skor_aturan)."""
        mode = cfg.get("al_mode", "bayangan")
        if self.al is None or mode == "mati" or not evs:
            return
        from aip.realtime import aktif as AL

        try:
            # SSL features only from the SSL versions the champion was trained with (another version: another space)
            p, sd = self.al.predict(AL.matrix(evs, (self.al.meta or {}).get("ssl_versi", {})))
        except Exception:  # noqa: BLE001 - decided by the rules alone
            log.exception("realtime: adaptive model")
            return
        lo, hi = float(cfg.get("al_ambang_periksa", 0.3)), float(cfg.get("al_ambang_tahan", 0.7))
        for e, pi, si in zip(evs, p, sd):
            # p is already on the stream's scale (labels are picked by features, not by class: see aktif.Komite.predict)
            e["adaptif"] = {"p": round(float(pi), 4), "sd": round(float(si), 4), "versi": self.al.meta.get("versi"), "mode": mode}
            if mode == "aktif":
                e["skor_aturan"], e["keputusan_aturan"] = e["skor"], e["keputusan"]
                e["skor"] = round(100 * float(pi), 1)
                e["keputusan"] = "TAHAN" if pi >= hi else "PERIKSA" if pi >= lo else "LOLOS"

    def _event(self, it: dict, jenis: str, key: str, kunjungan: str, f: str, label: str, sigs: list[dict], weights: dict, th: tuple, **kv: Any) -> dict:
        sc, sr, dec, dec_raw = score(sigs, weights, *th)
        now = time.time()
        modes = sorted({m for s in sigs if s["kontribusi"] > 0 for m in s.get("modus") or []})
        ev = {"id": it["id"], "jenis": jenis, "klaim": key, "kunjungan": kunjungan, "sumber": it["sumber"], "versi": it.get("versi", 1),
              "diterima": it["diterima"], "diputus": now, "latensi_ms": round((now - it["diterima"]) * 1000, 1), "skor": sc, "skor_tanpa_mitigasi": sr,
              "keputusan": dec, "keputusan_tanpa_mitigasi": dec_raw, "faskes": f, "faskes_label": label, "sinyal": sigs, "modus": modes, "kasus": None,
              "ml": None, "peringatan": [], "entitas": it["meta"].get("entitas"), "tanda_terima": it["meta"].get("tanda_terima")}
        if it["meta"].get("lapis_faskes"):
            ev["lapis_faskes"] = it["meta"]["lapis_faskes"]  # the hospital's own prevention layer: declaration, not scored
        ev.update(kv)
        return ev

    def _fkrtl(self, items: list[dict], members: dict, weights: dict, th: tuple) -> tuple[list[dict], list[dict]]:
        from aip import layanan as L
        from aip.realtime import aturan_rt as A

        # a claim id twice in one batch: the later version stands
        last = {}
        for it in items:
            c = it["obj"]
            last[f"{c.edisi}:{c.kunjungan_fkrtl_id}"] = it
        superseded = [it for it in items if last[f"{it['obj'].edisi}:{it['obj'].kunjungan_fkrtl_id}"] is not it]
        items = list(last.values())
        for it in items:
            key = f"{it['obj'].edisi}:{it['obj'].kunjungan_fkrtl_id}"
            it["key"] = key
            prev = self.versions.get(key)
            it["versi"] = (prev or 0) + 1
            if prev:
                self.graf.remove(key)
                self.con.execute("DELETE FROM rt_hist WHERE klaim = ?", [key])
        claims = [it["obj"] for it in items]
        df = L.features(claims, self.pk["store"], con=self.con, extra_history="rt_hist")
        # scores without TreeSHAP first (~0.5 ms a claim); the reasons (~40 ms a claim on the forest) only for the alerts
        res, _ = L.infer(df, self.pk, "pkl", False)
        by_key = {r["klaim_id"]: r for r in res}
        rows = {r["klaim_id"]: r for r in df.to_dict("records")}
        self._df = df
        # the self-supervised model: each claim's reconstruction error (anomaly), embedding, raw inputs and explanation
        ssl_of: dict[str, dict] = {}
        m_ssl = self.ssl.get("fkrtl")
        if m_ssl is not None:
            try:
                ssl_of = dict(zip(df["klaim_id"], m_ssl.score_events(df)))
            except Exception:  # noqa: BLE001 - scored without it
                log.exception("realtime: ssl score")
        out = []
        for it in items:
            c, key = it["obj"], it["key"]
            r, row = by_key.get(key), rows.get(key) or {}
            if r is None:
                continue
            f = r["faskes_profil_id"]
            d = c.tgl_datang
            p = c.tgl_pulang or d
            ritl = c.tingkat_pelayanan == "RITL"
            topup = c.sa_tarif_rp + c.sp_tarif_rp + c.rr_tarif_rp + c.si_tarif_rp + c.sd_tarif_rp
            label = f"{c.tipe_fkrtl or c.jenis_fkrtl} · {c.kepemilikan_fkrtl} · {c.kabkota_fkrtl or c.kabkota_fkrtl_kode}"
            if it["meta"].get("faskes_nama"):
                label = f"{it['meta']['faskes_nama']} ({label})"
            idx = row.get("idx_los")
            ref = {"key": key, "pid": int(c.peserta_id), "f": f, "kab": c.kabkota_fkrtl_kode, "kab_nama": c.kabkota_fkrtl, "prov": c.provinsi_fkrtl,
                   "tipe": c.tipe_fkrtl, "rank": G.rank_of(c.tipe_fkrtl), "d": d, "p": p, "ritl": ritl, "kode": c.inacbg_kode, "dx3": c.dx_primer_icd3,
                   "sev3": (c.inacbg_keparahan or self.code_ref.get(c.inacbg_kode, {}).get("inacbg_keparahan")) == SEV3,
                   "biaya": int(c.biaya_tagih_rp), "tarif_total": int((c.tarif_inacbg_rp or 0) + topup), "los": c.los_hari, "prosedur": c.prosedur,
                   "status_pulang": c.status_pulang, "poli": c.poli, "iomt": it["meta"].get("iomt") or {}, "faskes_label": label,
                   "idx_los": float(idx) if idx is not None and idx == idx else None}
            sigs = self.graf.add(ref)
            have = {s["kode"] for s in sigs}
            m = members.get((c.edisi, int(c.peserta_id)))
            sigs += A.claim_rules(c, ref, m, self.ref, self.con, it["meta"], self.graf.deaths)
            # the hospital's electronic medical record (rme.py, SATUSEHAT FHIR) against the claim, when it came with the claim;
            # never breaks scoring
            rme_h = None
            try:
                from aip.realtime import rme as RME

                def terpakai(kunci: str, _s: str = it["sumber"], _f: str = f, _k: str = key) -> bool:
                    lain = self.rme_enc.get((_s, _f, kunci))
                    return lain is not None and lain != _k

                pk_ = (c.edisi, int(c.peserta_id))
                ids_now = {e.get("id") for e in (it["meta"].get("rme") or {}).get("kunjungan") or []}
                riw = [x for x in self.rme_riwayat.get(pk_, ()) if not (x["_sumber"] == it["sumber"] and x["_id"] in ids_now)]
                rme_h = RME.dari_meta(c, it["meta"], m, f, terpakai, riw)
                if rme_h and rme_h.get("jejak"):
                    dq = self.rme_riwayat.pop(pk_, None) or collections.deque(maxlen=30)
                    for j in rme_h["jejak"]:
                        for x in [x for x in dq if x["_sumber"] == it["sumber"] and x["_id"] == j["id"]]:
                            dq.remove(x)
                        dq.append({**j, "id": f"{it['sumber']}:{j['id']}", "_sumber": it["sumber"], "_id": j["id"]})
                    self.rme_riwayat[pk_] = dq
                    while len(self.rme_riwayat) > 200_000:
                        self.rme_riwayat.popitem(last=False)
                kj = (rme_h or {}).get("kunjungan") or {}
                if kj.get("kunci"):  # one recorded encounter billed by two claims of the same source (a resubmission is the same claim)
                    ek = (it["sumber"], f, kj["kunci"])
                    lain = self.rme_enc.get(ek)
                    if lain and lain != key:
                        RME.dipakai_ulang(rme_h, f, lain.split(":", 1)[-1])
                    elif not lain:
                        self.rme_enc[ek] = key
                        while len(self.rme_enc) > 300_000:
                            self.rme_enc.popitem(last=False)
                if rme_h:
                    sigs += rme_h["sinyal"]
            except Exception:  # noqa: BLE001
                log.exception("realtime: rekam medis")
            # the device evidence (iot.py: current-clamp sessions, anchors, the device registry), when it came with the claim;
            # never breaks scoring. Sessions of the same devices from earlier claims are its binding context
            iot_h = None
            try:
                from aip.realtime import iot as IOT

                p_iot = it["meta"].get("iot")
                if isinstance(p_iot, dict):
                    sesi_k = [x for x in p_iot.get("sesi") or [] if isinstance(x, dict)]
                    devs = {str(x.get("device_id")) for x in sesi_k if x.get("device_id")}
                    konteks = [x for d_ in devs for x in self.iot_sesi.get(d_, ()) if x.get("_klaim") != key]
                    iot_h = IOT.dari_meta(c, it["meta"], m, f, konteks)
                    if iot_h:
                        sigs += iot_h["sinyal"]
                    for x in sesi_k:
                        if x.get("device_id") and (x.get("peserta") or x.get("kunjungan")):
                            d_ = str(x["device_id"])
                            dq = self.iot_sesi.pop(d_, None) or collections.deque(maxlen=200)
                            for y in [y for y in dq if y.get("_klaim") == key and y.get("sesi_id") == x.get("sesi_id")]:
                                dq.remove(y)
                            dq.append({**{k_: x.get(k_) for k_ in ("sesi_id", "device_id", "jenis", "peserta", "kunjungan", "mulai", "selesai", "mode")},
                                       "_klaim": key})
                            self.iot_sesi[d_] = dq
                    while len(self.iot_sesi) > 50_000:
                        self.iot_sesi.popitem(last=False)
            except Exception:  # noqa: BLE001
                log.exception("realtime: iot")
            # the model
            k = r.get("kelipatan_ambang") or 0.0
            s_ml = max(0.0, min(1.0, (math.log2(k) + 1) / 2)) if k > 0 else 0.0
            if s_ml > 0:
                sigs.append(G.sig("SKOR_ML", "", None, s_ml, 0, ("faskes", f),
                                  f"peluang dikoreksi {r['risiko_pct']:.3f}% = {k:.2f}× ambang segmen {r['segmen_model']} ({r['model']})"))
            # the semantic layer's claim rules (point-in-time history incl. the stream)
            for t in r.get("indikasi") or []:
                code = t["tag"]
                if code == "KLAIM_GANDA" and "KLAIM_GANDA_STREAM" not in have:
                    strong = int(row.get("kembar") or 1) > 1
                    sigs.append(G.sig("KLAIM_GANDA_RIWAYAT", "", None, 1.0 if strong else 0.5, 0, ("faskes", f), t["bukti"]))
                elif code in ("TAGIHAN_MELEBIHI_TARIF", "LOS_DIPERPANJANG", "READMISI") and not (code == "READMISI" and have & {"PEMECAHAN_EPISODE", "READMISI_DX_SAMA"}):
                    mit = []
                    if code == "READMISI" and c.poli == "IGD":
                        mit.append({"kode": "GAWAT_DARURAT", "label": "masuk lewat IGD (kegawatdaruratan)", "faktor": 0.5})
                    if code == "LOS_DIPERPANJANG" and ref["iomt"].get("los"):
                        mit.append({"kode": "BUKTI_PERANGKAT", "label": "bukti perangkat IoMT terverifikasi mendukung lama rawat", "faktor": 0.7})
                    if code == "TAGIHAN_MELEBIHI_TARIF" and it["meta"].get("tarif_dari_referensi"):
                        mit.append({"kode": "TARIF_REFERENSI", "label": "pembandingnya tarif referensi (median nasional kode), bukan tarif kelas dan regional faskes ini",
                                    "faktor": 0.5})
                    sigs.append(G.sig(code, "", None, 1.0, 0, ("faskes", f), t["bukti"], [], mit))
            ss = ssl_of.get(key)
            s_an = self._ssl_signal("fkrtl", ss, f)
            if s_an:
                sigs.append(s_an)
            # user-defined rules (aturan_kustom.py): their signals, built-ins switched off, approved weights; never breaks scoring
            w_ev = weights
            try:
                from aip.realtime import aturan_kustom as AK

                sigs, w_ev = AK.terapkan(sigs, weights, c, row, m, self.ref, self.los_ref, f, rme=(rme_h or {}).get("nilai"))
            except Exception:  # noqa: BLE001
                log.exception("realtime: aturan kustom")
            gi = {**ref, "d": str(d), "p": str(p)}
            extra = {"rme": RME.untuk_peristiwa(rme_h)} if rme_h else {}
            if iot_h:
                extra["iot"] = IOT.untuk_peristiwa(iot_h)
            ev = self._event(it, "fkrtl", key, c.kunjungan_fkrtl_id, f, label, sigs, w_ev, th, edisi=c.edisi, kab=c.kabkota_fkrtl,
                             ssl=ss,
                             provinsi=c.provinsi_fkrtl, peserta=int(c.peserta_id), tgl_datang=str(d), tgl_pulang=str(c.tgl_pulang) if c.tgl_pulang else None,
                             tingkat=c.tingkat_pelayanan, kode=c.inacbg_kode, dx3=c.dx_primer_icd3, keparahan=c.inacbg_keparahan, biaya=int(c.biaya_tagih_rp),
                             tarif=c.tarif_inacbg_rp, los=c.los_hari, gi=gi,
                             ml={"risiko_pct": r["risiko_pct"], "ambang_pct": round(100 * r["ambang"], 4), "kelipatan": r.get("kelipatan_ambang"),
                                 "ditandai": r["ditandai"], "model": r["model"], "segmen": r["segmen_model"], "alasan": []},
                             peringatan=(r.get("peringatan") or []) + (["tarif INA-CBG tidak dikirim faskes: dipakai tarif referensi sistem audit (median kode)"]
                                                                       if it["meta"].get("tarif_dari_referensi") else []),
                             anggota=_member_view(m), **extra)
            out.append(ev)
        return out, superseded

    def _reasons(self, alerts: list[dict]) -> None:
        """The model's reasons (TreeSHAP) for the alerted FKRTL claims of this batch."""
        from aip import layanan as L

        df = getattr(self, "_df", None)
        if df is None:
            return
        want = {e["klaim"] for e in alerts}
        idx = [i for i, k2 in enumerate(df["klaim_id"]) if k2 in want]
        if not idx:
            return
        try:
            why, _ = L.infer(df.iloc[idx].reset_index(drop=True), self.pk, "pkl", True)
            why = {w["klaim_id"]: w for w in why}
        except Exception:  # noqa: BLE001 - the decision stands without its explanation
            log.exception("realtime: reasons")
            return
        for e in alerts:
            w = why.get(e["klaim"])
            if w and w.get("alasan_rinci"):
                e["ml"]["alasan"] = w["alasan_rinci"][:5]
                for s in e["sinyal"]:
                    if s["kode"] == "SKOR_ML":
                        s["bukti"] += "; alasan model: " + "; ".join(f"{x['label']} {x['nilai']}" for x in w["alasan_rinci"][:3])

    def _fktp(self, it: dict, members: dict, weights: dict, th: tuple, ss: Optional[dict] = None) -> dict:
        from aip.realtime import aturan_rt as A

        v = it["obj"]
        f, sigs = self.fstate.visit(v)
        pid = int(v.peserta_id)
        m = members.get((v.edisi, pid))
        sigs += A.visit_rules(pid, v.tgl_datang, m, f, self.graf.deaths, "kunjungan FKTP")
        s_an = self._ssl_signal("fktp", ss, f)
        if s_an:
            sigs.append(s_an)
        if (v.status_pulang or "").upper() == "MENINGGAL":
            self.graf.deaths[pid] = min(self.graf.deaths.get(pid, v.tgl_datang), v.tgl_datang)
        label = self.fstate.meta[f]["label"]
        return self._event(it, "fktp", f"fktp:{v.edisi}:{v.kunjungan_fktp_id}", v.kunjungan_fktp_id, f, label, sigs, weights, th, edisi=v.edisi,
                           kab=v.kabkota_fktp, provinsi=v.provinsi_fktp, peserta=pid, tgl_datang=str(v.tgl_datang), tgl_pulang=None,
                           tingkat=v.tingkat_pelayanan, kode=(v.poli or "-"), dx3=v.dx_icd3, keparahan=None, biaya=0, tarif=None, los=None,
                           rujukan=(v.tipe_faskes_rujukan if (v.status_pulang or "").upper() == "RUJUK LANJUT" else None), gi=v.model_dump(mode="json"),
                           anggota=_member_view(m), ssl=ss)

    def _nonkap(self, it: dict, members: dict, weights: dict, th: tuple, ss: Optional[dict] = None) -> dict:
        from aip.realtime import aturan_rt as A

        n = it["obj"]
        pid = int(n.peserta_id)
        m = members.get((n.edisi, pid))
        d = n.tgl_tindakan or n.tgl_kunjungan
        age = A._age(m.get("tgl_lahir"), d) if m else None
        f, sigs = self.fstate.nonkap(n, m, age)
        sigs += A.visit_rules(pid, d, m, f, self.graf.deaths, "tindakan nonkapitasi")
        s_an = self._ssl_signal("nonkap", ss, f)
        if s_an:
            sigs.append(s_an)
        label = self.fstate.meta[f]["label"]
        return self._event(it, "nonkap", f"nonkap:{n.edisi}:{n.kunjungan_id}:{n.tindakan_ke or 0}", n.kunjungan_id, f, label, sigs, weights, th,
                           edisi=n.edisi, kab=n.kabkota_faskes, provinsi=n.provinsi_faskes, peserta=pid, tgl_datang=str(d), tgl_pulang=None,
                           tingkat=n.tingkat_layanan, kode=n.tindakan[:60], dx3=n.dx_icd3, keparahan=None, biaya=int(n.biaya_tagih_rp), tarif=None, los=None,
                           gi=n.model_dump(mode="json"), anggota=_member_view(m), ssl=ss)

    def _facility_event(self, f: str, s: dict, weights: dict, th: tuple) -> dict:
        it = {"id": "ev-" + uuid.uuid4().hex[:14], "sumber": "pemantau periodik", "meta": {}, "diterima": time.time()}
        clock = self.fstate.clock
        label = (self.fstate.meta.get(f) or {}).get("label") or s["bukti"].split(":")[0]
        return self._event(it, "faskes", f"faskes:{f}:{clock}", f"pemantauan {clock}", f, label, [s], weights, th, edisi=REPLAY_EDISI, kab=None,
                           provinsi=None, peserta=0, tgl_datang=str(clock), tgl_pulang=None, tingkat="FKTP", kode="angka kontak", dx3=None,
                           keparahan=None, biaya=0, tarif=None, los=None)

    @staticmethod
    def brief(e: dict) -> dict:
        return {"seq": e.get("seq"), "id": e["id"], "jenis": e.get("jenis", "fkrtl"), "klaim": e["klaim"], "kunjungan": e["kunjungan"], "sumber": e["sumber"],
                "versi": e.get("versi", 1), "t": e["diputus"], "faskes": e["faskes"], "faskes_label": e["faskes_label"], "kab": e.get("kab"),
                "kode": e.get("kode"), "tingkat": e.get("tingkat"), "tgl_datang": e.get("tgl_datang"), "biaya": e.get("biaya") or 0, "skor": e["skor"],
                "skor_tanpa_mitigasi": e["skor_tanpa_mitigasi"], "keputusan": e["keputusan"], "latensi_ms": e["latensi_ms"], "kasus": e["kasus"],
                "ml_pct": (e.get("ml") or {}).get("risiko_pct"), "modus": e.get("modus") or [], "adaptif_p": (e.get("adaptif") or {}).get("p"),
                "sinyal": [{"kode": s["kode"], "label": s["label"], "kontribusi": s["kontribusi"], "dimitigasi": bool(s["mitigasi"])} for s in e["sinyal"][:4]]}

    # -------------------------------------------------------------------------------------------------
    # cases: one per focus entity
    # -------------------------------------------------------------------------------------------------
    def _case(self, ev: dict) -> str:
        top = next((s for s in ev["sinyal"] if s["kontribusi"] > 0), None) or {"fokus": ["faskes", ev["faskes"]], "kode": "LAINNYA", "label": "Lainnya"}
        jenis, kunci = top["fokus"]
        now = _now()
        cid = self.open_case.get((jenis, kunci))
        case = self.cases.get(cid) if cid else None
        if case is None:
            cid = "rk-" + uuid.uuid4().hex[:10]
            if jenis == "faskes":
                judul = ev["faskes_label"]
            elif jenis == "peserta":
                judul = f"Peserta …{str(kunci)[-4:]} · {top['label'].lower()}"
            else:
                judul = f"Cincin {len(kunci.split('|'))} faskes"
            case = {"id": cid, "jenis": jenis, "kunci": kunci, "judul": judul, "status": "baru", "dibuat": now, "diperbarui": now, "peristiwa": [],
                    "klaim_n": 0, "tahan_n": 0, "periksa_n": 0, "nilai_rp": 0, "skor_maks": 0.0, "sinyal": {}, "modus": {}, "faskes": [], "peserta": [],
                    "tag": [], "sumber": {}, "jenis_peristiwa": {}, "riwayat": [{"t": now, "status": "baru", "oleh": "mesin"}], "prioritas": 0.0}
            self.cases[cid] = case
            self.open_case[(jenis, kunci)] = cid
        if jenis == "jaringan" and case["kunci"] != kunci:
            case["kunci"] = kunci  # a ring that grew
        case["peristiwa"] = (case["peristiwa"] + [ev["id"]])[-KEEP_CASE_EVENTS:]
        case["klaim_n"] += 1
        case["tahan_n"] += ev["keputusan"] == "TAHAN"
        case["periksa_n"] += ev["keputusan"] == "PERIKSA"
        case["nilai_rp"] += ev.get("biaya") or 0
        case["skor_maks"] = max(case["skor_maks"], ev["skor"])
        for s in ev["sinyal"]:
            if s["kontribusi"] > 0:
                case["sinyal"][s["kode"]] = case["sinyal"].get(s["kode"], 0) + 1
        for m in ev.get("modus") or []:
            case.setdefault("modus", {})[m] = case.setdefault("modus", {}).get(m, 0) + 1
        je = case.setdefault("jenis_peristiwa", {})
        je[ev.get("jenis", "fkrtl")] = je.get(ev.get("jenis", "fkrtl"), 0) + 1
        if ev["faskes"] not in case["faskes"]:
            case["faskes"] = (case["faskes"] + [ev["faskes"]])[-50:]
        if ev.get("peserta") and ev["peserta"] not in case["peserta"]:
            case["peserta"] = (case["peserta"] + [ev["peserta"]])[-200:]
        case["sumber"][ev["sumber"]] = case["sumber"].get(ev["sumber"], 0) + 1
        case["diperbarui"] = now
        case["prioritas"] = round(case["skor_maks"] * (1 + math.log10(1 + case["nilai_rp"] / 1e6)) * (1.2 if case["tahan_n"] else 1.0), 2)
        return cid

    def decide(self, cid: str, keputusan: str, oleh: str, catatan: str) -> dict:
        from aip.realtime import integrasi

        self.ensure()
        case = self.cases.get(cid)
        if not case:
            raise HTTPException(404, "kasus tidak ada")
        now = _now()
        status = {"telaah": "ditelaah", "konfirmasi": "dikonfirmasi", "false_positive": "false_positive", "buka": "baru"}[keputusan]
        case["status"] = status
        case["diperbarui"] = now
        case["riwayat"].append({"t": now, "status": status, "oleh": oleh, "catatan": catatan})
        if status in ("dikonfirmasi", "false_positive"):
            self.open_case.pop((case["jenis"], case["kunci"]), None)
            case["keputusan_tag"] = integrasi.decide_tags(case, status, catatan)
            # the decision labels the case's alerted events for the active learner (a person's queue label stays first)
            have = {r[0] for r in self.store.rows("SELECT peristiwa FROM label WHERE sumber = 'manusia'")}
            lab = 1 if status == "dikonfirmasi" else 0
            rows = [(e["id"], lab, "kasus", oleh, now, f"kasus {cid}: {catatan}"[:300]) for e in self.store.events_of(case["peristiwa"])
                    if e["keputusan"] != "LOLOS" and e["id"] not in have]
            if rows:
                self.store.add_labels(rows)
            if self.box_timer is None and config().get("box_otomatis", True):
                self._schedule_box()
        elif status in ("baru", "ditelaah"):
            self.open_case[(case["jenis"], case["kunci"])] = cid
        self.store.put_cases([case])
        self.store.decision(cid, status, oleh, now, catatan)
        return case

    # -------------------------------------------------------------------------------------------------
    # Box Karantina, debounced
    # -------------------------------------------------------------------------------------------------
    def _schedule_box(self) -> None:
        with self.lock:
            if self.box_timer is not None:
                return
            ctx = contextvars.copy_context()

            def fire() -> None:
                self.box_timer = None
                self.integration["box_terjadwal"] = False
                ctx.run(self.rebuild_box)
            self.box_timer = threading.Timer(BOX_DELAY, fire)
            self.box_timer.daemon = True
            self.box_timer.start()
            self.integration["box_terjadwal"] = True

    def rebuild_box(self) -> dict:
        from aip import karantina as K

        t0 = time.time()
        try:
            out = K.build(log.info)
            self.integration["box_terakhir"] = {"pada": _now(), "detik": round(time.time() - t0, 1), "faskes": out.get("faskes"),
                                                "estimasi_kerugian_rp": out.get("total_estimasi_kerugian_rp")}
            self.integration["box_galat"] = None
            if self.graf is not None:
                self.graf.box = self._box_groups()
            return self.integration["box_terakhir"]
        except Exception as e:  # noqa: BLE001
            log.exception("realtime: box rebuild")
            self.integration["box_galat"] = str(getattr(e, "detail", None) or e)[:300]
            raise

    # -------------------------------------------------------------------------------------------------
    # reads
    # -------------------------------------------------------------------------------------------------
    def ensure(self) -> "Engine":
        """The store opened and the cases loaded (every read of the cases goes through here first)."""
        _ = self.store
        return self

    def status(self) -> dict:
        self.ensure()
        now = time.time()
        with self.lock:
            lat = [x[1] for x in self.lat if now - x[0] <= 300]
            per = [x[2] for x in self.lat if now - x[0] <= 300]
            d1 = [x for x in self.decided if now - x[0] <= 60]
            d5 = [x for x in self.decided if now - x[0] <= 300]
            # events per 20 seconds over the last 10 minutes (oldest first), for the sparkline
            spark = [0] * 30
            for t, _ in self.decided:
                age = now - t
                if age < 600:
                    spark[29 - int(age // 20)] += 1
            cases = list(self.cases.values())
            fs = self.fstate
            out = {"aktif": self.running(), "siap": self.ready(), "galat": self.error, "konfigurasi": config(), "antrean": len(self.q),
                   "mulai": datetime.fromtimestamp(self.started_at, timezone.utc).isoformat(timespec="seconds") if self.started_at else None,
                   "pemanasan": self.warm_info, "keputusan": {k: self.counts.get(k, 0) for k in DECISIONS}, "jenis": {k: self.kinds.get(k, 0) for k in JENIS},
                   "per_menit": len(d1), "per_menit_5": round(len(d5) / 5, 1), "tren_20detik": spark,
                   "latensi_ms": {"p50": pct(lat, 0.5), "p95": pct(lat, 0.95), "p99": pct(lat, 0.99)},
                   "proses_ms_per_klaim": {"p50": pct(per, 0.5), "p95": pct(per, 0.95)},
                   "kasus": {"terbuka": sum(c["status"] in ("baru", "ditelaah") for c in cases), "dikonfirmasi": sum(c["status"] == "dikonfirmasi" for c in cases),
                             "false_positive": sum(c["status"] == "false_positive" for c in cases), "total": len(cases)},
                   "ditahan_rp": sum(c["nilai_rp"] for c in cases if c["status"] in ("baru", "ditelaah") and c["tahan_n"]),
                   "sinyal_alert": dict(self.signals.most_common()), "modus_alert": dict(self.modes), "sumber": self.sources, "integrasi": self.integration,
                   "graf": {**self.graf.summary(), "kematian_tercatat": len(self.graf.deaths), "los_bergeser": len(self.graf.los_shift),
                            "fktp_anomali_aktif": len(fs.active) if fs else 0, "unit_kontak_rendah": len(fs.alerted_units) if fs else 0} if self.graf else None,
                   "total_diputus": sum(self.counts.values()), "gagal_diproses": self.failed}
        out["al"] = self.al_status()
        return out

    def al_status(self) -> dict:
        from aip.realtime import aktif as AL
        from aip.realtime import ssl as SSL

        by = {}
        for src, n, pos in self.store.rows("SELECT sumber, count(*), sum(label) FROM label GROUP BY 1"):
            by[src] = {"label": n, "positif": int(pos or 0)}
        sim = AL.last_simulation()
        cfg = config()
        champ = (self.al.meta or {}).get("ssl_versi", {}) if self.al else {}
        ssl = {}
        for k in SSL.KINDS:
            m = self.ssl.get(k)
            if m is None:
                ssl[k] = None
                continue
            meta = {x: v for x, v in m.meta.items() if x not in ("nama_fitur",)}
            ssl[k] = {**meta, "nama": SSL.NAMA[k], "fitur_input": len(m.spec.num) + len(m.spec.cats), "drift": SSL.drift(*self.ssl_mon.get(k, [0, 0, 0])),
                      "juara_cocok": bool(self.al) and champ.get(k) == m.versi}
        return {"mode": cfg.get("al_mode", "bayangan"), "ambang": {"periksa": float(cfg.get("al_ambang_periksa", 0.3)), "tahan": float(cfg.get("al_ambang_tahan", 0.7))},
                "ssl": ssl, "ssl_latih": {k: v for k, v in SSL.STATE.items()},
                "juara": self.al.meta if self.al else None, "registri": AL.registry()[-10:], "label": by,
                "simulasi": {"status": AL.SIM["status"], "progres": AL.SIM["progres"], "galat": AL.SIM["galat"],
                             "ringkas": {k: sim[k] for k in ("pada", "auprc_skor_aturan", "terbaik", "label_untuk_melampaui_aturan")} if sim else None},
                "bisa_dipromosikan": self.sim_model is not None}

    def feed_since(self, seq: int, limit: int = 100) -> list[dict]:
        with self.lock:
            return [x for x in self.feed if (x.get("seq") or 0) > seq][-limit:]

    def reset(self) -> None:
        from aip.realtime import fktp as F

        if self.warming:
            raise HTTPException(409, "mesin masih memulihkan peristiwa tersimpan: tunggu sampai siap")
        self.ensure()
        with self.cv:
            self.q.clear()
        with self.lock:
            self.store.reset()
            for c in (self.feed, self.done, self.lat, self.decided, self.counts, self.kinds, self.signals, self.modes, self.versions, self.cases,
                      self.open_case, self.sources, self.rme_enc, self.rme_riwayat, self.iot_sesi):
                c.clear()
            self.ssl_mon = {k: [0, 0, 0] for k in self.ssl}
            self.integration.update(tag_ditulis=0, tag_baru=0)
            self.seq = 0
            self.resolver = None
            if self.con is not None:
                self.con.execute("DELETE FROM rt_hist")
            if self.pk is not None and self.graf is not None:
                old = self.graf
                g = G.Graf(old.pair_rate, old.sev_base, old.sev_pop, old.los_base)
                g.box = old.box
                self.graf = g
                self.fstate = F.FktpState(self.ref, g.deaths)


def _member_view(m: Optional[dict]) -> Optional[dict]:
    """What the decision shows of the card holder (no identity: sex, age band, class entitlement, segment, death year)."""
    if not m:
        return None
    born = m.get("tgl_lahir")
    year = born.year if hasattr(born, "year") else None
    ym = m.get("tahun_meninggal")
    return {"jk": m.get("jk"), "tahun_lahir": year, "hak_kelas": int(m["hak"]) if m.get("hak") == m.get("hak") and m.get("hak") is not None else None,
            "segmen": m.get("segmen"), "tahun_meninggal": int(ym) if ym is not None and ym == ym else None, "status": m.get("status_kepesertaan"),
            "keluarga": bool(m.get("keluarga_id"))}


ENGINE = Engine()


def startup() -> None:
    """The engine starts with the API when it was on (as its owner)."""
    cfg = config()
    if cfg.get("aktif"):
        ENGINE.start(cfg.get("pemilik"))
