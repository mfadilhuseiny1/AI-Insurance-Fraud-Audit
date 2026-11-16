"""The stream simulator: the last REPLAY_DAYS days of the synthetic data (edition "reguler") replayed in service-date
order — FKRTL claims, FKTP visits and non-capitation claims interleaved — with planted fraud scenarios for every mode
of Permenkes 16/2019 the engine reads. Everything here is SYNTHETIC (the synthetic twin of Data Sampel BPJS,
synthetic-gen/): no real claim passes through.

The engine took the replay window out of the member history (mesin.Engine.warm) and compares each FKTP and non-capitation
facility with its history before the window (referensi.py), so a replayed event is new when it arrives.

Each planted instance is built from events just replayed (realistic codes, tariffs, facilities, members), its events
spread through the next part of the stream; SCENARIOS says which modes it plants. M18 and M20 need dispensing and
result lines the sample does not hold: their scenarios attach such lines to a replayed claim (generated here, labelled
so). The truth (which event belongs to which instance, and the verifier's label of every replayed FKRTL claim) goes to
its own table; the engine never reads it. The evaluation joins it with the decisions.

Electronic medical records (rme.py) are not in the sample either. A share of the replayed inpatient claims (RME_PORSI) comes
with a synthetic SATUSEHAT record consistent with the claim, with real documentation gaps (rme_sintetis, derau), so the
false alerts of the record rules are measured on normal claims; the four rme_* scenarios plant records that contradict the
claim. Both are labelled synthetic.
"""

from __future__ import annotations

import collections
import hashlib
import logging
import random
import threading
import time
from datetime import date, timedelta
from typing import Any, Optional

from fastapi import HTTPException

from aip.realtime import mesin as E
from aip.realtime.modus import NON_SPESIALISTIK
from aip.realtime.store import data_dir

log = logging.getLogger("aip.realtime.sim")

# scenario -> (label, modes it plants, signals that count as the right catch)
SCENARIOS: dict[str, tuple[str, list[str], set[str]]] = {
    "kontak_semu": ("Kontak semu Puskesmas (online/home-visit)", ["M01"], {"KONTAK_SEMU"}),
    "kontak_rendah": ("Angka kontak Puskesmas anjlok (layanan tidak diberikan)", ["M01"], {"KONTAK_RENDAH"}),
    "rrns_puskesmas": ("Rujukan non-spesialistik Puskesmas melonjak", ["M01", "M03"], {"RRNS_PUSKESMAS_NAIK", "RUJUKAN_NON_SPESIALISTIK"}),
    "nonkap_ganda": ("Tindakan nonkapitasi ganda", ["M02"], {"NONKAP_GANDA"}),
    "nonkap_frekuensi": ("Pemeriksaan Prolanis diulang", ["M02"], {"NONKAP_FREKUENSI"}),
    "nonkap_peserta": ("KB/ANC untuk peserta laki-laki", ["M02"], {"NONKAP_TIDAK_SESUAI_PESERTA"}),
    "nonkap_tarif": ("Tarif tindakan nonkapitasi digelembungkan", ["M02"], {"NONKAP_TARIF"}),
    "rrns_swasta": ("Rujukan non-spesialistik FKTP swasta melonjak", ["M03"], {"RRNS_FKTP_NAIK", "RUJUKAN_NON_SPESIALISTIK"}),
    "upcoding": ("Upcoding keparahan III", ["M04"], {"LONJAKAN_KEPARAHAN"}),
    "dx_sekunder": ("Diagnosis sekunder digelembungkan", ["M04"], {"DX_SEKUNDER_BERLEBIH"}),
    "kloning": ("Kloning klaim lintas peserta", ["M05"], {"KLONING_LINTAS_PESERTA"}),
    "kartu_dipinjam": ("Kartu dipinjam (rawat inap tumpang tindih)", ["M06"], {"RAWAT_INAP_TUMPANG_TINDIH", "KARTU_BANYAK_FASKES"}),
    "setelah_meninggal": ("Klaim setelah kematian", ["M06"], {"MENINGGAL_TERCATAT"}),
    "kartu_keluarga": ("Kartu anggota keluarga dipakai", ["M06", "M15"], {"KARTU_KELUARGA", "TIDAK_SESUAI_PESERTA"}),
    "topup_inflasi": ("Top-up obat/alkes digelembungkan", ["M07"], {"TOPUP_DI_ATAS_PEER"}),
    "episode_hari_sama": ("Rawat jalan + rawat inap hari yang sama", ["M08"], {"EPISODE_HARI_SAMA"}),
    "pemecahan_episode": ("Unbundling: masuk lagi esok hari", ["M09"], {"PEMECAHAN_EPISODE"}),
    "cincin_kolusi": ("Collusion ring antarfaskes", ["M10"], {"CINCIN_FASKES"}),
    "rujukan_memusat": ("Rujukan FKTP memusat ke satu RS", ["M10"], {"KONSENTRASI_RUJUKAN"}),
    "klaim_ganda": ("Klaim ganda (id lain)", ["M11"], {"KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT"}),
    "klaim_mirip": ("Klaim berulang (tanggal digeser)", ["M11"], {"KLAIM_BERULANG_MIRIP"}),
    "los_bergeser": ("Lama rawat faskes diperpanjang", ["M12"], {"LOS_FASKES_BERGESER", "LOS_DIPERPANJANG"}),
    "kelas_naik": ("Peserta PBI ditagih Kelas 1", ["M13"], {"KELAS_DI_ATAS_HAK"}),
    "prosedur_fiktif": ("Kode prosedur tanpa tindakan", ["M14"], {"KODE_PROSEDUR_TANPA_TINDAKAN"}),
    "kode_tidak_sesuai": ("Kode INA-CBG tidak lazim untuk diagnosis", ["M15"], {"PASANGAN_KODE_LANGKA"}),
    "readmisi": ("Readmisi diagnosis sama", ["M16"], {"READMISI_DX_SAMA"}),
    "topup_fiktif": ("Top-up obat khusus yang tak pernah ada untuk kode", ["M17"], {"TOPUP_TIDAK_LAZIM"}),
    "obat_fiktif": ("Obat ditagih tanpa diserahkan (baris obat simulator)", ["M17"], {"OBAT_TIDAK_DISERAHKAN"}),
    "obat_dikurangi": ("Obat diserahkan kurang (baris obat simulator)", ["M18"], {"OBAT_DIKURANGI"}),
    "hasil_manipulasi": ("Hasil pemeriksaan klaim ≠ alat (baris hasil simulator)", ["M20"], {"HASIL_PEMERIKSAAN_TIDAK_COCOK"}),
    # against a synthetic SATUSEHAT medical record (rme_sintetis)
    "rme_tindakan_fiktif": ("Tindakan ditagih tanpa jejak di rekam medis (RME sintetis)", ["M14", "M15"],
                            {"RME_TINDAKAN_TIDAK_TERCATAT", "RME_KLINIS_TIDAK_MENDUKUNG"}),
    "rme_dx_tidak_didukung": ("Diagnosis dibantah hasil ukur rekam medis (RME sintetis)", ["M04"], {"RME_DIAGNOSIS_TIDAK_DIDUKUNG", "RME_DIAGNOSIS_TIDAK_TERCATAT"}),
    "rme_los": ("Lama rawat klaim lebih panjang dari rekam medis (RME sintetis)", ["M12"], {"RME_LOS_TIDAK_SESUAI"}),
    "rme_kunjungan_fiktif": ("Rawat inap tanpa kunjungan di rekam medis (RME sintetis)", ["M06"], {"RME_KUNJUNGAN_TIDAK_ADA"}),
}
RME_PORSI = 0.3  # share of replayed inpatient claims sent with a consistent synthetic medical record
RME_DERAU = 0.1  # documentation gaps in those records (rme_sintetis.bundel derau)
MODE_OF = {k: v[1] for k, v in SCENARIOS.items()}
SEV3 = E.SEV3
SPECIALS = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")


def _d(v: Any) -> Optional[date]:
    if v is None or (isinstance(v, float) and v != v):
        return None
    if isinstance(v, date) and not hasattr(v, "hour"):
        return v
    return v.date() if hasattr(v, "date") else date.fromisoformat(str(v)[:10])


def _clean(r: dict) -> dict:
    return {k: (None if v is None or (isinstance(v, float) and v != v) else v) for k, v in r.items()}


class Simulator:
    def __init__(self, engine: E.Engine) -> None:
        self.e = engine
        self.lock = threading.Lock()
        self.thread: Optional[threading.Thread] = None
        self.stop_flag = False
        self.rate = 100.0
        self.auto = True
        self.frames: dict[str, Any] = {}
        self.order: list[tuple[str, int]] = []
        self.i = 0
        self.pool: dict[str, collections.deque] = {"fkrtl": collections.deque(maxlen=5000), "fktp": collections.deque(maxlen=6000),
                                                   "nonkap": collections.deque(maxlen=3000)}
        self.pending: list[tuple[int, str, dict, tuple, dict]] = []
        self.emitted = 0
        self.planted: collections.Counter = collections.Counter()
        self.instances = 0
        self.next_auto = 300
        self.cycle = list(SCENARIOS)
        self.rng = random.Random(20261109)
        self.error: Optional[str] = None
        self.done = False
        self.suppressed: dict[str, dict] = {}
        self.skipped = 0
        self.carry: list[tuple[str, dict, tuple, dict]] = []  # a batch the engine refused (full queue), sent again first
        self.waits = 0  # how often the simulator waited for the engine

    # -------------------------------------------------------------------------------------------------
    def load(self) -> None:
        """The replay rows of the three kinds (read once, as the admin who starts the simulator, from the silver datasets)."""
        import duckdb
        import pandas as pd

        from aip import layanan as L
        from aip.realtime.kontrak import FktpIn, NonkapIn
        from aip.realtime.referensi import silver_path

        if not self.e.ready():
            raise HTTPException(409, "mesin realtime belum siap (memuat model dan referensi): tunggu beberapa detik")
        start, end = self.e.window
        con = duckdb.connect()
        specs = {"fkrtl": ("kunjungan_fkrtl", [f for f in L.KlaimIn.model_fields], "tgl_datang", ", coalesce(flag_selisih_verifikasi, false) AS _y"),
                 "fktp": ("kunjungan_fktp", list(FktpIn.model_fields), "tgl_datang", ""),
                 "nonkap": ("tindakan_nonkapitasi", list(NonkapIn.model_fields), "tgl_kunjungan", "")}
        for kind, (name, fields, dcol, extra) in specs.items():
            cache = data_dir() / f"replay_{kind}_{start}_{end}.parquet"
            if not cache.is_file():
                path = silver_path(name, data_dir()).as_posix()
                have = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()}
                cols = ", ".join(f for f in fields if f in have)
                con.execute(f"""COPY (SELECT {cols}{extra}, {dcol} AS _date FROM read_parquet('{path}')
                                WHERE edisi = '{E.REPLAY_EDISI}' AND {dcol} BETWEEN DATE '{start}' AND DATE '{end}'
                                ORDER BY {dcol}, hash({fields[0]})) TO '{cache.as_posix()}' (FORMAT parquet)""")
            self.frames[kind] = pd.read_parquet(cache)
        con.close()
        order = []
        for kind, df in self.frames.items():
            for i, d in enumerate(df["_date"].tolist()):
                order.append((_d(d), int(hashlib.md5(f"{kind}{i}".encode()).hexdigest()[:8], 16), kind, i))
        order.sort()
        self.order = [(k, i) for _, _, k, i in order]
        log.info("realtime sim: %s replay events %s..%s", {k: len(v) for k, v in self.frames.items()}, start, end)

    def _row(self, kind: str, i: int) -> dict:
        r = _clean(self.frames[kind].iloc[i].to_dict())
        r["_t"] = kind
        return r

    def _obj(self, kind: str, body: dict) -> Optional[Any]:
        from aip import layanan as L
        from aip.realtime.kontrak import FktpIn, NonkapIn

        b = {k: v for k, v in body.items() if not k.startswith("_")}
        try:
            if kind == "fkrtl":
                for k in ("tgl_datang", "tgl_pulang"):
                    b[k] = _d(b.get(k))
                for k in ("peserta_id", "kabkota_fkrtl_kode", "tarif_inacbg_rp", *SPECIALS, "biaya_tagih_rp", "los_hari", "jumlah_dx_sekunder"):
                    if b.get(k) is not None:
                        b[k] = int(b[k])
                for k in SPECIALS:
                    b[k] = b.get(k) or 0
                for k in ("flag_calon_klaim_ganda", "flag_los_ekstrem", "layanan_covid"):
                    b[k] = bool(b.get(k) or False)
                b = {k: v for k, v in b.items() if v is not None or k in ("tipe_fkrtl", "prosedur")}
                return L.KlaimIn.model_validate(b)
            if kind == "fktp":
                for k in ("tgl_datang", "tgl_pulang"):
                    b[k] = _d(b.get(k))
                for k in ("peserta_id", "kabkota_fktp_kode", "kabkota_rujukan_kode"):
                    if b.get(k) is not None:
                        b[k] = int(b[k])
                return FktpIn.model_validate(b)
            for k in ("tgl_kunjungan", "tgl_tindakan", "tgl_pulang"):
                b[k] = _d(b.get(k))
            for k in ("peserta_id", "kabkota_faskes_kode", "tindakan_ke", "biaya_tagih_rp"):
                if b.get(k) is not None:
                    b[k] = int(b[k])
            return NonkapIn.model_validate(b)
        except Exception:  # noqa: BLE001 - a row the contract refuses is skipped (counted)
            self.skipped += 1
            return None

    # -------------------------------------------------------------------------------------------------
    def start(self, rate: float, auto: bool) -> dict:
        with self.lock:
            self.rate, self.auto = max(0.5, min(rate, 500.0)), auto
            if self.thread and self.thread.is_alive():
                return self.status()
            if not self.order:
                self.load()
            self.stop_flag = False
            self.error = None
            self.done = False
            self.thread = threading.Thread(target=self._loop, daemon=True, name="realtime-sim")
            self.thread.start()
        return self.status()

    def stop(self) -> None:
        self.stop_flag = True
        if self.thread:
            self.thread.join(timeout=5)

    def reset(self) -> None:
        self.stop()
        self.i = 0
        self.emitted = 0
        self.pending.clear()
        for p in self.pool.values():
            p.clear()
        self.planted.clear()
        self.instances = 0
        self.next_auto = 300
        self.done = False
        self.suppressed.clear()
        self.carry = []
        self.waits = 0
        self.rng = random.Random(20261109)

    def status(self) -> dict:
        return {"berjalan": bool(self.thread and self.thread.is_alive()), "laju": self.rate, "otomatis": self.auto, "terkirim": self.emitted,
                "replay": {"posisi": self.i, "total": len(self.order), "jendela": [str(x) for x in (self.e.window or ())],
                           "per_jenis": {k: len(v) for k, v in self.frames.items()}},
                "skenario_ditanam": dict(self.planted), "instans": self.instances, "antre_tanam": len(self.pending), "galat": self.error,
                "selesai": self.done, "skenario": {k: v[0] for k, v in SCENARIOS.items()}, "modus_skenario": MODE_OF,
                "unit_ditekan": len(self.suppressed), "baris_ditolak_kontrak": self.skipped, "menunggu_mesin": self.waits, "tertahan": len(self.carry)}

    def _suppressed(self, r: dict) -> bool:
        if r["_t"] != "fktp" or not self.suppressed:
            return False
        from aip.realtime.referensi import unit

        u = unit(r.get("kabkota_fktp_kode"), r.get("kepemilikan_fktp"), r.get("jenis_fktp"))
        return u in self.suppressed and int(hashlib.md5(str(r.get("kunjungan_fktp_id")).encode()).hexdigest()[:4], 16) % 10 != 0

    def _loop(self) -> None:
        acc = 0.0
        tick = 0.2
        while not self.stop_flag:
            t0 = time.time()
            acc += self.rate * tick
            n = int(acc)
            acc -= n
            batch: list[tuple[str, dict, tuple, dict]] = []
            while len(batch) < n:
                ready = [p for p in self.pending if p[0] <= self.emitted + len(batch)]
                if ready:
                    p = min(ready, key=lambda x: x[0])
                    self.pending.remove(p)
                    batch.append((p[1], p[2], p[3], p[4]))
                    continue
                if self.i >= len(self.order):
                    break
                kind, idx = self.order[self.i]
                self.i += 1
                row = self._row(kind, idx)
                if self._suppressed(row):
                    continue
                batch.append((kind, row, ("normal", None, int(bool(row.get("_y")))) if kind == "fkrtl" else ("normal", None, None), {}))
                self.pool[kind].append(row)
            if self.auto and self.emitted >= self.next_auto and len(self.pool["fkrtl"]) > 300 and len(self.pool["fktp"]) > 300:
                kind = self.cycle[self.instances % len(self.cycle)]
                try:
                    self.plant(kind)
                except HTTPException as ex:
                    log.info("realtime sim: plant %s skipped: %s", kind, ex.detail)
                    self.instances += 1
                except Exception:  # noqa: BLE001
                    log.exception("realtime sim: plant %s", kind)
                    self.instances += 1
                self.next_auto = self.emitted + self.rng.randint(200, 400)
            # backpressure: a batch the engine's full queue refused is sent again first (never dropped: a dropped batch
            # lost normal and planted events alike, and the stream no longer matched the window)
            if self.carry:
                batch = self.carry + batch
                self.carry = []
            if batch and not self._send(batch):
                self.carry = batch
                continue
            if self.i >= len(self.order) and not self.pending and not self.carry:
                self.done = True
                break
            time.sleep(max(0.0, tick - (time.time() - t0)))

    def _send(self, batch: list[tuple[str, dict, tuple, dict]]) -> bool:
        """False when the engine refused the batch (full queue): the caller sends it again."""
        self._rme_normal(batch)
        objs, kinds, truth, metas = [], [], [], []
        for kind, body, tr, meta in batch:
            o = self._obj(kind, body)
            if o is not None:
                objs.append(o)
                kinds.append(kind)
                truth.append(tr)
                metas.append(meta)
        if not objs:
            return True
        try:
            ids = self.e.ingest(objs, "simulator", metas, kinds=kinds)
        except HTTPException as ex:
            self.error = str(ex.detail)
            self.waits += 1
            time.sleep(1)
            return False
        self.error = None
        now = time.time()
        rows = []
        for i, o, k, tr in zip(ids, objs, kinds, truth):
            key = (f"{o.edisi}:{o.kunjungan_fkrtl_id}" if k == "fkrtl" else f"fktp:{o.edisi}:{o.kunjungan_fktp_id}" if k == "fktp"
                   else f"nonkap:{o.edisi}:{o.kunjungan_id}:{o.tindakan_ke or 0}")
            rows.append((i, key, tr[0], tr[1], tr[2], now))
        self.e.store.add_truth(rows)
        self.emitted += len(objs)
        return True

    # -------------------------------------------------------------------------------------------------
    # synthetic medical records
    # -------------------------------------------------------------------------------------------------
    def _pasien(self, ids: list[int]) -> dict[int, dict]:
        """The card holders' sex and birth date (a synthetic record belongs to the card holder)."""
        if not ids:
            return {}
        import pandas as pd

        cur = self.e.con.cursor()
        try:
            cur.register("ids_rme", pd.DataFrame({"peserta_id": sorted(set(ids))}))
            rows = cur.execute("SELECT peserta_id, jk, tgl_lahir FROM anggota WHERE edisi = ? AND peserta_id IN (SELECT peserta_id FROM ids_rme)",
                               [E.REPLAY_EDISI]).df().to_dict("records")
        finally:
            cur.close()
        return {int(r["peserta_id"]): {"jk": r.get("jk"), "tgl_lahir": str(r["tgl_lahir"])[:10] if r.get("tgl_lahir") is not None and r["tgl_lahir"] == r["tgl_lahir"] else None,
                                       "seed": str(r["peserta_id"])} for r in rows}

    @staticmethod
    def _klaim_rme(body: dict, dx_sekunder: Optional[list] = None) -> dict:
        return {"id": body.get("kunjungan_fkrtl_id"), "tgl_datang": _d(body.get("tgl_datang")), "tgl_pulang": _d(body.get("tgl_pulang")),
                "tingkat": body.get("tingkat_pelayanan"), "poli": body.get("poli"), "dx_utama": body.get("dx_primer_kode") or body.get("dx_primer_icd3"),
                "dx_sekunder": list(dx_sekunder or []), "tindakan": [x.strip() for x in str(body.get("prosedur") or "").split(";") if x.strip() and x.strip() != "None"],
                "sd_tarif_rp": int(body.get("sd_tarif_rp") or 0), "rr_tarif_rp": int(body.get("rr_tarif_rp") or 0)}

    def _rme_meta(self, body: dict, varian: str, pasien: Optional[dict], dx_sekunder: Optional[list] = None, **kv: Any) -> dict:
        from aip.realtime import rme as RME
        from aip.realtime import rme_sintetis as RS

        k = self._klaim_rme(body, dx_sekunder)
        b = RS.bundel(k, varian, self.rng, pasien, **kv)
        return {"rme": RME.baca(b), "klaim_kode": {"dx_utama": k["dx_utama"], "dx_sekunder": k["dx_sekunder"], "tindakan": k["tindakan"]}, "rme_sintetis": varian}

    def _rme_normal(self, batch: list) -> None:
        pick = [(kind, body, tr, meta) for kind, body, tr, meta in batch
                if kind == "fkrtl" and tr[0] == "normal" and not meta and body.get("tingkat_pelayanan") == "RITL" and body.get("tgl_pulang")
                and int(hashlib.md5(str(body.get("kunjungan_fkrtl_id")).encode()).hexdigest()[:4], 16) % 1000 < RME_PORSI * 1000]
        if not pick:
            return
        try:
            ps = self._pasien([int(b["peserta_id"]) for _, b, _, _ in pick])
            for _, body, _, meta in pick:
                meta.update(self._rme_meta(body, "sesuai", ps.get(int(body["peserta_id"])), derau=RME_DERAU))
        except Exception:  # noqa: BLE001 - the claims go without a record
            log.exception("realtime sim: rekam medis sintetis")

    # -------------------------------------------------------------------------------------------------
    # planted scenarios
    # -------------------------------------------------------------------------------------------------
    def _new_id(self, kind: str, n: int) -> str:
        return f"SIM{kind[:5].upper()}{self.instances:04d}{n:02d}{self.rng.randint(100, 999)}"

    def _copy(self, t: dict, kind: str, n: int, **kv: Any) -> dict:
        b = dict(t)
        idf = {"fkrtl": "kunjungan_fkrtl_id", "fktp": "kunjungan_fktp_id", "nonkap": "kunjungan_id"}[t["_t"]]
        b[idf] = self._new_id(kind, n)
        b.update(kv)
        b.pop("_y", None)
        return b

    def _ritl(self, cond: Any = None) -> list[dict]:
        return [r for r in self.pool["fkrtl"] if r.get("tingkat_pelayanan") == "RITL" and r.get("tgl_pulang") and (cond is None or cond(r))]

    def _due(self, spread: int) -> int:
        return self.emitted + self.rng.randint(1, max(2, spread))

    def _members(self, n: int = 400) -> list[dict]:
        """Registry rows of recently replayed members (sex, birth date, segment, entitlement, family)."""
        ids = sorted({int(r["peserta_id"]) for r in list(self.pool["fkrtl"])[-2000:]})
        ids = self.rng.sample(ids, min(n, len(ids)))
        cur = self.e.con.cursor()
        try:
            import pandas as pd

            cur.register("ids", pd.DataFrame({"peserta_id": ids}))
            return cur.execute("""SELECT peserta_id, jk, tgl_lahir, segmen, hak, keluarga_id, tahun_meninggal FROM anggota
                                  WHERE edisi = ? AND peserta_id IN (SELECT peserta_id FROM ids)""", [E.REPLAY_EDISI]).df().to_dict("records")
        finally:
            cur.close()

    def _like(self, t: dict) -> int:
        """Another recently seen member of the same sex and a similar age as the template's (so the copy fits its card)."""
        ms = self._members(300)
        mine = next((m for m in ms if m["peserta_id"] == t["peserta_id"]), None)
        if mine is None:
            cur = self.e.con.cursor()
            try:
                row = cur.execute("SELECT jk, tgl_lahir FROM anggota WHERE edisi = ? AND peserta_id = ?", [E.REPLAY_EDISI, int(t["peserta_id"])]).fetchone()
            finally:
                cur.close()
            mine = {"jk": row[0], "tgl_lahir": row[1]} if row else {}
        def close(a: Any, b: Any) -> bool:
            try:
                return abs((_d(a) - _d(b)).days) < 3650
            except Exception:  # noqa: BLE001 - a missing birth date is not close
                return False

        cands = [m["peserta_id"] for m in ms if m["peserta_id"] != t["peserta_id"] and m.get("jk") == mine.get("jk") and close(m.get("tgl_lahir"), mine.get("tgl_lahir"))]
        return int(self.rng.choice(cands)) if cands else int(self.rng.choice(ms)["peserta_id"])

    def _add(self, kind: str, inst: str, claims: list[tuple[int, dict]], meta: Optional[dict] = None) -> None:
        for due, body in claims:
            self.pending.append((due, body["_t"], body, (kind, inst, None), meta or {}))

    def plant(self, kind: str) -> dict:
        if kind not in SCENARIOS:
            raise HTTPException(400, f"skenario tidak dikenal: {', '.join(SCENARIOS)}")
        if len(self.pool["fkrtl"]) < 100:
            raise HTTPException(409, "simulator belum mengirim cukup klaim untuk dijadikan templat: jalankan dulu")
        inst = f"{kind}-{self.instances:04d}"
        rng = self.rng
        claims: list[tuple[int, dict]] = []
        meta: dict = {}
        ft = list(self.pool["fktp"])
        nk = list(self.pool["nonkap"])
        R = self.e.ref
        if kind == "klaim_ganda":
            t = rng.choice(self._ritl() or list(self.pool["fkrtl"]))
            claims.append((self._due(30), self._copy(t, kind, 0)))
        elif kind == "klaim_mirip":
            t = rng.choice(self._ritl(lambda r: (r.get("los_hari") or 0) >= 2))
            d = _d(t["tgl_datang"]) + timedelta(days=1)
            claims.append((self._due(40), self._copy(t, kind, 0, tgl_datang=d, tgl_pulang=_d(t["tgl_pulang"]) + timedelta(days=1))))
        elif kind == "pemecahan_episode":
            t = rng.choice(self._ritl(lambda r: (r.get("los_hari") or 0) >= 2))
            d0 = _d(t["tgl_pulang"]) + timedelta(days=1)
            los = max(2, int(t.get("los_hari") or 2) - 1)
            claims.append((self._due(40), self._copy(t, kind, 0, tgl_datang=d0, tgl_pulang=d0 + timedelta(days=los), los_hari=los)))
        elif kind == "readmisi":
            t = rng.choice(self._ritl(lambda r: (r.get("los_hari") or 0) >= 2))
            d0 = _d(t["tgl_pulang"]) + timedelta(days=rng.randint(8, 20))
            los = int(t.get("los_hari") or 3)
            claims.append((self._due(40), self._copy(t, kind, 0, tgl_datang=d0, tgl_pulang=d0 + timedelta(days=los))))
        elif kind == "episode_hari_sama":
            t = rng.choice(self._ritl())
            rj = rng.choice([r for r in self.pool["fkrtl"] if r.get("tingkat_pelayanan") == "RJTL" and r.get("inacbg_kode") != t.get("inacbg_kode")])
            body = self._copy(rj, kind, 0, peserta_id=t["peserta_id"], tgl_datang=_d(t["tgl_datang"]), tgl_pulang=_d(t["tgl_datang"]),
                              dx_primer_icd3=t["dx_primer_icd3"], **{k: t.get(k) for k in ("kabkota_fkrtl_kode", "kabkota_fkrtl", "provinsi_fkrtl",
                                                                                           "kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl", "regional_tarif")})
            claims.append((self._due(40), body))
        elif kind == "kartu_dipinjam":
            t0 = rng.choice(self._ritl(lambda r: (r.get("los_hari") or 0) >= 4) or self._ritl())
            others: dict = {}
            for r in rng.sample(self._ritl(), min(400, len(self._ritl()))):
                prov = r["kabkota_fkrtl_kode"] // 100
                if prov != t0["kabkota_fkrtl_kode"] // 100 and prov not in others:
                    others[prov] = r
                if len(others) == 2:
                    break
            d = _d(t0["tgl_datang"])
            for n, (o, off) in enumerate(zip(others.values(), (1, 2))):
                claims.append((self._due(60), self._copy(o, kind, n, peserta_id=t0["peserta_id"], tgl_datang=d + timedelta(days=off),
                                                        tgl_pulang=d + timedelta(days=off + 3), los_hari=3)))
        elif kind == "setelah_meninggal":
            # a stay that ends in the member's death (another member like the template's, so it is no duplicate), then a
            # claim for the same member four days after
            t = rng.choice(self._ritl())
            pid = self._like(t)
            p = _d(t["tgl_pulang"])
            claims.append((self._due(10), self._copy(t, kind, 0, peserta_id=pid, status_pulang="Meninggal")))
            later = rng.choice([r for r in self.pool["fkrtl"] if r.get("tingkat_pelayanan") == "RJTL"])
            claims.append((self._due(80) + 15, self._copy(later, kind, 1, peserta_id=pid, tgl_datang=p + timedelta(days=4),
                                                         tgl_pulang=p + timedelta(days=4))))
        elif kind == "kartu_keluarga":
            obst = [r for r in self._ritl(lambda r: str(r.get("dx_primer_icd3") or "").startswith("O"))]
            if not obst:
                raise HTTPException(409, "belum ada klaim kebidanan di aliran untuk templat")
            ms = [m for m in self._members(600) if m.get("jk") == "L" and m.get("keluarga_id") is not None]
            pick = None
            cur = self.e.con.cursor()
            try:
                for m in ms[:200]:
                    fam = cur.execute("""SELECT count(*) FROM anggota WHERE edisi = ? AND keluarga_id = ? AND jk = 'P'
                                         AND date_diff('year', tgl_lahir, DATE '2024-12-20') BETWEEN 18 AND 45""", [E.REPLAY_EDISI, m["keluarga_id"]]).fetchone()[0]
                    if fam:
                        pick = m
                        break
            finally:
                cur.close()
            if not pick:
                raise HTTPException(409, "tidak ada keluarga yang cocok di sampel peserta terbaru")
            claims.append((self._due(40), self._copy(rng.choice(obst), kind, 0, peserta_id=int(pick["peserta_id"]))))
        elif kind == "kelas_naik":
            ms = [m for m in self._members(600) if str(m.get("segmen") or "").startswith("PBI") and m.get("hak") == 3]
            if not ms:
                raise HTTPException(409, "tidak ada peserta PBI di sampel peserta terbaru")
            t = rng.choice(self._ritl())
            claims.append((self._due(40), self._copy(t, kind, 0, peserta_id=int(rng.choice(ms)["peserta_id"]), kelas_rawat="Kelas 1")))
        elif kind == "prosedur_fiktif":
            t = rng.choice([r for r in self.pool["fkrtl"] if len(str(r.get("inacbg_kode") or "")) > 2 and str(r["inacbg_kode"])[2] in "13" and r.get("prosedur")])
            claims.append((self._due(40), self._copy(t, kind, 0, peserta_id=self._like(t), prosedur=None)))
        elif kind == "kode_tidak_sesuai":
            for _ in range(60):
                t = rng.choice(self._ritl())
                other = rng.choice(self._ritl())
                code = other.get("inacbg_kode")
                if code and R.rare_pair(t.get("dx_primer_icd3"), code) and code[:1] != str(t.get("inacbg_kode") or "")[:1]:
                    claims.append((self._due(40), self._copy(other, kind, 0, peserta_id=t["peserta_id"], dx_primer_icd3=t["dx_primer_icd3"],
                                                            tgl_datang=_d(t["tgl_datang"]), tgl_pulang=_d(t["tgl_datang"]) + timedelta(days=int(other.get("los_hari") or 2)))))
                    break
            if not claims:
                raise HTTPException(409, "tidak menemukan pasangan diagnosis–kode langka dari templat")
        elif kind == "dx_sekunder":
            t = rng.choice([r for r in self._ritl() if (R.kode.get(r.get("inacbg_kode")) or {}).get("n", 0) >= 200])
            p99 = R.kode[t["inacbg_kode"]]["dx_sek_p99"]
            claims.append((self._due(40), self._copy(t, kind, 0, peserta_id=self._like(t), jumlah_dx_sekunder=int(p99) + 8)))
        elif kind == "topup_inflasi":
            cands = [r for r in self.pool["fkrtl"] if any((R.topup.get((r.get("inacbg_kode"), c)) or {}).get("n", 0) >= 20 for c in SPECIALS)]
            if not cands:
                raise HTTPException(409, "belum ada klaim dengan kode yang punya riwayat top-up")
            t = rng.choice(cands)
            col = next(c for c in SPECIALS if (R.topup.get((t["inacbg_kode"], c)) or {}).get("n", 0) >= 20)
            amt = int(R.topup[(t["inacbg_kode"], col)]["p95"] * 3)
            claims.append((self._due(40), self._copy(t, kind, 0, peserta_id=self._like(t), **{col: amt},
                                                    biaya_tagih_rp=int(t["biaya_tagih_rp"] or 0) + amt)))
        elif kind == "topup_fiktif":
            cands = [r for r in self._ritl() if (R.kode.get(r.get("inacbg_kode")) or {}).get("n", 0) >= 200
                     and (R.topup.get((r.get("inacbg_kode"), "sd_tarif_rp")) or {}).get("n", 0) <= 2]
            t = rng.choice(cands)
            claims.append((self._due(40), self._copy(t, kind, 0, peserta_id=self._like(t), sd_tarif_rp=4_500_000,
                                                    biaya_tagih_rp=int(t["biaya_tagih_rp"] or 0) + 4_500_000)))
        elif kind in ("obat_fiktif", "obat_dikurangi", "hasil_manipulasi"):
            t = rng.choice(self._ritl())
            claims.append((self._due(40), self._copy(t, kind, 0, peserta_id=self._like(t))))
            if kind == "obat_fiktif":
                meta = {"obat": [{"kode": "J01DD04", "nama": "Seftriakson 1 g inj (baris simulator)", "diresepkan": 6, "ditagih": 6, "diserahkan": 0}]}
            elif kind == "obat_dikurangi":
                meta = {"obat": [{"kode": "C09AA02", "nama": "Enalapril 10 mg (baris simulator)", "diresepkan": 30, "ditagih": 30, "diserahkan": 10}]}
            else:
                meta = {"pemeriksaan": [{"parameter": "Hemoglobin (baris simulator)", "satuan": "g/dL", "nilai_klaim": 6.4, "nilai_alat": 11.8, "toleransi": 0.1}]}
        elif kind.startswith("rme_"):
            from aip.realtime import rme as RME

            def berprosedur(r: dict) -> bool:
                return any(RME.bermakna(RME.icd9(x)) for x in str(r.get("prosedur") or "").split(";") if RME.icd9(x))

            cands = {"rme_tindakan_fiktif": self._ritl(berprosedur), "rme_los": self._ritl(lambda r: int(r.get("los_hari") or 0) >= 4)}.get(kind) or self._ritl()
            if not cands:
                raise HTTPException(409, "belum ada klaim rawat inap yang cocok di aliran")
            t = rng.choice(cands)
            body = self._copy(t, kind, 0, peserta_id=self._like(t))
            ps = self._pasien([int(body["peserta_id"])]).get(int(body["peserta_id"]))
            varian = {"rme_tindakan_fiktif": "tindakan_fiktif", "rme_dx_tidak_didukung": "dx_tidak_didukung", "rme_los": "los",
                      "rme_kunjungan_fiktif": "kunjungan_fiktif"}[kind]
            meta = self._rme_meta(body, varian, ps, ["J96.0", "E87.1"] if kind == "rme_dx_tidak_didukung" else None)
            claims.append((self._due(40), body))
        elif kind == "upcoding":
            counts = collections.Counter(_prof(r) for r in self._ritl())
            fac = next((f for f, c in counts.most_common(20) if c >= 6), None)
            if fac is None:
                raise HTTPException(409, "belum ada faskes dengan cukup klaim rawat inap di aliran")
            temps = [r for r in self._ritl() if _prof(r) == fac]
            n = 0
            for t in temps * 4:
                code = str(t["inacbg_kode"])
                up = code.rsplit("-", 1)[0] + "-III"
                if up == code or up not in self.e.known_codes:
                    continue
                tarif = int((t.get("tarif_inacbg_rp") or t["biaya_tagih_rp"]) * 1.8)
                ref = self.e.code_ref.get(up) or {}
                claims.append((self._due(450), self._copy(t, kind, n, peserta_id=self._like(t), inacbg_kode=up, inacbg_keparahan=SEV3,
                                                         inacbg_deskripsi=ref.get("inacbg_deskripsi") or t.get("inacbg_deskripsi"),
                                                         tarif_inacbg_rp=tarif, biaya_tagih_rp=tarif + int((t["biaya_tagih_rp"] or 0) - (t.get("tarif_inacbg_rp") or 0)))))
                n += 1
                if n >= 18:
                    break
            if n < 8:
                raise HTTPException(409, "kode keparahan III untuk templat faskes ini tidak ada di referensi")
        elif kind == "los_bergeser":
            counts = collections.Counter(_prof(r) for r in self._ritl())
            fac = next((f for f, c in counts.most_common(30) if c >= 5), None)
            if fac is None:
                raise HTTPException(409, "belum ada faskes dengan cukup klaim rawat inap")
            temps = [r for r in self._ritl() if _prof(r) == fac]
            for n in range(20):
                t = temps[n % len(temps)]
                los = max(4, int(t.get("los_hari") or 2) * 3)
                d = _d(t["tgl_datang"])
                claims.append((self._due(400), self._copy(t, kind, n, peserta_id=self._like(t), los_hari=los, tgl_pulang=d + timedelta(days=los))))
        elif kind == "kloning":
            t = rng.choice(self._ritl(lambda r: (r.get("los_hari") or 0) >= 3))
            topup = sum(int(t.get(k) or 0) for k in SPECIALS)
            bill = int(t.get("tarif_inacbg_rp") or 0) + topup + 750_000
            members = rng.sample(sorted({r["peserta_id"] for r in self.pool["fkrtl"] if r["peserta_id"] != t["peserta_id"]}), 4)
            for n, pid in enumerate(members):
                claims.append((self._due(40), self._copy(t, kind, n, peserta_id=pid, biaya_tagih_rp=bill)))
        elif kind == "cincin_kolusi":
            by_fac: dict[str, list[dict]] = collections.defaultdict(list)
            for r in self.pool["fkrtl"]:
                by_fac[_prof(r)].append(r)
            provs: dict[Any, list[str]] = collections.defaultdict(list)
            for f, rs in by_fac.items():
                if len(rs) >= 3:
                    provs[rs[0]["kabkota_fkrtl_kode"] // 100].append(f)
            prov = rng.choice([p for p, fs in provs.items() if len(fs) >= 3] or list(provs))
            ring = rng.sample(provs[prov], min(3, len(provs[prov])))
            members = rng.sample(sorted({r["peserta_id"] for r in self.pool["fkrtl"]}), 7)
            d = max(_d(self.pool["fkrtl"][-1]["tgl_datang"]) - timedelta(days=5), self.e.window[0])
            n = 0
            for j, pid in enumerate(members):
                for k, f in enumerate(ring):
                    t = rng.choice(by_fac[f])
                    dd = d + timedelta(days=k * 2 + j % 2)
                    los = 2 if t.get("tingkat_pelayanan") == "RITL" else 0
                    claims.append((self._due(500), self._copy(t, kind, n, peserta_id=pid, tgl_datang=dd, tgl_pulang=dd + timedelta(days=los))))
                    n += 1
        # FKTP and non-capitation scenarios
        elif kind in ("kontak_semu", "rrns_puskesmas", "rrns_swasta", "rujukan_memusat"):
            gov = kind in ("kontak_semu", "rrns_puskesmas")
            by: dict[str, list[dict]] = collections.defaultdict(list)
            for r in ft:
                by[_prof_fktp(r)].append(r)
            cands = [f for f, rs in by.items() if len(rs) >= 8 and (str(rs[0].get("kepemilikan_fktp") or "").upper().startswith("PEM")) == gov]
            if not cands:
                raise HTTPException(409, "belum ada FKTP yang cocok di aliran")
            f = rng.choice(cands)
            temps = by[f]
            refs = [r for r in ft if (r.get("status_pulang") or "") == "RUJUK LANJUT" and r.get("kabkota_rujukan_kode")]
            members = [r["peserta_id"] for r in ft]
            if kind == "kontak_semu":
                for n in range(48):
                    t = rng.choice(temps)
                    claims.append((self._due(300), self._copy(t, kind, n, peserta_id=rng.choice(members), poli="KUNJUNGAN ONLINE", status_pulang="BEROBAT JALAN",
                                                             jenis_kunjungan="KUNJUNGAN SAKIT", dx_icd3="Z00")))
            elif kind in ("rrns_puskesmas", "rrns_swasta"):
                dxs = sorted(NON_SPESIALISTIK)
                for n in range(26):
                    t, r0 = rng.choice(temps), rng.choice(refs)
                    claims.append((self._due(500), self._copy(t, kind, n, peserta_id=rng.choice(members), status_pulang="RUJUK LANJUT", dx_icd3=rng.choice(dxs),
                                                             **{k: r0.get(k) for k in ("kabkota_rujukan_kode", "kepemilikan_rujukan", "jenis_faskes_rujukan",
                                                                                       "tipe_faskes_rujukan", "poli_rujukan")})))
            else:
                far = [r for r in refs if r.get("kabkota_rujukan_kode") != temps[0].get("kabkota_fktp_kode")] or refs
                r0 = rng.choice(far)
                for n in range(22):
                    t = rng.choice(temps)
                    src = rng.choice(refs)
                    claims.append((self._due(500), self._copy(t, kind, n, peserta_id=rng.choice(members), status_pulang="RUJUK LANJUT", dx_icd3=src.get("dx_icd3"),
                                                             **{k: r0.get(k) for k in ("kabkota_rujukan_kode", "kepemilikan_rujukan", "jenis_faskes_rujukan",
                                                                                       "tipe_faskes_rujukan", "poli_rujukan")})))
        elif kind == "kontak_rendah":
            from aip.realtime.referensi import unit

            units = collections.Counter(unit(r.get("kabkota_fktp_kode"), r.get("kepemilikan_fktp"), r.get("jenis_fktp")) for r in ft
                                        if str(r.get("kepemilikan_fktp") or "").upper().startswith("PEM"))
            choice = next((u for u, c in units.most_common(60)[10:] if u not in self.suppressed and (R.unit.get(u) or {}).get("per_hari", 0) >= 40), None)
            if not choice:
                raise HTTPException(409, "tidak ada unit Puskesmas yang cocok")
            self.suppressed[choice] = {"instans": inst, "t0": time.time(), "emitted0": self.emitted}
        elif kind in ("nonkap_ganda", "nonkap_frekuensi", "nonkap_peserta", "nonkap_tarif"):
            if len(nk) < 30:
                raise HTTPException(409, "belum cukup klaim nonkapitasi di aliran")
            if kind == "nonkap_ganda":
                t = rng.choice(nk)
                claims.append((self._due(40), self._copy(t, kind, 0)))
            elif kind == "nonkap_frekuensi":
                t = rng.choice([r for r in nk if any(c in str(r.get("tindakan")) for c in ("Gula Darah", "Kolesterol", "HbA1c", "Kreatinin"))] or nk)
                d = _d(t.get("tgl_tindakan") or t["tgl_kunjungan"]) + timedelta(days=10)
                claims.append((self._due(40), self._copy(t, kind, 0, tgl_kunjungan=d, tgl_tindakan=d, tgl_pulang=d)))
            elif kind == "nonkap_peserta":
                t = rng.choice([r for r in nk if any(c in str(r.get("tindakan")) for c in ("ANC", "KB :", "Persalinan"))] or nk)
                males = [m for m in self._members(400) if m.get("jk") == "L"]
                claims.append((self._due(40), self._copy(t, kind, 0, peserta_id=int(rng.choice(males)["peserta_id"]))))
            else:
                t = rng.choice([r for r in nk if (R.nonkap_tindakan.get(r.get("tindakan")) or {}).get("p95", 0) > 0] or nk)
                p95 = (R.nonkap_tindakan.get(t.get("tindakan")) or {}).get("p95") or t["biaya_tagih_rp"]
                claims.append((self._due(40), self._copy(t, kind, 0, biaya_tagih_rp=int(p95 * 3))))
        self._add(kind, inst, claims, meta)
        self.planted[kind] += 1
        self.instances += 1
        return {"skenario": kind, "instans": inst, "peristiwa": len(claims), "modus": MODE_OF[kind]}


def _prof(r: dict) -> str:
    from aip.realtime.referensi import profile

    return profile("FKRTL", r.get("kabkota_fkrtl_kode"), r.get("kepemilikan_fkrtl"), r.get("jenis_fkrtl"), r.get("tipe_fkrtl"))


def _prof_fktp(r: dict) -> str:
    from aip.realtime.referensi import profile

    return profile("FKTP", r.get("kabkota_fktp_kode"), r.get("kepemilikan_fktp"), r.get("jenis_fktp"), r.get("tipe_fktp"))


# ------------------------------------------------------------------------------------------------
# evaluation: the decisions against the planted truth and the verifier's labels
# ------------------------------------------------------------------------------------------------


def evaluate(engine: E.Engine, sim: Optional[Simulator] = None) -> dict:
    import json

    rows = engine.store.rows("""SELECT k.skenario, k.instans, k.label_verifikator, p.seq, p.diterima, p.diputus, p.keputusan, p.rec
                                FROM kebenaran k JOIN peristiwa p ON p.id = k.peristiwa ORDER BY p.seq""")
    if not rows:
        return {"ada": False}
    inst: dict[str, dict] = {}
    normal: dict[str, dict] = {}
    planted_prevented = 0
    lat = []
    for sk, ins, y, seq, t_in, t_out, dec, rec in rows:
        r = json.loads(rec)
        lat.append(r["latensi_ms"])
        alert = dec in ("PERIKSA", "TAHAN")
        prevented = r.get("keputusan_tanpa_mitigasi") in ("PERIKSA", "TAHAN") and not alert
        j = r.get("jenis", "fkrtl")
        if sk == "normal":
            nm = normal.setdefault(j, {"n": 0, "alert": 0, "tahan": 0, "label1": 0, "berlabel": 0, "alert_label1": 0, "alert_berlabel": 0,
                                       "sinyal": collections.Counter(), "dicegah_mitigasi": 0})
            nm["n"] += 1
            nm["alert"] += alert
            nm["tahan"] += dec == "TAHAN"
            if y is not None:
                nm["berlabel"] += 1
                nm["label1"] += int(y)
                if alert:
                    nm["alert_berlabel"] += 1
                    nm["alert_label1"] += int(y)
            nm["dicegah_mitigasi"] += prevented
            if alert:
                for s in r["sinyal"]:
                    if s["kontribusi"] > 0:
                        nm["sinyal"][s["kode"]] += 1
            continue
        planted_prevented += prevented
        i = inst.setdefault(ins, {"instans": ins, "skenario": sk, "klaim": 0, "alert": 0, "tepat": 0, "seq0": seq, "t0": t_in, "seq_alert": None,
                                  "t_alert": None, "sinyal": collections.Counter()})
        i["klaim"] += 1
        if alert:
            i["alert"] += 1
            kodes = {s["kode"] for s in r["sinyal"] if s["kontribusi"] > 0}
            i["sinyal"].update(kodes)
            if kodes & SCENARIOS.get(sk, ("", [], set()))[2]:
                i["tepat"] += 1
            if i["seq_alert"] is None:
                i["seq_alert"], i["t_alert"] = seq, t_out
    # suppressed capitation units (no planted event: the finding is the unit's periodic alert)
    if sim is not None and sim.suppressed:
        alerts = {}
        for (rec,) in engine.store.rows("SELECT rec FROM peristiwa WHERE json_extract(rec, '$.jenis') = 'faskes'"):
            e = json.loads(rec)
            alerts.setdefault(e["faskes"], e)
        for u, s in sim.suppressed.items():
            fac = (engine.fstate.unit_meta.get(u) or {}).get("faskes") if engine.fstate else None
            e = alerts.get(fac) if fac else None
            caught = bool(e) and u in (engine.fstate.alerted_units if engine.fstate else set())
            inst[s["instans"]] = {"instans": s["instans"], "skenario": "kontak_rendah", "klaim": 0, "alert": int(caught), "tepat": int(caught),
                                  "seq0": 0, "t0": s["t0"], "seq_alert": None, "t_alert": e["diputus"] if caught else None,
                                  "sinyal": collections.Counter({"KONTAK_RENDAH": 1} if caught else {}), "unit": u}
    per = {}
    for sk, (label, modes, _) in SCENARIOS.items():
        xs = [i for i in inst.values() if i["skenario"] == sk]
        caught = [i for i in xs if i["alert"]]
        right = [i for i in xs if i["tepat"]]
        delays = sorted(i["seq_alert"] - i["seq0"] for i in caught if i["seq_alert"] is not None)
        secs = sorted(round(i["t_alert"] - i["t0"], 2) for i in caught if i["t_alert"])
        per[sk] = {"label": label, "modus": modes, "instans": len(xs), "tertangkap": len(caught), "sinyal_tepat": len(right),
                   "klaim": sum(i["klaim"] for i in xs), "klaim_alert": sum(i["alert"] for i in xs),
                   "jeda_klaim_median": delays[len(delays) // 2] if delays else None, "jeda_detik_median": secs[len(secs) // 2] if secs else None,
                   "sinyal": dict(sum((i["sinyal"] for i in xs), collections.Counter()).most_common(5))}
    out_normal = {}
    for j, nm in normal.items():
        base = nm["label1"] / nm["berlabel"] if nm["berlabel"] else None
        prec = nm["alert_label1"] / nm["alert_berlabel"] if nm["alert_berlabel"] else None
        out_normal[j] = {"klaim": nm["n"], "alert": nm["alert"], "tahan": nm["tahan"], "porsi_alert": nm["alert"] / nm["n"] if nm["n"] else None,
                         "dikoreksi_verifikator_dasar": base, "dikoreksi_di_antara_alert": prec, "lift": (prec / base) if (prec is not None and base) else None,
                         "sinyal_alert": dict(nm["sinyal"].most_common(12)), "dicegah_mitigasi": nm["dicegah_mitigasi"]}
    lat.sort()
    allx = list(per.values())
    return {"ada": True, "skenario": per, "normal": out_normal.get("fkrtl") or {}, "normal_per_jenis": out_normal,
            "ringkas": {"instans": sum(x["instans"] for x in allx), "tertangkap": sum(x["tertangkap"] for x in allx), "sinyal_tepat": sum(x["sinyal_tepat"] for x in allx)},
            "mitigasi": {"alert_normal_dicegah": sum(n["dicegah_mitigasi"] for n in normal.values()), "klaim_tanam_lolos_karena_mitigasi": planted_prevented},
            "latensi_ms": {"p50": E.pct(lat, 0.5), "p95": E.pct(lat, 0.95), "p99": E.pct(lat, 0.99), "n": len(lat)},
            "catatan": ("Skenario tanam dibangkitkan dari peristiwa sintetis yang baru diputar; kebenaran disimpan terpisah dan tidak pernah menjadi input mesin. "
                        "Baris obat dan hasil pemeriksaan (M17 obat, M18, M20) dibangkitkan simulator karena data sampel tidak memuatnya. "
                        f"Rekam medis SATUSEHAT juga sintetis: {RME_PORSI:.0%} klaim rawat inap normal membawa rekam medis yang konsisten (dengan celah "
                        "dokumentasi), skenario rme_* menanam rekam medis yang bertentangan dengan klaim. "
                        "Label verifikator mengukur koreksi verifikasi (koding/administrasi), bukan fraud terbukti: presisi terhadapnya adalah lift, bukan akurasi fraud.")}
