"""AI Agent Swarm Branch, end to end, on a theme dataset of one branch office (KC): bulk claims + FHIR medical records + keys,
as testing/gen_tema.py + testing/rekam_medis.py + testing/paket_tema.py write them ("Data Sintetis/tema_jantung_kc_sul-7371").
The user (2026-11-14): "pastikan juga AI Agent Swarm kalau di run, bisa ngehasilin report yang sama" and "saya mau coba run agent
swarm buat KC ini buat dataset jantung"; the UI's "Proyek baru -> Audit baru" picks one, several or all clinical themes (--tema).

The same flow as the generator-3 branch runs (.tmp/gen3_kc2_paralel.sh + .tmp/run_kc2.sh), one stage after the other, resumable:

  fitur    per replica (= one independent one-year world; never merged into one stream, see the dataset README): a fresh copy of
           the /testing data, the realtime engine (platform_lokal, as testing/uji_gen2.py), the replica's WHOLE claim stream
           (klaim/klaim_semua.parquet: every claim of its members, all themes, all hospitals, in submission order `urut`) ingested
           in order; the theme claims at the branch's hospitals carry their SATUSEHAT record (rekam_medis/replika_XX, read as
           aip/realtime/rme_batch.py reads the bulk export: per patient, by the member number in Patient.identifier), so the
           engine's RME_* signals fire as in production (--tanpa-rme: without records). Then the stream features X1/X2/XR
           (fitur.Stream) and X4 (fitur_v4) exactly as uji_gen2.chunk, and <set>/hasil_NN.npz with the fields the branch report
           and graf_cabang read (+ the claim id, replica, theme, hospital-in-branch, RME score). Labels come from the key file
           (kunci/label_fraud.parquet) and are used for the technical appendix only. Heavy: holds .tmp/BERAT.lock.
           Each claim's medical-record findings keep their evidence (`rme_bukti`: signal -> plain text with numbers, strength,
           mitigations, as rme.periksa wrote them) for the dossier and the case file.
  zona     testing/v5.py siapkan --model ml_v7 (ML v7 zones TAHAN / RAGU / LOLOS + the RAGU dossiers; takes the lock itself),
           then the claims the swarm will read: RAGU claims at the branch's hospitals whose theme (laporan_cabang.tema_klaim) is
           selected. Writes <set>/perkiraan.json: per theme claims, TAHAN, RAGU, the estimated swarm cost (and, for a subset of
           replicas, scaled to the whole dataset). When the estimate exceeds the budget, only the top RAGU claims by screening
           score that fit are sent (the rest are reported as unread).
  iot      the hospital devices' usage (testing/iot_cabang.py; input format docs/IOT_FORMAT_MASUKAN.md): --iot <folder> = real
           data (validated here first: per-file rows, rejected rows and why; a folder without devices, sessions or readings is
           refused), or --iot-sintetis = a synthetic IoT world for the set's branch (fixed seed, --iot-seed), generated once per
           set; then the checker (iot_cabang.periksa) writes <cabang>/iot/<set>/bukti.json, monitoring.json, ... so the IoT
           results exist before the swarm and the report. Without either flag the stage is skipped. The sensor is a current clamp
           on the device's power cable: on-time, run length and mode only, no vitals.
  aturan   the rule engines meet the swarm (testing/swarm_v5.py "Rule engines -> swarm"): every selected claim's medical-record
           findings (rme_bukti) and IoT result (bukti.json) become numbered findings R1..Rn with a strength. (1) Routing: a claim
           with a finding >= KUAT_RUTE (0.5) goes to the swarm even when ML v7 put it in LOLOS; a verifiable finding >= KUAT_BUKTI
           (0.8: a document mismatch anyone can re-check, e.g. an anchored ventilator record below the billed 96 h, a billed
           procedure absent from a record that has clinical data) opens the rule-evidence lane. (2) Dossier: "Temuan rekam medis
           (RME)" and "Bukti pemakaian alat (IoT)" sections, de-identified, each finding owned by one specialist. (3) Cost: the
           estimate per theme counts the rule-routed claims and each dossier's real length; over the cap the evidence lane goes
           first, then the ML score. Writes <kerja>/jalur_<set>.json (findings per claim, routed keys) and the swarm's input.
           Why: the rule engines see what ML v7 never sees (the record, the device), but they also raise false alerts (0.16 % of
           normal cardiac claims for the record) and they cannot weigh an innocent explanation; the swarm can, and the judge must
           accept or reject each finding in writing. Neither decides alone.
  swarm    real: one smoke batch (<= $0.05), then testing/swarm_v5_adk.py jalankan (Vertex, cost guard = --batas-usd minus what
           this set already spent minus the writer's reserve), then ekspor. --dry-run: NO model call: the same ADK tree with an
           offline fake model (answers marked "uji kering"), in its own folder and cache, so a later real run never reuses them.
           Then the gate (swarm_v5.gerbang) for every claim the swarm read: the ML lane f = (p_judge + q(s))/2 >= tau 0.72 as
           before, and for a claim with a verifiable finding the judge did not reject, f = max(f_ml, (p_judge + k)/2) with k the
           finding's strength (<= 0.99, so the judge still needs p >= 0.45). <kerja>/gerbang_<set>.json records each claim's lane,
           f_ml, f_aturan, k and the judge's stance on each finding (laporan_cabang reads it to queue the claim, see the docs).
  laporan  testing/laporan_cabang.py --set --kc --label [--tema] (it calls testing/graf_cabang.py for each case's network and
           explanation). --dry-run writes to <set>/cabang (not the app's data/aip/cabang, not runs.json) unless --tulis-app.
  narasi   real only: the writer agent on the report's exhibits (testing/swarm_v5_adk.py narasi), then the report again.

Every stage updates <set>/status.json (stage, counts, spent USD, error) for a UI. Synthetic data only; nothing personal is
printed (members appear as P-xxxx in the report, as before). The ML model's 45 rule signals (aktif.CODES) are frozen: the medical
record and the IoT findings are never model features, they route claims and inform the agents.

Usage (PowerShell, from the repo root; PYTHONHASHSEED=0 PYTHONUTF8=1 are set by the runner for its children):
  .venv\\Scripts\\python.exe testing\\jalan_kc_tema.py --set tema_jantung_uji --replika 60,61 --tema I --dry-run
  .venv\\Scripts\\python.exe testing\\jalan_kc_tema.py --set tema_jantung --tema I --dry-run          (all replicas: exact estimate)
  .venv\\Scripts\\python.exe testing\\jalan_kc_tema.py --set tema_jantung --tema I --batas-usd 20 --label "..."   (the real run)
  .venv\\Scripts\\python.exe testing\\jalan_kc_tema.py status --set tema_jantung
 With IoT (docs/AUDIT_KC_IOT_RME.md):
  (a) your own data: claims + the patients' medical records as a theme dataset folder of "Data Sintetis/" (klaim/, rekam_medis/,
      peserta/, kunci/, ringkasan.json), and the IoT folder in docs/IOT_FORMAT_MASUKAN.md format:
  .venv\\Scripts\\python.exe testing\\jalan_kc_tema.py --set audit_rs_saya --dataset <folder> --tema I --iot "data\\iot\\<folder>" --batas-usd 20
      (add --dry-run first: every stage at $0, the report in .tmp\\kc_tema\\<set>\\cabang)
  (b) the synthetic cardiology dataset with synthetic IoT:
  .venv\\Scripts\\python.exe testing\\jalan_kc_tema.py --set tema_jantung_iot_uji --dataset tema_jantung_kc_sul-7371 --replika 60,61 --tema I --dry-run --iot-sintetis
  .venv\\Scripts\\python.exe testing\\jalan_kc_tema.py --set tema_jantung_iot --dataset tema_jantung_kc_sul-7371 --tema I --iot-sintetis --batas-usd 20"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "Data Sintetis" / "tema_jantung_kc_sul-7371"
AKAR = ROOT / ".tmp" / "kc_tema"  # one folder per set (= UJI_SET_ROOT/<set>): hasil_NN.npz, status.json, logs, swarm folders
PY = ROOT / ".venv" / "Scripts" / "python.exe"
PY_ADK = ROOT / ".venv-adk" / "Scripts" / "python.exe"
LOCK = ROOT / ".tmp" / "BERAT.lock"
REF_SWARM = ROOT / ".tmp" / "swarm_v5"  # ref.npz (normal training rows), ref_ml_v7.npz (ML v7's q(s)), ambang.json
VERSI = "kc-tema-1"         # the feature configuration (replika.json): unchanged, so older sets resume
VERSI_RUNNER = "kc-tema-2"  # + the iot and aturan stages, rme_bukti, the rule-evidence lane
USD_PER_RAGU = 0.115 / 86  # the gen3_kc2 branch run (data/aip/cabang/runs.json biaya_swarm): $0.115 for 86 RAGU claims
CADANGAN_NARASI = 0.25     # kept for the writer agent (gen3_kc2: $0.006 for 33 exhibits)
SMOKE_USD = 0.05
TAHAP = ("fitur", "zona", "iot", "aturan", "swarm", "laporan", "narasi")
SPECIALS = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")
MIN_DISK_GB = 2.5  # a chunk copies the /testing data (~0.8 GB) and grows its engine store
IOT_SEED = 20261115  # iot_cabang.SEED: --iot-sintetis builds the same synthetic device world for the same set
# cost of the rule-evidence sections (swarm_v5.bagian_aturan), on top of USD_PER_RAGU (measured on dossiers without them):
# 4 model calls read each dossier (3 specialists + the judge), ~3 characters a token (v5.py's guess), $0.30 / M input tokens; the
# judge writes its stance on each finding and a specialist cites it, ~40 output tokens a finding at $1.20 / M; the p3 prompt
# (KONTEKS + roles + the judge's format) adds 6,172 characters per batch of 8 over p2 (3 specialists + the judge), ~2,060 tokens
CHAR_PER_TOKEN, TOKEN_PER_TEMUAN, TOKEN_PROMPT_P3 = 3.0, 40, 2060
T0 = time.time()


def say(*a) -> None:
    print(f"[{(time.time() - T0) / 60:6.1f} min]", *a, flush=True)


def anak_env(**extra: str) -> dict:
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONHASHSEED": "0", "BLUESANDAI_AUTH": "off",
           "TEMP": str(ROOT / ".tmp"), "TMP": str(ROOT / ".tmp")}
    env.update({k: v for k, v in extra.items() if v is not None})
    for k in [k for k, v in extra.items() if v is None]:
        env.pop(k, None)
    return env


# ======================================================================================================== status (for a UI)
BOBOT = {"fitur": 58, "zona": 8, "iot": 3, "aturan": 2, "swarm": 20, "laporan": 8, "narasi": 1}  # share of a full run's wall time, for `persen`
NAMA_TAHAP = {"fitur": "mesin aturan + fitur per replika", "zona": "zona ML v7 dan klaim ragu", "iot": "data pemakaian alat (IoT)",
              "aturan": "temuan rekam medis dan IoT ke AI Agent Swarm", "swarm": "AI Agent Swarm membaca klaim ragu",
              "laporan": "laporan KC dan jaringan klaim", "narasi": "agen penulis"}


class Status:
    """<set>/status.json, rewritten atomically on every change (threads of the fitur stage share it); mirrored to
    <CABANG_BASIS>/<set>/status.json for the app's launcher (web/src/lib/cabangPeluncur.ts reads status, tahap, persen, pesan, run)."""

    def __init__(self, path: Path, awal: dict, cermin: Path | None = None) -> None:
        self.path, self.cermin, self.kunci = path, cermin, threading.Lock()
        self.d = {**awal, "tahap_selesai": [], "status": "berjalan", "persen": 0, "pesan": "mulai", "run": awal.get("set")}
        self.tulis()

    def set(self, **kv) -> None:
        with self.kunci:
            self.d.update(kv)
            self.tulis()

    def selesai_tahap(self, t: str) -> None:
        with self.kunci:
            if t not in self.d["tahap_selesai"]:
                self.d["tahap_selesai"].append(t)
            self.tulis()

    def ringkas(self) -> None:
        """The launcher's fields: overall percent from the stage weights and the stage's own progress, and one plain line."""
        d = self.d
        daftar = d.get("tahap_daftar") or list(TAHAP)
        tot = sum(BOBOT[t] for t in daftar) or 1
        done = sum(BOBOT[t] for t in daftar if t in d["tahap_selesai"])
        t, p = d.get("tahap"), d.get("progres") or {}
        frac = 0.0
        if t == "fitur" and p.get("replika_total"):
            frac = p["replika_selesai"] / p["replika_total"]
        elif t == "swarm" and p.get("batch_total"):
            frac = p["batch"] / p["batch_total"]
        d["persen"] = 100 if d.get("selesai") else round(100 * (done + (BOBOT.get(t, 0) * frac if t else 0)) / tot, 1)
        # the audit's spend so far: the finished steps (usd_terpakai) + the swarm stage still reading (its own counter); the progress line
        # and the live chart both show this one number (2026-11-16: they showed $1.029 and $0.013 for the same moment)
        d["usd_berjalan"] = round(float(d.get("usd_terpakai") or 0) + (float(p.get("usd_tahap_ini") or 0) if t == "swarm" else 0.0), 4)
        if d.get("galat"):
            d["pesan"] = f"Berhenti di tahap {t or '-'}: {d['galat']}"[:300]
        elif d.get("selesai"):
            d["pesan"] = f"Selesai. Biaya model ${d.get('usd_terpakai') or 0:.3f} dari batas ${d.get('usd_batas')}."
        elif d.get("menunggu_kunci"):
            d["pesan"] = f"Menunggu pekerjaan berat lain selesai ({d['menunggu_kunci']})"[:300]
        elif t:
            rinci = (f": replika {p['replika_selesai']}/{p['replika_total']}" if p.get("replika_total") else
                     f": batch {p['batch']}/{p['batch_total']} · ${d['usd_berjalan']:.3f}" if p.get("batch_total") else "")
            d["pesan"] = f"Tahap {NAMA_TAHAP.get(t, t)}{rinci}"

    def tulis(self) -> None:
        self.d["diperbarui"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self.ringkas()
        teks = json.dumps(self.d, ensure_ascii=False, indent=1, default=str)
        for f in (self.path, self.cermin):
            if f is None:
                continue
            try:
                f.parent.mkdir(parents=True, exist_ok=True)
                tmp = f.with_suffix(".tmp")
                tmp.write_text(teks, "utf-8")
                os.replace(tmp, f)
            except OSError:  # a reader holding the file on Windows: the next update writes it
                pass


# ======================================================================================================== the heavy-job lock
class Kunci:
    """.tmp/BERAT.lock (one heavy job at a time on the shared machine), as the other runners take it."""

    def __init__(self, nama: str, st: Status | None, maks_menit: float) -> None:
        self.nama, self.st, self.maks = nama, st, maks_menit
        self.tanda = ""

    def __enter__(self) -> "Kunci":
        t0 = time.time()
        while True:
            try:
                fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except FileExistsError:
                try:
                    isi = LOCK.read_text("utf-8", "replace").strip()
                except OSError:
                    isi = "?"
                if self._basi(isi):
                    # its holder is gone (2026-11-16: "Batalkan" killed a runner, its lock stayed, the next audit waited forever)
                    try:
                        if LOCK.read_text("utf-8", "replace").strip() == isi:
                            LOCK.unlink()
                            say("BERAT.lock basi dilepas (pemegangnya sudah berhenti):", isi)
                    except OSError:
                        pass
                    continue
                if time.time() - t0 > self.maks * 60:
                    raise SystemExit(f"BERAT.lock masih dipegang setelah {self.maks:.0f} menit: {isi}")
                if self.st:
                    self.st.set(menunggu_kunci=isi)
                say("menunggu BERAT.lock:", isi)
                time.sleep(30)
        self.tanda = f"{self.nama} {time.strftime('%Y-%m-%d %H:%M:%S')} pid={os.getpid()}"
        os.write(fd, (self.tanda + "\n").encode("utf-8"))
        os.close(fd)
        if self.st:
            self.st.set(menunggu_kunci=None)
        return self

    @staticmethod
    def _basi(isi: str) -> bool:
        """A lock whose holder process no longer exists: pid=N as this runner writes it, or for an older line of this runner
        (jalan_kc_tema-<audit> <time>) that audit's status.json pid. False whenever it cannot be told (another runner's lock,
        no psutil): then it is waited for as before. A reused pid reads as alive, which only means waiting."""
        try:
            import psutil
        except ImportError:
            return False
        m = re.search(r"\bpid=(\d+)", isi)
        pid = int(m.group(1)) if m else 0
        if not pid:
            m = re.match(r"jalan_kc_tema-([A-Za-z0-9_]+) ", isi)
            if not m:
                return False
            f = Path(os.environ.get("CABANG_BASIS") or ROOT / "data" / "aip" / "cabang") / m.group(1) / "status.json"
            try:
                pid = int(json.loads(f.read_text("utf-8")).get("pid") or 0)
            except (OSError, ValueError, TypeError):
                return False
        return pid > 0 and not psutil.pid_exists(pid)

    def __exit__(self, *a) -> None:
        try:
            if LOCK.read_text("utf-8").strip() == self.tanda:
                LOCK.unlink()
        except OSError:
            pass


def ringkas_sinyal(sinyal) -> dict:
    """The rule engine's signals on the chosen claims, counted as the report's data block counts them (laporan_cabang.indikasi_kc):
    claims with at least one signal, and the most frequent signals. Written to status.json at the zona stage, so the live chart shows
    them while the run goes on (2026-11-16: it showed "bersinyal 0" until the report was written)."""
    sys.path.insert(0, str(ROOT / "api"))
    from aip.realtime import modus as MO

    per: dict[str, int] = {}
    bersinyal = 0
    for t in sinyal:
        s = [x for x in str(t).split() if x in MO.SIGNALS and x != "SKOR_ML"]
        bersinyal += bool(s)
        for x in s:
            per[x] = per.get(x, 0) + 1
    return {"klaim": int(len(sinyal)), "klaim_bersinyal": int(bersinyal),
            "teratas": [{"kode": k, "label": MO.SIGNALS[k][3], "n": n} for k, n in sorted(per.items(), key=lambda x: -x[1])[:8]]}


# ======================================================================================================== dataset helpers
def ringkasan(data: Path) -> dict:
    f = data / "ringkasan.json"
    return json.loads(f.read_text("utf-8")) if f.exists() else {}


def replika_tersedia(data: Path) -> list[int]:
    import pyarrow.parquet as pq

    t = pq.read_table(data / "klaim" / "klaim_semua.parquet", columns=["replika"])
    return sorted({int(x) for x in t.column("replika").to_pylist()})


def parse_replika(teks: str | None, ada: list[int], terakhir: int | None) -> list[int]:
    if terakhir:
        return ada[-terakhir:]
    if not teks or teks.strip().lower() in ("semua", "all"):
        return list(ada)
    out: list[int] = []
    for bagian in teks.split(","):
        bagian = bagian.strip()
        if not bagian:
            continue
        if "-" in bagian:
            a, b = (int(x) for x in bagian.split("-", 1))
            out += list(range(a, b + 1))
        else:
            out.append(int(bagian))
    salah = [r for r in out if r not in ada]
    if salah:
        raise SystemExit(f"replika tidak ada di dataset: {salah}")
    return sorted(dict.fromkeys(out))


def parse_tema(teks: str | None) -> list[str] | None:
    """None = every theme; else the theme codes of laporan_cabang.tema_klaim (validated against laporan_cabang.TEMA)."""
    if not teks or teks.strip().lower() in ("semua", "all", "*"):
        return None
    kode = [x.strip().upper() for x in teks.split(",") if x.strip()]
    tema = nama_tema()
    salah = [k for k in kode if k not in tema]
    if salah:
        raise SystemExit(f"tema tidak dikenal: {salah}; pilihan: {', '.join(f'{k}={v}' for k, v in tema.items())}")
    return sorted(dict.fromkeys(kode))


def nama_tema() -> dict[str, str]:
    sys.path.insert(0, str(HERE)); sys.path.insert(0, str(ROOT / "api"))
    os.environ.setdefault("BLUESANDAI_AUTH", "off")
    import laporan_cabang as LC

    return dict(LC.TEMA)


def laporan_dukung_tema() -> bool:
    """testing/laporan_cabang.py accepts --tema (being added by another session; checked, not assumed)."""
    try:
        return '"--tema"' in (HERE / "laporan_cabang.py").read_text("utf-8")
    except OSError:
        return False


# ======================================================================================================== stage 1 worker: one replica
def chunk(set_dir: Path, nn: int, replika: int, data: Path, rme: bool = True, maks: int | None = None) -> None:
    """One replica through the engine and the feature stream (= testing/uji_gen2.chunk with the dataset's claims)."""
    import sqlite3

    import numpy as np
    import pandas as pd

    sys.path.insert(0, str(HERE))
    import uji100k as U

    data_root = set_dir / f"data_{nn:02d}"
    U.salin(data_root)
    t_salin = time.time()
    say("data copied", data_root.name)
    os.environ["BLUESANDAI_AUTH"] = "off"
    sys.path.insert(0, str(ROOT / "api"))
    from mailer import env
    from aip import vertex

    vertex.configure(data_root, env)
    import platform_lokal

    platform_lokal.pasang()
    import joblib
    from aip import layanan as L
    from aip.realtime import mesin as E
    from aip.realtime import rme as R_
    import fitur as FT

    # aip/realtime/rme._umur: the engine hands the member's birth date as a pandas Timestamp (a date subclass), and
    # date - Timestamp raises, so a claim whose record has no birth date (the empty record of a claim with no visit at all)
    # lost its whole record check in the engine. Normalised here for this run; the fix belongs in rme._umur (d = _tgl(lahir)).
    _umur_asli = R_._umur
    R_._umur = lambda lahir, pada: _umur_asli(R_._tgl(lahir), pada)
    E.ENGINE.start(None)
    while not E.ENGINE.ready():
        if E.ENGINE.error:
            raise RuntimeError(E.ENGINE.error)
        time.sleep(1)
    eng = E.ENGINE
    say("engine ready")
    m = joblib.load(HERE / "model" / "model.joblib")
    ssl = FT.load_ssl(data_root / "aip" / "realtime" / "al")
    con = sqlite3.connect(f"file:{data_root / 'aip' / 'realtime' / 'realtime.sqlite'}?mode=ro", uri=True)
    recs = [json.loads(r) for r, in con.execute("""SELECT p.rec FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                 WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'uji:%' OR p.sumber LIKE 'aug:%') ORDER BY p.seq""")]
    con.close()
    st = FT.Stream(FT.sys_features(recs, ssl), [FT.claim_fields(e) for e in recs], m["mu"], m["sd"])
    say("stream", len(st), "claims (basis)")

    # ---- the replica: every claim of its members in submission order, the labels (appendix only), the members' sex/age
    df = pd.read_parquet(data / "klaim" / "klaim_semua.parquet", filters=[("replika", "==", replika)]).sort_values("urut", kind="stable")
    if maks:
        df = df.head(maks)
    lab = pd.read_parquet(data / "kunci" / "label_fraud.parquet", filters=[("replika", "==", replika)],
                          columns=["kunjungan_fkrtl_id", "skema", "varian", "kerugian_benar_rp"])
    labd = {str(r["kunjungan_fkrtl_id"]): r for r in lab.to_dict("records")}
    pes = pd.read_parquet(data / "peserta" / "peserta.parquet", filters=[("replika", "==", replika)])
    reg = {str(r["peserta_id"]): r for r in pes.to_dict("records")}
    rows = []
    for r in df.to_dict("records"):
        rows.append({k: (None if (v is None or (isinstance(v, float) and v != v) or (v is pd.NaT)) else v) for k, v in r.items()})
    say("replica", replika, len(rows), "claims,", sum(1 for r in rows if labd.get(str(r["kunjungan_fkrtl_id"]), {}).get("skema", "normal") != "normal"), "fraud (key)")

    # ---- the medical records (the theme claims at the branch's hospitals came with one), read as rme_batch.nilai_replika
    meta_rme: dict[str, dict] = {}
    if rme:
        from aip.realtime import rme as R
        from aip.realtime import rme_batch as RB

        # the theme claims at the branch (klaim/klaim_<tema>_<kc>.parquet): the ones the hospital sent with their record
        jan_f = next(f for f in sorted((data / "klaim").glob("klaim_*.parquet")) if f.name != "klaim_semua.parquet")
        jan = pd.read_parquet(jan_f, filters=[("replika", "==", replika)], columns=["kunjungan_fkrtl_id", "peserta_id"])
        reps = {int(x["n"]): x for x in RB.folder_bulk(data)}
        rm_dir = Path(reps[replika]["rm"]) if replika in reps else None
        pasien, obat, by_pid = {}, [], {}
        if rm_dir is not None:
            for r in RB._ndjson(rm_dir):
                rt = r.get("resourceType")
                if rt == "Patient":
                    pasien[r.get("id")] = r
                elif rt == "Medication":
                    obat.append(r)
                else:
                    pid = RB._subjek(r)
                    if pid:
                        by_pid.setdefault(pid, []).append(r)
        no_ke_pid = {}
        for pid, p in pasien.items():
            for i in p.get("identifier") or []:
                if any(w in str(i.get("system") or "").lower() for w in RB.SISTEM_NO_PESERTA) and i.get("value"):
                    no_ke_pid[str(i["value"])] = pid
        kosong = {**R.baca({"resourceType": "Bundle", "entry": []}), "ok": True, "masalah": []}
        cache: dict[str, dict] = {}
        for kid, peserta_id in zip(jan["kunjungan_fkrtl_id"].astype(str), jan["peserta_id"].astype(str)):
            pid = no_ke_pid.get(peserta_id)
            if pid and pid not in cache:
                jk = (reg.get(peserta_id) or {}).get("jenis_kelamin")
                b = {"resourceType": "Bundle", "type": "collection", "entry": [{"resource": x} for x in [pasien[pid], *by_pid.get(pid, []), *obat]]}
                s = R.baca(b, jk)
                if s.get("ok") is False and not s.get("kunjungan"):
                    s = {**s, "ok": True, "masalah": []}
                cache[pid] = s
            meta_rme[kid] = cache[pid] if pid else kosong  # a connected hospital with nothing for this patient: no encounter on record
        say("records:", len(meta_rme), "claims with a SATUSEHAT record,", len(cache), "patients")

    def ke_klaim(b: dict):
        x = {k: v for k, v in b.items() if k in L.KlaimIn.model_fields}
        for k in SPECIALS:
            x[k] = int(x.get(k) or 0)
        x = {k: v for k, v in x.items() if v is not None or k in ("tipe_fkrtl", "prosedur")}
        return L.KlaimIn.model_validate(x)

    objs, metas, keep = [], [], []
    for b in rows:
        try:
            objs.append(ke_klaim(b))
        except Exception as e:  # noqa: BLE001
            say("skipped a claim:", str(e)[:160])
            continue
        kid = str(b["kunjungan_fkrtl_id"])
        metas.append({"rme": meta_rme[kid]} if kid in meta_rme else {})
        keep.append(b)
    t1 = time.time()
    ids = []
    sumber = f"tema:{set_dir.name}:{nn}"
    for a in range(0, len(objs), 2000):
        ids += eng.ingest(objs[a:a + 2000], sumber, metas[a:a + 2000])
        while len(eng.q) > 3000:
            time.sleep(0.5)
    briefs = eng.wait(ids, 3600)
    ok = [k for k, b in enumerate(briefs) if b and b.get("keputusan") not in ("GAGAL", "DIGANTIKAN")]
    say(f"engine judged {len(ok)}/{len(ids)} in {time.time() - t1:.0f} s")
    recs_new = [eng.store.event(ids[k]) for k in ok]
    bs = [keep[k] for k in ok]
    S_new = FT.sys_features(recs_new, ssl)
    r1, r2, rr = [], [], []
    for x, e in zip(S_new, recs_new):
        i = st.append(x, FT.claim_fields(e))
        r1.append(st.agg_row(i)); r2.append(st.s2_row(i)); rr.append(st.r2_row(i))
    import fitur_v4 as F4

    f4 = F4.Fitur4(F4.referensi(), F4.domisili([e.get("peserta") for e in recs] + [e.get("peserta") for e in recs_new]))
    for e in recs:
        f4.tambah(e)
    X4 = np.vstack([f4.tambah(e) for e in recs_new]).astype(np.float32)
    lb = [labd.get(str(b["kunjungan_fkrtl_id"])) or {} for b in bs]
    sk = np.array([str(x.get("skema") or "normal") for x in lb])
    cfg = E.config()
    th_p, th_t = float(cfg["ambang_periksa"]), float(cfg["ambang_tahan"])

    def rme_rute(e: dict) -> tuple[float, str, str]:
        """The medical-record route as /testing V7 computes it (testing/app.rute_rme): the RME_* findings alone."""
        t = [s for s in e.get("sinyal") or [] if str(s.get("kode", "")).startswith("RME_") and float(s.get("kontribusi") or 0) > 0]
        skor = round(100 * (1 - math.exp(-sum(float(s["kontribusi"]) for s in t))), 1)
        return skor, ("TAHAN" if skor >= th_t else "PERIKSA" if skor >= th_p else ""), " ".join(sorted({str(s["kode"]) for s in t}))

    rute = [rme_rute(e) for e in recs_new]

    def rme_bukti(e: dict) -> str:
        """The medical-record findings with their evidence (rme.periksa: plain text with numbers, strength, mitigations), as JSON."""
        out: dict[str, dict] = {}
        for s_ in e.get("sinyal") or []:
            kd = str(s_.get("kode", ""))
            if not kd.startswith("RME_") or (kd in out and out[kd]["s"] >= float(s_.get("s") or 0)):
                continue
            out[kd] = {"bukti": str(s_.get("bukti") or "")[:900], "s": float(s_.get("s") or 0),
                       "mitigasi": [{"kode": str(m.get("kode") or ""), "faktor": float(m.get("faktor") or 0)} for m in s_.get("mitigasi") or [] if isinstance(m, dict)]}
        return json.dumps(out, ensure_ascii=False) if out else ""

    tmp = set_dir / f"hasil_{nn:02d}.tmp.npz"
    np.savez_compressed(
        tmp, sk=sk, y=(sk != "normal").astype(np.int8), varian=np.array([str(x.get("varian") or "") for x in lb]),
        X1=np.vstack(r1).astype(np.float32), X2=np.vstack(r2).astype(np.float32), XR=np.vstack(rr).astype(np.float32), X4=X4,
        keputusan=np.array([str(e.get("keputusan")) for e in recs_new]), skor_rule=np.array([float(e.get("skor") or 0) for e in recs_new]),
        sinyal=np.array([" ".join(sorted({str(s.get("kode")) for s in (e.get("sinyal") or [])})) for e in recs_new]),
        tingkat=np.array([str(b["tingkat_pelayanan"]) for b in bs]), kode=np.array([str(b["inacbg_kode"]) for b in bs]),
        los=np.array([int(b.get("los_hari") or 0) for b in bs]), biaya=np.array([int(b["biaya_tagih_rp"]) for b in bs]),
        tarif=np.array([int(b.get("tarif_inacbg_rp") or 0) for b in bs]), dxs=np.array([int(b.get("jumlah_dx_sekunder") or 0) for b in bs]),
        topup=np.array([sum(int(b.get(s) or 0) for s in SPECIALS) for b in bs]), prosedur=np.array([b.get("prosedur") is not None for b in bs]),
        kelas=np.array([str(b.get("kelas_rawat")) for b in bs]),
        riwayat=np.array([str((reg.get(str(b["peserta_id"])) or {}).get("asal") or "") not in ("", "baru") for b in bs]),
        peserta=np.array([str(e.get("peserta")) for e in recs_new]), faskes=np.array([str(e.get("faskes")) for e in recs_new]),
        tgl=np.array([str(e.get("tgl_datang"))[:10] for e in recs_new]),
        dx=np.array([str(b.get("dx_primer_icd3") or "") for b in bs]), dx_nama=np.array([str(b.get("dx_primer_nama") or "") for b in bs]),
        # this runner's extra fields (the report reads only the ones above)
        kunjungan=np.array([str(b["kunjungan_fkrtl_id"]) for b in bs]), replika=np.full(len(bs), replika, np.int16),
        tema_data=np.array([str(b.get("tema") or "") for b in bs]), rs_di_kc=np.array([bool(b.get("rs_di_kc")) for b in bs]),
        faskes_data=np.array([str(b.get("faskes_profil") or "") for b in bs]),
        rme_ada=np.array([bool(e.get("rme")) for e in recs_new]), rme_skor=np.array([x[0] for x in rute], np.float32),
        rme_tingkat=np.array([x[1] for x in rute]), rme_sinyal=np.array([x[2] for x in rute]), rme_bukti=np.array([rme_bukti(e) for e in recs_new]),
        kerugian_benar=np.array([int(x.get("kerugian_benar_rp") or 0) for x in lb], np.int64))
    os.replace(tmp, set_dir / f"hasil_{nn:02d}.npz")
    y = sk != "normal"
    beda = sum(1 for e, b in zip(recs_new, bs) if str(e.get("faskes")) != str(b.get("faskes_profil") or e.get("faskes")))
    say(f"chunk {nn}: claims {len(sk)}, fraud {int(y.sum())}, replica {replika}, records {int(sum(bool(e.get('rme')) for e in recs_new))}, "
        f"RME route {sum(1 for x in rute if x[1])}, engine faskes != dataset faskes_profil {beda}, "
        f"PERIKSA/TAHAN on fraud {np.isin([str(e.get('keputusan')) for e in recs_new], ['PERIKSA', 'TAHAN'])[y].mean() if y.any() else 0:.2f}, "
        f"{time.time() - t_salin:.0f} s after the copy")
    eng.stop() if hasattr(eng, "stop") else None


# ======================================================================================================== the IoT input check
IOT_JENIS = ("ventilator", "hemodialisis", "monitor_icu", "pompa_infus", "gateway")
IOT_WAJIB = {"alat": ("device_id", "jenis", "faskes_profil_id"), "sesi": ("sesi_id", "device_id", "peserta", "kunjungan", "mulai"),
             "pembacaan": ("ts", "device_id", "seq", "interval_s", "arus_a", "reading_hash")}


def _iot_tabel(d: Path, nama: str) -> tuple[str | None, list[dict]]:
    """A table of the IoT input folder as testing/iot_cabang.py reads it (json, csv or parquet; the first that exists)."""
    import pandas as pd

    for ext in ("json", "csv", "parquet"):
        f = d / f"{nama}.{ext}"
        if not f.exists():
            continue
        if ext == "json":
            x = json.loads(f.read_text("utf-8"))
            return f.name, x if isinstance(x, list) else next((v for v in x.values() if isinstance(v, list)), [])
        if ext == "csv":
            return f.name, pd.read_csv(f, dtype=str, keep_default_na=False).to_dict("records")
        return f.name, pd.read_parquet(f).to_dict("records")
    return None, []


def validasi_iot(d: Path) -> dict:
    """An IoT input folder (docs/IOT_FORMAT_MASUKAN.md) before the checker reads it: per file the rows, the rows the checker cannot
    use and why (missing fields, unknown device or session, bad time, a reading whose sha256 does not match its fields), and the
    problems that stop the run (no devices, sessions or readings: every device-billing claim would look unused)."""
    from datetime import datetime

    sys.path.insert(0, str(HERE))
    import iot_cabang as IC

    def waktu(v) -> bool:
        try:
            datetime.fromisoformat(str(v).replace("Z", "+00:00"))
            return True
        except ValueError:
            return False

    out: dict = {"folder": str(d), "berkas": {}, "fatal": [], "peringatan": []}
    if not d.is_dir():
        out["fatal"].append(f"{d} bukan folder")
        return out
    man = d / "manifest.json"
    if man.exists():
        try:
            m = json.loads(man.read_text("utf-8"))
            out["manifest"] = {k: m.get(k) for k in ("format", "run", "kc", "sintetis", "periode")}
            if str(m.get("format") or "").split("/")[0] != "iot-cabang":
                out["peringatan"].append(f"manifest.json format {m.get('format')!r}, diharapkan iot-cabang/1")
        except ValueError:
            out["peringatan"].append("manifest.json tidak terbaca")
    else:
        out["peringatan"].append("tidak ada manifest.json (format dianggap iot-cabang/1)")
    alat_id: set[str] = set()
    sesi_id: set[str] = set()
    for nama in ("alat", "sesi", "pembacaan"):
        f, rows = _iot_tabel(d, nama)
        if f is None:
            out["fatal"].append(f"{nama}.(csv|json|parquet) tidak ada")
            continue
        alasan: dict[str, int] = {}

        def tolak(why: str) -> None:
            alasan[why] = alasan.get(why, 0) + 1

        seen: set[str] = set()
        ok = 0
        for r in rows:
            kurang = [k for k in IOT_WAJIB[nama] if str(r.get(k) if r.get(k) is not None else "").strip() in ("", "nan", "None")]
            if kurang:
                tolak("kolom kosong: " + ",".join(kurang))
                continue
            if nama == "alat":
                if str(r["jenis"]) not in IOT_JENIS:
                    tolak(f"jenis alat tidak dikenal ({str(r['jenis'])[:20]})")
                    continue
                if str(r["device_id"]) in seen:
                    tolak("device_id ganda")
                    continue
                seen.add(str(r["device_id"]))
                alat_id.add(str(r["device_id"]))
            elif nama == "sesi":
                if str(r["device_id"]) not in alat_id:
                    tolak("alat tidak ada di alat")
                    continue
                if not waktu(r["mulai"]) or (str(r.get("selesai") or "").strip() not in ("", "nan", "None") and not waktu(r["selesai"])):
                    tolak("waktu mulai/selesai tidak terbaca")
                    continue
                if str(r.get("selesai") or "").strip() not in ("", "nan", "None") and str(r["selesai"]) < str(r["mulai"]):
                    tolak("selesai sebelum mulai")
                    continue
                if str(r["sesi_id"]) in seen:
                    tolak("sesi_id ganda")
                    continue
                seen.add(str(r["sesi_id"]))
                sesi_id.add(str(r["sesi_id"]))
            else:
                if str(r["device_id"]) not in alat_id:
                    tolak("alat tidak ada di alat")
                    continue
                sid = str(r.get("sesi_id") or "").strip()
                if sid not in ("", "nan", "None") and sid not in sesi_id:
                    tolak("sesi tidak ada di sesi")
                    continue
                try:
                    if float(r["interval_s"]) <= 0 or float(r["arus_a"]) < 0:
                        tolak("interval_s <= 0 atau arus_a < 0")
                        continue
                    rr = {**r, "sesi_id": "" if sid in ("nan", "None") else sid}
                    if not rr.get("mode"):
                        rr["mode"] = ""
                    if rr["mode"] and IC.sha(IC.kanon_baca(rr)) != str(r["reading_hash"]):
                        tolak("reading_hash tidak cocok (pembacaan diubah atau kanonisasi berbeda)")
                        continue
                except (TypeError, ValueError):
                    tolak("angka tidak terbaca")
                    continue
                if not waktu(r["ts"]):
                    tolak("ts tidak terbaca")
                    continue
            ok += 1
        out["berkas"][f] = {"baris": len(rows), "dipakai": ok, "ditolak": len(rows) - ok, "alasan": alasan}
        if rows and not ok:
            out["fatal"].append(f"{f}: tidak ada baris yang bisa dipakai")
        elif not rows:
            out["fatal"].append(f"{f}: kosong")
    for nama in ("jangkar.json", "klaim_alat.json", "klaim_alat.csv"):
        f = d / nama
        if f.exists():
            try:
                x = json.loads(f.read_text("utf-8")) if nama.endswith(".json") else None
                n = len((x.get("jangkar") if nama == "jangkar.json" else x.get("klaim")) or []) if isinstance(x, dict) else (len(x) if isinstance(x, list) else None)
                if n is None:
                    n = len(_iot_tabel(d, "klaim_alat")[1])
                out["berkas"][nama] = {"baris": n, "dipakai": n, "ditolak": 0, "alasan": {}}
            except ValueError:
                out["peringatan"].append(f"{nama} tidak terbaca")
    if not (d / "jangkar.json").exists():
        out["peringatan"].append("tidak ada jangkar.json: tidak ada temuan IoT yang terverifikasi (jalur bukti aturan tertutup untuk IoT)")
    return out


# ======================================================================================================== stage 2 worker: fake swarm
def swarm_palsu(kerja: Path, nama: str, masuk: Path, keluar: Path, agen_out: Path) -> None:
    """--dry-run: the ADK tree of testing/swarm_v5_adk.py with an offline fake model (no network, no cost). Runs under .venv-adk
    (stdlib + google.adk only). The answers say "uji kering" and live in this dry-run folder's own cache."""
    os.environ["SWARM_V5_KERJA"] = str(kerja)
    sys.path.insert(0, str(HERE))
    import asyncio

    import swarm_v5_adk as SA
    from google.adk.models.base_llm import BaseLlm
    from google.genai import types
    from google.adk.models.llm_response import LlmResponse

    assert SA.CACHE.parent.resolve() == kerja.resolve(), SA.CACHE
    FAM = ("koding", "tagihan", "episode", "identitas", "jaringan", "normal")

    class Palsu(BaseLlm):
        async def generate_content_async(self, llm_request, stream: bool = False):  # noqa: ANN001
            teks = " ".join(p.text or "" for c in llm_request.contents for p in (c.parts or []) if getattr(p, "text", None))
            bagian = re.split(r"\[(K\d+)\]\n", teks)
            per = {bagian[i]: bagian[i + 1] for i in range(1, len(bagian) - 1, 2)}
            out = []
            for k in sorted(per, key=lambda x: int(x[1:])):
                h = int(hashlib.md5(per[k].encode()).hexdigest()[:8], 16)
                # every rule finding [Rn ...] answered, accepted or rejected by a hash (plumbing only: no model judged it)
                sikap = [{"id": r_, "sikap": "tolak" if int(hashlib.md5((per[k] + r_).encode()).hexdigest()[:4], 16) % 3 == 0 else "terima",
                          "alasan": "uji kering"} for r_ in dict.fromkeys(re.findall(r"\[(R\d+) ·", per[k]))]
                out.append({"id": k, "bukti": "uji kering: tidak dibaca model", "p": round((h % 1000) / 1000, 3), "famili": FAM[h % len(FAM)],
                            "alasan": "uji kering (tanpa model AI)", "aturan": sikap})
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=json.dumps({"klaim": out}))]))

    klaim = [json.loads(x) for x in masuk.read_text("utf-8").splitlines() if x.strip()]
    r = asyncio.run(SA.jalankan(nama, klaim, lambda: Palsu(model="uji-kering"), 1.0, 4, SA.CACHE, lambda s: print(s, flush=True)))
    r["biaya"] = {**r["biaya"], "usd_perkiraan": 0.0, "uji_kering": True}
    keluar.write_text(json.dumps({"set": nama, "versi": SA.VERSI, "model": "uji kering (tanpa model AI)", **r}, ensure_ascii=False), "utf-8")
    e = SA.ekspor(nama, klaim)
    agen_out.write_text(json.dumps(e, ensure_ascii=False), "utf-8")
    print("biaya", json.dumps(r["biaya"]), "| hasil", len(r["hasil"]), "klaim ->", keluar, "| ekspor", len(e), flush=True)


# ======================================================================================================== the runner
class Runner:
    def __init__(self, a: argparse.Namespace) -> None:
        self.a = a
        if a.dataset:  # the app's launcher passes a folder of "Data Sintetis/" (or "gen3")
            if a.dataset == "gen3":
                raise SystemExit("dataset gen3 (batch generator 3) memakai alur uji_gen2.py + v5.py + laporan_cabang.py, bukan runner ini")
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", a.dataset):
                raise SystemExit(f"nama dataset tidak sah: {a.dataset}")
            a.data = str(ROOT / "Data Sintetis" / a.dataset)
        if not re.fullmatch(r"[a-z0-9_]{3,40}", a.set):
            raise SystemExit(f"--set harus ^[a-z0-9_]{{3,40}}$: {a.set}")
        self.data = Path(a.data).resolve()
        if not (self.data / "klaim" / "klaim_semua.parquet").exists():
            raise SystemExit(f"{self.data}: bukan dataset tema (tidak ada klaim/klaim_semua.parquet)")
        self.rk = ringkasan(self.data)
        self.kc = a.kc or self.rk.get("kc") or ""
        if self.rk.get("kc") and self.kc != self.rk["kc"]:
            raise SystemExit(f"--kc {self.kc}: dataset ini hanya untuk {self.rk['kc']} (kolom rs_di_kc)")
        self.set = a.set
        self.dir = AKAR / a.set
        self.dir.mkdir(parents=True, exist_ok=True)
        self.dry = bool(a.dry_run)
        self.kerja = self.dir / ("swarm_kering" if self.dry else "swarm_v5")
        self.kerja_lain = self.dir / ("swarm_v5" if self.dry else "swarm_kering")
        self.tema = parse_tema(a.tema)
        if a.iot and a.iot_sintetis:
            raise SystemExit("pilih satu sumber data IoT: --iot <folder> atau --iot-sintetis")
        if a.iot and not Path(a.iot).is_dir():
            raise SystemExit(f"--iot {a.iot}: folder tidak ada")
        self.ada = replika_tersedia(self.data)
        self.replika = parse_replika(a.replika, self.ada, a.replika_terakhir)
        self.tahap = [t for t in TAHAP if t in (a.tahap.split(",") if a.tahap else TAHAP)]
        self.basis = (self.dir / "cabang") if (self.dry and not a.tulis_app) else None  # None = the app's data/aip/cabang
        nm = nama_tema()
        tema_txt = "semua tema" if not self.tema else ", ".join(f"{t} {nm.get(t, t)}" for t in self.tema)
        self.label = a.label or (f"{'UJI KERING · ' if self.dry else ''}{self.rk.get('kc_nama', self.kc)} · {tema_txt} · "
                                 f"{len(self.replika)} ulangan setahun · {time.strftime('%Y-%m-%d %H:%M')} ({self.set})")
        # the app's copy of the status: the branch data folder the report goes to (the launcher sets CABANG_BASIS); a dry run
        # writes there only when its report does (--tulis-app)
        app = Path(os.environ.get("CABANG_BASIS") or ROOT / "data" / "aip" / "cabang")
        cermin = None if self.basis else app / self.set / "status.json"
        self.st = Status(self.dir / "status.json", {
            "set": self.set, "versi": VERSI, "mode": "uji_kering" if self.dry else "nyata", "label": self.label, "kc": self.kc,
            "tema": self.tema or "semua", "data": str(self.data), "replika": self.replika, "tahap_daftar": self.tahap, "tahap": None,
            "usd_batas": a.batas_usd, "galat": None, "selesai": False, "pid": os.getpid(), "mulai": time.strftime("%Y-%m-%d %H:%M:%S"),
            "rme": not a.tanpa_rme, "folder": str(self.dir), "usd_terpakai": None, "versi_runner": VERSI_RUNNER,
            "iot_sumber": "sintetis" if a.iot_sintetis else (str(Path(a.iot).resolve()) if a.iot else None)}, cermin)
        self.st.set(usd_terpakai=round(self.terpakai(), 4))

    # ------------------------------------------------------------------------------------------------ helpers
    def hasil_npz(self) -> list[Path]:
        return sorted(self.dir.glob("hasil_[0-9][0-9].npz"))

    def env_pipa(self) -> dict:
        return anak_env(UJI_SET_ROOT=str(AKAR), SWARM_V5_KERJA=str(self.kerja), CABANG_BASIS=str(self.basis) if self.basis else None)

    def jalankan_proses(self, args: list[str], log: Path, env: dict, on_line=None) -> tuple[int, list[str]]:
        """A child process, its output to a log file (and the last lines kept), each line to on_line."""
        ekor: list[str] = []
        with log.open("a", encoding="utf-8") as fh:
            fh.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(str(x) for x in args)}\n")
            p = subprocess.Popen([str(x) for x in args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(ROOT),
                                 text=True, encoding="utf-8", errors="replace")
            for line in p.stdout:  # type: ignore[union-attr]
                fh.write(line); fh.flush()
                ekor = (ekor + [line.rstrip()])[-40:]
                if on_line:
                    on_line(line.rstrip())
            p.wait()
        return p.returncode, ekor

    def terpakai(self) -> float:
        f = self.kerja / "biaya_runner.json"
        return sum(float(x.get("usd") or 0) for x in json.loads(f.read_text("utf-8"))) if f.exists() else 0.0

    def catat_biaya(self, langkah: str, b: dict) -> None:
        f = self.kerja / "biaya_runner.json"
        rows = json.loads(f.read_text("utf-8")) if f.exists() else []
        rows.append({"langkah": langkah, "waktu": time.strftime("%Y-%m-%d %H:%M:%S"), "usd": float(b.get("usd_perkiraan") or 0), "biaya": b})
        f.write_text(json.dumps(rows, ensure_ascii=False, indent=1), "utf-8")
        self.st.set(usd_terpakai=round(self.terpakai(), 4))

    # ------------------------------------------------------------------------------------------------ stage 1: fitur
    def fitur(self) -> None:
        konf = {"versi": VERSI, "data": str(self.data), "replika": self.replika, "rme": not self.a.tanpa_rme, "maks_klaim": self.a.maks_klaim}
        kf = self.dir / "replika.json"
        if kf.exists():
            lama = json.loads(kf.read_text("utf-8"))
            if {k: lama.get(k) for k in konf} != konf:
                raise SystemExit(f"{self.dir} sudah berisi fitur dengan konfigurasi lain ({kf}); pakai --set lain atau --ulang")
        kf.write_text(json.dumps({**konf, "nn": {f"{n:02d}": r for n, r in enumerate(self.replika)}}, ensure_ascii=False, indent=1), "utf-8")
        tugas = [(n, r) for n, r in enumerate(self.replika)]
        selesai = {n for n, _ in tugas if self._chunk_ok(n)}
        self.st.set(progres={"replika_selesai": len(selesai), "replika_total": len(tugas)})
        sisa = [(n, r) for n, r in tugas if n not in selesai]
        if not sisa:
            say("fitur: semua replika sudah ada")
            return
        galat: list[str] = []
        kunci = threading.Lock()

        def kerja(nr: tuple[int, int]) -> None:
            n, r = nr
            if galat:
                return
            ok = self._satu_chunk(n, r)
            with kunci:
                if ok:
                    selesai.add(n)
                else:
                    galat.append(f"replika {r} (hasil_{n:02d}) gagal 3 kali; lihat {self.dir / f'log_{n:02d}.txt'}")
                self.st.set(progres={"replika_selesai": len(selesai), "replika_total": len(tugas)})

        with Kunci(f"jalan_kc_tema-{self.set}", self.st, self.a.tunggu_kunci):
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(max_workers=max(1, self.a.paralel_chunk)) as ex:
                list(ex.map(kerja, sisa))
        if galat:
            raise SystemExit("; ".join(galat))

    def _chunk_ok(self, n: int) -> bool:
        f, log = self.dir / f"hasil_{n:02d}.npz", self.dir / f"log_{n:02d}.txt"
        return f.exists() and log.exists() and f"chunk {n}: claims" in log.read_text("utf-8", "replace")

    def _satu_chunk(self, n: int, r: int) -> bool:
        log = self.dir / f"log_{n:02d}.txt"
        for coba in range(3):  # the native access violation (0xC0000005) hits a chunk now and then (testing/uji_gen2.py)
            bebas = shutil.disk_usage(self.dir).free / 2**30
            if bebas < MIN_DISK_GB:
                say(f"disk tinggal {bebas:.1f} GB (< {MIN_DISK_GB} GB): berhenti")
                return False
            say(f"replika {r} -> hasil_{n:02d}" + (f" (ulang {coba})" if coba else ""))
            args = [PY, Path(__file__), "_chunk", "--set-dir", self.dir, "--nn", n, "--replika-satu", r, "--data", self.data]
            if self.a.tanpa_rme:
                args.append("--tanpa-rme")
            if self.a.maks_klaim:
                args += ["--maks-klaim", self.a.maks_klaim]
            with log.open("w", encoding="utf-8") as fh:
                subprocess.run([str(x) for x in args], stdout=fh, stderr=subprocess.STDOUT, env=anak_env(), cwd=str(ROOT))
            shutil.rmtree(self.dir / f"data_{n:02d}", ignore_errors=True)
            if self._chunk_ok(n):
                say((log.read_text("utf-8", "replace").strip().splitlines() or [""])[-1][:240])
                return True
            say(f"hasil_{n:02d} gagal:", (log.read_text("utf-8", "replace").strip().splitlines() or [""])[-1][:200])
        return False

    # ------------------------------------------------------------------------------------------------ stage 2: zona
    def zona(self) -> None:
        self.kerja.mkdir(parents=True, exist_ok=True)
        for nm in ("ref.npz", "ref_ml_v7.npz", "ambang.json"):
            if not (self.kerja / nm).exists():
                shutil.copy2(REF_SWARM / nm, self.kerja / nm)
        files = self.hasil_npz()
        if len(files) != len(self.replika):
            raise SystemExit(f"fitur belum lengkap: {len(files)} dari {len(self.replika)} replika")
        t_fitur = max(f.stat().st_mtime for f in files)
        zf = self.kerja / f"zona_{self.set}.npz"
        lain = self.kerja_lain / f"zona_{self.set}.npz"
        if zf.exists() and zf.stat().st_mtime > t_fitur and not self.a.ulang_zona:
            say("zona: sudah ada")
        elif lain.exists() and lain.stat().st_mtime > t_fitur and not self.a.ulang_zona:  # zones are model-only: shared by dry and real runs
            for nm in (f"zona_{self.set}.npz", f"zona_{self.set}.json", f"berkas_{self.set}.jsonl"):
                shutil.copy2(self.kerja_lain / nm, self.kerja / nm)
            say("zona: disalin dari", self.kerja_lain.name)
        else:
            rc, ekor = self.jalankan_proses([PY, HERE / "v5.py", "siapkan", "--set", self.set, "--model", "ml_v7"], self.dir / "log_zona.txt",
                                            self.env_pipa(), lambda s: self.st.set(menunggu_kunci=s) if "waiting for BERAT.lock" in s else None)
            self.st.set(menunggu_kunci=None)
            if rc != 0 or not zf.exists():
                raise SystemExit("v5.py siapkan gagal: " + " | ".join(ekor[-5:]))
            say("zona:", ekor[-1][:300])
        self.perkiraan()

    def perkiraan(self, aturan: dict | None = None) -> dict:
        """Per theme at the branch: claims, TAHAN, RAGU (what the swarm would read) and the estimated cost; the swarm's input file.
        aturan (the aturan stage): the rule-routed claims (rute: ML said LOLOS, a rule finding >= KUAT_RUTE), the evidence lane
        (bukti), and every dossier with its rule sections (teks, n_temuan): they are read too, priced by their own length, and
        over the cap the evidence lane goes first, then the ML score."""
        import numpy as np

        sys.path.insert(0, str(HERE)); sys.path.insert(0, str(ROOT / "api"))
        import laporan_cabang as LC

        z = dict(np.load(self.kerja / f"zona_{self.set}.npz", allow_pickle=False))
        files = self.hasil_npz()
        kol = {}
        for nm in ("dx", "kode", "rs_di_kc", "biaya", "replika", "sinyal"):
            parts = []
            for f in files:
                with np.load(f, allow_pickle=False) as d:
                    parts.append(d[nm])
            kol[nm] = parts
        cp = np.array([[int(x) for x in k.split(":")[1:]] for k in z["kunci"]])
        ambil = lambda nm: np.array([kol[nm][c][i] for c, i in cp])  # noqa: E731
        dx, kode, di_kc, biaya = ambil("dx").astype(str), ambil("kode").astype(str), ambil("rs_di_kc").astype(bool), ambil("biaya").astype(float)
        tema = np.array([LC.tema_klaim(a, b) for a, b in zip(dx, kode)])
        tahan, ragu, y = z["tahan"].astype(bool), z["ragu"].astype(bool), z["y"].astype(int)
        kunci = z["kunci"].astype(str)
        rute = np.zeros(len(kunci), bool) if aturan is None else np.isin(kunci, list(aturan["rute"]))
        lajur = np.zeros(len(kunci), bool) if aturan is None else np.isin(kunci, list(aturan["bukti"]))
        baca = ragu | rute
        teks = (aturan or {}).get("teks") or {}
        n_tem = (aturan or {}).get("n_temuan") or {}
        basis_len = (aturan or {}).get("panjang_dasar") or 0.0

        def usd_klaim(k: str) -> float:
            """One claim's swarm cost: the measured base, plus its rule sections read by 4 agents and the stance on each finding."""
            if not teks or k not in teks:
                return USD_PER_RAGU
            extra = max(0.0, len(teks[k]) - basis_len) / CHAR_PER_TOKEN
            return USD_PER_RAGU + 4 * extra * 0.30 / 1e6 + n_tem.get(k, 0) * TOKEN_PER_TEMUAN * 1.20 / 1e6 + TOKEN_PROMPT_P3 * 0.30 / 1e6 / 8

        usd = np.array([usd_klaim(k) if b else 0.0 for k, b in zip(kunci, baca)])
        # the whole dataset's theme claims at the branch, to scale a subset of replicas
        import pandas as pd

        semua = pd.read_parquet(self.data / "klaim" / "klaim_semua.parquet", columns=["dx_primer_icd3", "inacbg_kode", "rs_di_kc", "replika"])
        semua = semua[semua.rs_di_kc.astype(bool)]
        t_all = pd.Series([LC.tema_klaim(str(a or ""), str(b or "")) for a, b in zip(semua.dx_primer_icd3, semua.inacbg_kode)]).value_counts().to_dict()
        n_rep_all = len(self.ada)
        rows = []
        for t in sorted(set(tema[di_kc]), key=lambda t: -int(((tema == t) & di_kc).sum())):
            m = (tema == t) & di_kc
            n, nr, nb = int(m.sum()), int((m & ragu).sum()), int((m & baca).sum())
            skala = (t_all.get(t, 0) / n) if n else 0.0
            u = float(usd[m & baca].sum())
            rows.append({"tema": t, "nama": LC.TEMA.get(t, t), "klaim": n, "tahan": int((m & tahan).sum()), "ragu": nr,
                         "ragu_pct": round(100 * nr / n, 2) if n else 0.0, "rute_aturan": int((m & rute).sum()), "jalur_bukti_aturan": int((m & lajur).sum()),
                         "dibaca_swarm": nb, "fraud_kunci": int(y[m].sum()), "nilai_rp": int(biaya[m].sum()),
                         "usd_perkiraan": round(u, 3), "klaim_dataset": int(t_all.get(t, 0)),
                         "ragu_dataset_perkiraan": int(round(nb * skala)), "usd_dataset_perkiraan": round(u * skala, 2)})
        pilih = di_kc & (np.isin(tema, self.tema) if self.tema else True)
        self.st.set(sinyal=ringkas_sinyal(ambil("sinyal").astype(str)[pilih]))
        idx = np.flatnonzero(pilih & baca)
        budget = max(0.0, self.a.batas_usd - self.terpakai() - CADANGAN_NARASI - SMOKE_USD) if not self.dry else self.a.batas_usd - CADANGAN_NARASI - SMOKE_USD
        # priority under the cap: the rule-evidence lane first (strongest finding first), then the ML score
        k_at = np.array([float((aturan or {}).get("k_aturan", {}).get(k, 0.0)) for k in kunci])
        idx = idx[np.lexsort((-z["s"][idx], -k_at[idx], ~lajur[idx]))]
        cum = np.cumsum(usd[idx])
        dipotong = bool(len(idx) and cum[-1] > budget * 0.9)
        if dipotong:  # the budget cannot read them all: the rest stay unread, said so
            idx = idx[cum <= budget * 0.9]
        kunci_pilih = {str(kunci[i]) for i in idx}
        src = self.kerja / f"berkas_{self.set}.jsonl"
        out = self.kerja / f"berkas_{self.set}_swarm.jsonl"
        if out.exists() and self.terpakai() > 0 and not self.a.ulang_zona:
            # the swarm already spent on this input: keep it as it is (the batches, and so the cache, follow its content)
            n_out = sum(1 for x in out.read_text("utf-8").splitlines() if x.strip())
            say("zona: input swarm yang sudah dibayar dipertahankan:", out.name, n_out, "klaim")
        else:
            n_out = 0
            with out.open("w", encoding="utf-8") as fh:
                if teks:
                    for i in idx:  # the priority order; the swarm shuffles batches itself
                        fh.write(json.dumps({"kunci": str(kunci[i]), "teks": teks[str(kunci[i])]}, ensure_ascii=False) + "\n"); n_out += 1
                else:
                    for line in src.read_text("utf-8").splitlines():
                        if line.strip() and json.loads(line)["kunci"] in kunci_pilih:
                            fh.write(line + "\n"); n_out += 1
        sel = {"tema": self.tema or "semua", "klaim": int(pilih.sum()), "tahan": int((pilih & tahan).sum()), "ragu": int((pilih & ragu).sum()),
               "rute_aturan": int((pilih & rute).sum()), "jalur_bukti_aturan": int((pilih & lajur).sum()),
               "dikirim_ke_swarm": n_out, "tidak_dibaca_karena_batas": int((pilih & baca).sum()) - n_out,
               "usd_perkiraan": round(float(usd[idx].sum()), 3), "usd_perkiraan_semua_ragu": round(float(usd[pilih & baca].sum()), 3),
               "usd_per_klaim_rata": round(float(usd[idx].mean()), 6) if len(idx) else 0.0,
               "panggilan_model": 4 * -(-n_out // 8), "batch": -(-n_out // 8)}
        rep = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "set": self.set, "kc": self.kc, "replika": self.replika, "replika_dataset": n_rep_all,
               "usd_per_ragu": round(USD_PER_RAGU, 6), "dasar_usd": "gen3_kc2: $0.115 untuk 86 klaim RAGU (4 panggilan model per batch 8 klaim)"
               + ("; + bagian temuan aturan per berkas (panjangnya sendiri, 4 agen membaca, ~40 token sikap hakim per temuan) + prompt p3" if teks else ""),
               "semua_klaim_zona": {"klaim": int(len(tahan)), "tahan": int(tahan.sum()), "ragu": int(ragu.sum()), "di_kc": int(di_kc.sum())},
               "pilihan": sel, "per_tema": rows,
               "semua_tema_kc": {"klaim": int(di_kc.sum()), "ragu": int((di_kc & ragu).sum()), "rute_aturan": int((di_kc & rute).sum()),
                                 "usd_perkiraan": round(float(usd[di_kc & baca].sum()) if teks else int((di_kc & ragu).sum()) * USD_PER_RAGU, 2),
                                 "ragu_dataset_perkiraan": int(sum(r["ragu_dataset_perkiraan"] for r in rows)),
                                 "usd_dataset_perkiraan": round(sum(r["usd_dataset_perkiraan"] for r in rows), 2)},
               "berkas_swarm": str(out)}
        if aturan is not None:
            rep["catatan_aturan"] = ("semua_tema_kc.usd_perkiraan hanya menghitung bagian temuan aturan untuk tema terpilih; klaim tema lain "
                                     "dihitung dengan biaya dasar" if self.tema else "")
        (self.dir / "perkiraan.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), "utf-8")
        self.st.set(perkiraan={"pilihan": sel, "semua_tema_kc": rep["semua_tema_kc"]})
        lewat = f" + {sel['rute_aturan']} lewat aturan" if aturan is not None else ""
        say(f"{'aturan' if aturan is not None else 'zona'}: pilihan {sel['tema']}: {sel['klaim']} klaim di KC, TAHAN {sel['tahan']}, RAGU {sel['ragu']}{lewat}"
            f" -> swarm {n_out} (~${sel['usd_perkiraan']:.2f}); semua tema KC: RAGU {rep['semua_tema_kc']['ragu']} (~${rep['semua_tema_kc']['usd_perkiraan']:.2f})")
        return rep

    # ------------------------------------------------------------------------------------------------ stage 3: iot
    def iot_akar(self) -> Path:
        """<cabang>/iot/<set>: where testing/iot_cabang.py writes (its basis_iot(): CABANG_BASIS, which env_pipa sets for a dry run)."""
        return (self.basis or ROOT / "data" / "aip" / "cabang") / "iot" / self.set

    def iot(self) -> None:
        akar = self.iot_akar()
        if not (self.a.iot or self.a.iot_sintetis):
            lama = akar / "bukti.json"
            self.st.set(iot={"sumber": None, "hasil_lama": str(lama) if lama.exists() else None})
            if lama.exists():  # the report reads it whatever this run says: the agents see it too (tahap aturan), and the user is told
                self.st.set(peringatan=f"Tanpa --iot / --iot-sintetis, tetapi hasil IoT run sebelumnya ada di {akar} dan ikut dibaca laporan serta swarm; "
                                       "hapus folder itu untuk audit tanpa IoT.")
                say("iot: tanpa sumber baru; hasil IoT lama dipakai:", lama)
            else:
                say("iot: tanpa data IoT (tahap dilewati)")
            return
        env = self.env_pipa()
        IOT = HERE / "iot_cabang.py"
        if self.a.iot_sintetis:
            masuk = akar / "masukan"
            man = masuk / "manifest.json"
            t_fitur = max(f.stat().st_mtime for f in self.hasil_npz())
            lama = json.loads(man.read_text("utf-8")) if man.exists() else {}
            if lama.get("run") == self.set and int(lama.get("seed") or -1) == self.a.iot_seed and man.stat().st_mtime > t_fitur and not self.a.ulang_iot:
                say("iot: data sintetis sudah ada (benih", self.a.iot_seed, ")")
            else:
                rc, ekor = self.jalankan_proses([PY, IOT, "generate", "--set", self.set, "--kc", self.kc, "--seed", self.a.iot_seed], self.dir / "log_iot.txt", env)
                if rc != 0 or not man.exists():
                    raise SystemExit("iot_cabang.py generate gagal: " + " | ".join(ekor[-5:]))
                say("iot:", next((x for x in ekor if x.startswith("iot generate")), ekor[-1] if ekor else "")[:300])
        else:
            masuk = Path(self.a.iot).resolve()
        cek = validasi_iot(masuk)
        (self.dir / "iot_validasi.json").write_text(json.dumps(cek, ensure_ascii=False, indent=1), "utf-8")
        for f, v in cek["berkas"].items():
            say(f"iot: {f}: {v['baris']} baris, dipakai {v['dipakai']}, ditolak {v['ditolak']}" + (f" ({v['alasan']})" if v["alasan"] else ""))
        for w in cek["peringatan"]:
            say("iot: PERINGATAN", w)
        if cek["fatal"]:
            self.st.set(iot={"sumber": "sintetis" if self.a.iot_sintetis else "folder", "folder": str(masuk), "validasi": cek})
            raise SystemExit("data IoT tidak bisa dipakai: " + "; ".join(cek["fatal"]))
        rc, ekor = self.jalankan_proses([PY, IOT, "periksa", "--set", self.set, "--kc", self.kc, "--iot", masuk], self.dir / "log_iot.txt", env)
        rk = akar / "ringkasan.json"
        if rc != 0 or not rk.exists() or rk.stat().st_mtime < (self.dir / "iot_validasi.json").stat().st_mtime - 5:
            raise SystemExit("iot_cabang.py periksa gagal: " + " | ".join(ekor[-5:]))
        R = json.loads(rk.read_text("utf-8"))
        self.st.set(iot={"sumber": "sintetis" if self.a.iot_sintetis else "folder", "folder": str(masuk), "hasil": str(akar),
                         "berkas": {f: {k: v[k] for k in ("baris", "dipakai", "ditolak")} for f, v in cek["berkas"].items()},
                         "peringatan_masukan": cek["peringatan"],
                         **{k: R.get(k) for k in ("rs_dengan_iot", "alat", "klaim_dengan_alat", "sesuai", "tidak_sesuai", "tanpa_bukti", "selisih_rp", "jangkar",
                                                  "jangkar_ok", "peringatan")}})
        say("iot:", next((x for x in ekor if x.startswith("iot periksa")), ekor[-1] if ekor else "")[:300])

    # ------------------------------------------------------------------------------------------------ stage 4: aturan
    def aturan(self) -> None:
        """The medical-record and IoT findings of the selected claims: routing to the swarm, the dossiers' rule sections, the
        evidence lane, and the cost estimate with them (perkiraan). Writes <kerja>/jalur_<set>.json."""
        import numpy as np

        sys.path.insert(0, str(HERE)); sys.path.insert(0, str(ROOT / "api"))
        import laporan_cabang as LC
        import swarm_v5 as SW

        jf = self.kerja / f"jalur_{self.set}.json"
        out_sw = self.kerja / f"berkas_{self.set}_swarm.jsonl"
        if out_sw.exists() and jf.exists() and self.terpakai() > 0 and not self.a.ulang_zona:
            # the swarm already paid for these dossiers: their findings (R1..Rn) and routing stay as they were read
            J = json.loads(jf.read_text("utf-8"))
            self.st.set(aturan={**J.get("ringkas", {}), "dipertahankan": True})
            say("aturan: input swarm yang sudah dibayar dipertahankan (jalur dan temuan tetap)")
            self.indikasi_awal()
            return
        z = dict(np.load(self.kerja / f"zona_{self.set}.npz", allow_pickle=False))
        kunci = z["kunci"].astype(str)
        files = self.hasil_npz()
        raw = [dict(np.load(f, allow_pickle=False)) for f in files]
        cp = np.array([[int(x) for x in k.split(":")[1:]] for k in kunci])
        ambil = lambda nm: np.array([raw[c][nm][i] for c, i in cp])  # noqa: E731
        dx, kode, di_kc = ambil("dx").astype(str), ambil("kode").astype(str), ambil("rs_di_kc").astype(bool)
        tema = np.array([LC.tema_klaim(a, b) for a, b in zip(dx, kode)])
        pilih = di_kc & (np.isin(tema, self.tema) if self.tema else True)
        tahan, ragu = z["tahan"].astype(bool), z["ragu"].astype(bool)
        ada_bukti = "rme_bukti" in raw[0]
        if not ada_bukti:
            self.st.set(peringatan="hasil_NN.npz tanpa rme_bukti (fitur dibuat sebelum 2026-11-15): temuan rekam medis tanpa rincian bukti, tidak ada yang terverifikasi")
        bukti_iot_f = self.iot_akar() / "bukti.json"
        iot = json.loads(bukti_iot_f.read_text("utf-8")).get("klaim", {}) if bukti_iot_f.exists() else {}
        T: dict[str, dict] = {}
        for n in np.flatnonzero(pilih & ~tahan):
            c, i = cp[n]
            if ada_bukti:
                rb = json.loads(str(raw[c]["rme_bukti"][i]) or "{}") if str(raw[c]["rme_bukti"][i]) else {}
            else:  # codes only: shown, routed at most, never verifiable (no evidence to show)
                rb = {kd: {"bukti": "", "s": SW.KUAT_RUTE, "mitigasi": []} for kd in str(raw[c]["rme_sinyal"][i]).split()}
            T[kunci[n]] = SW.temuan_klaim(rb, bool(raw[c]["rme_ada"][i]), iot.get(kunci[n]), str(raw[c]["tingkat"][i]), str(raw[c]["kode"][i]), str(raw[c]["tgl"][i]))
        pos = {k: n for n, k in enumerate(kunci)}
        rute = {k for k, t in T.items() if t["k_rute"] >= SW.KUAT_RUTE and not ragu[pos[k]]}
        baca = {k for k in T if ragu[pos[k]] or k in rute}
        lajur = {k for k in baca if T[k]["k_aturan"] > 0}
        # the dossiers: v5.py's for the ML RAGU claims; built here (same berkas()) for the claims the rules route
        dasar: dict[str, str] = {}
        for line in (self.kerja / f"berkas_{self.set}.jsonl").read_text("utf-8").splitlines():
            if line.strip():
                d = json.loads(line)
                if d["kunci"] in baca:
                    dasar[d["kunci"]] = d["teks"].split("\nTemuan rekam medis (RME)", 1)[0]
        perlu = [k for k in baca if k not in dasar]
        if perlu:
            import joblib
            import fitur_v4 as F4

            b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
            R = SW.Referensi(list(b3["sys_names"]), np.load(self.kerja / "ref.npz")["X1_normal_latih"])
            for k in perlu:
                c, i = cp[pos[k]]
                x1 = raw[c]["X1"][i]
                dasar[k] = SW.berkas(R, x1, raw[c]["X4"][i], raw[c]["XR"][i], str(raw[c]["kode"][i]), x1[620:624], F4.NAMES)
        teks = {k: SW.tambah_aturan(dasar[k], T[k]) for k in baca}
        panjang = float(np.mean([len(v) for v in dasar.values()])) if dasar else 0.0
        y = z["y"].astype(int)
        tem = [t for k in baca for t in T[k]["temuan"]]
        ringkas = {"versi_berkas": SW.VERSI_BERKAS, "ambang": {"rute": SW.KUAT_RUTE, "bukti": SW.KUAT_BUKTI, "k_maks": SW.K_MAKS},
                   "klaim_dipilih": int(pilih.sum()), "ragu_ml": int((pilih & ragu).sum()), "rute_aturan": len(rute), "dibaca_swarm": len(baca),
                   "jalur_bukti_aturan": len(lajur), "jalur_bukti_aturan_dari_lolos": len(lajur & rute),
                   "klaim_dengan_rme": int(sum(1 for k in baca if T[k]["rme_ada"])), "klaim_dengan_iot": int(sum(1 for k in baca if T[k]["iot_ada"])),
                   "temuan": {"rme": sum(1 for t in tem if t["sumber"] == "rme"), "iot": sum(1 for t in tem if t["sumber"] == "iot"),
                              "terverifikasi": sum(1 for t in tem if t["terverifikasi"])},
                   "per_pemilik": {a: sum(1 for t in tem if t["pemilik"] == a) for a in ("koding", "tagihan", "episode")},
                   "per_kode": dict(sorted(((kd, sum(1 for t in tem if t["kode"] == kd)) for kd in {t["kode"] for t in tem}), key=lambda x: -x[1])),
                   "panjang_berkas_rata": {"dasar": round(panjang), "dengan_aturan": round(float(np.mean([len(v) for v in teks.values()]))) if teks else 0},
                   # the key file, for the technical appendix only (never used to route): fraud the rules bring within the swarm's reach
                   "lampiran_kunci": {"rute_aturan_fraud": int(sum(y[pos[k]] for k in rute)), "jalur_bukti_fraud": int(sum(y[pos[k]] for k in lajur)),
                                      "fraud_dipilih": int(y[pilih].sum()), "fraud_terjangkau_ml": int(y[pilih & (tahan | ragu)].sum()),
                                      "fraud_terjangkau_ml_dan_aturan": int(y[pilih & (tahan | ragu)].sum()) + int(sum(y[pos[k]] for k in rute))}}
        J = {"set": self.set, "dibuat": time.strftime("%Y-%m-%d %H:%M"), "iot": str(bukti_iot_f) if iot else None, "ringkas": ringkas,
             "rute_aturan": sorted(rute), "jalur_bukti_aturan": sorted(lajur),
             "klaim": {k: {"zona_ml": "RAGU" if ragu[pos[k]] else "LOLOS", "rute_aturan": k in rute, "rme_ada": T[k]["rme_ada"], "iot_ada": T[k]["iot_ada"],
                           "k_rute": T[k]["k_rute"], "k_aturan": T[k]["k_aturan"], "temuan": T[k]["temuan"]}
                       for k in sorted(baca) if T[k]["temuan"] or T[k]["iot_ada"]}}
        tmp = jf.with_suffix(".tmp")
        tmp.write_text(json.dumps(J, ensure_ascii=False, indent=1), "utf-8")
        os.replace(tmp, jf)
        self.st.set(aturan=ringkas)
        say(f"aturan: RAGU ML {ringkas['ragu_ml']} + dirutekan aturan {len(rute)} -> dibaca swarm {len(baca)}; jalur bukti aturan {len(lajur)} "
            f"({len(lajur & rute)} dari LOLOS); temuan RME {ringkas['temuan']['rme']}, IoT {ringkas['temuan']['iot']}, terverifikasi {ringkas['temuan']['terverifikasi']}; "
            f"berkas rata {ringkas['panjang_berkas_rata']['dasar']} -> {ringkas['panjang_berkas_rata']['dengan_aturan']} karakter")
        self.perkiraan({"rute": rute, "bukti": lajur, "teks": teks, "n_temuan": {k: len(T[k]["temuan"]) for k in baca},
                        "k_aturan": {k: T[k]["k_aturan"] for k in baca}, "panjang_dasar": panjang})
        self.indikasi_awal()

    def indikasi_awal(self) -> None:
        """The report's Indikasi block, counted now (laporan_cabang --indikasi-awal: the same claims and tags as the report), for the
        live chart while the swarm reads (the user, 2026-11-16: "pastikan blok2 ini juga jalan waktu live"). A failure here only
        leaves the chart without it: the audit goes on."""
        args = [PY, HERE / "laporan_cabang.py", "--set", self.set, "--kc", self.kc, "--indikasi-awal"] + (["--tema", ",".join(self.tema)] if self.tema else [])
        try:
            rc, ekor = self.jalankan_proses(args, self.dir / "log_indikasi.txt", self.env_pipa())
            baris = next((x for x in reversed(ekor) if x.startswith("INDIKASI ")), None)
            if rc == 0 and baris:
                ind = json.loads(baris[len("INDIKASI "):])
                self.st.set(indikasi=ind)
                say(f"indikasi: {ind['klaim_bertag']} klaim bertag · {ind['tag_aturan']} tag aturan + {ind['tag_model']} tag model")
            else:
                say("indikasi awal tidak tersedia:", " | ".join(ekor[-2:])[:200])
        except Exception as e:  # noqa: BLE001 - display only
            say("indikasi awal tidak tersedia:", str(e)[:200])

    # ------------------------------------------------------------------------------------------------ the gate (after the swarm)
    def gerbang_tulis(self) -> dict | None:
        """swarm_v5.terapkan_gerbang over the set: <kerja>/gerbang_<set>.json with every routed claim's lane and numbers, and the
        counts for the status (the report's laporan_cabang applies the same function to queue the claims)."""
        import numpy as np

        jf, af = self.kerja / f"jalur_{self.set}.json", self.kerja / f"agen_{self.set}.json"
        if not (jf.exists() and af.exists()):
            return None
        sys.path.insert(0, str(HERE))
        import swarm_v5 as SW

        z = dict(np.load(self.kerja / f"zona_{self.set}.npz", allow_pickle=False))
        K = json.loads((HERE / "model_v5" / "kartu.json").read_text("utf-8"))
        meta = json.loads((self.kerja / f"zona_{self.set}.json").read_text("utf-8"))
        q_ref = np.load(self.kerja / meta["q_ref"])["q_ref"]
        agen = json.loads(af.read_text("utf-8"))
        J = json.loads(jf.read_text("utf-8"))
        kunci = z["kunci"].astype(str)
        p = np.array([agen[k]["hakim"]["p"] if k in agen else np.nan for k in kunci])
        pp = np.nan_to_num(p, nan=0.0)
        q = np.searchsorted(q_ref, z["s"], "right") / len(q_ref)
        f_ml = pp if K["pilihan"] == "V5a" else (pp + q) / 2
        tau = float(K["tau"])
        f, rek = SW.terapkan_gerbang(kunci, f_ml, p, agen, J["klaim"], tau)
        rute = set(J.get("rute_aturan") or [])
        tahan, ragu = z["tahan"].astype(bool), z["ragu"].astype(bool)
        y = z["y"].astype(int)
        klaim, n = {}, {"dibaca": 0, "belum_dibaca": 0, "periksa": 0, "periksa_jalur_ml": 0, "periksa_jalur_aturan": 0, "dibersihkan": 0,
                        "periksa_dari_lolos": 0, "diselamatkan_jalur_aturan": 0, "hakim_terima": 0, "hakim_tolak": 0, "tidak_dinilai": 0}
        sw = self.kerja / f"berkas_{self.set}_swarm.jsonl"  # the audit's own claims (selected themes at the branch), not every RAGU claim
        dikirim = {json.loads(x)["kunci"] for x in sw.read_text("utf-8").splitlines() if x.strip()} if sw.exists() else set(agen)
        for i, k in enumerate(kunci):
            if tahan[i] or not (k in dikirim or k in rute):
                continue
            dibaca = k in agen
            g = rek.get(k) or {"f_ml": round(float(f_ml[i]), 4), "f": round(float(f_ml[i]), 4), "jalur": "ml", "f_aturan": None, "k_aturan": 0.0}
            kep = "BELUM_DIBACA" if not dibaca else "PERIKSA" if f[i] >= tau else "DIBERSIHKAN"
            kep_ml = ("LOLOS" if k in rute else "BELUM_DIBACA") if not dibaca else ("LOLOS" if k in rute else "PERIKSA" if f_ml[i] >= tau else "DIBERSIHKAN")
            n["dibaca"] += dibaca
            n["belum_dibaca"] += not dibaca
            if kep == "PERIKSA":
                n["periksa"] += 1
                n["periksa_jalur_aturan" if g["jalur"] == "bukti_aturan" else "periksa_jalur_ml"] += 1
                n["periksa_dari_lolos"] += k in rute
                n["diselamatkan_jalur_aturan"] += kep_ml != "PERIKSA" and g["jalur"] == "bukti_aturan"
            elif kep == "DIBERSIHKAN":
                n["dibersihkan"] += 1
            for a in ("hakim_terima", "hakim_tolak", "tidak_dinilai"):
                n[a] += len(g.get(a) or [])
            if k in rek or k in rute:
                klaim[k] = {**g, "p_hakim": None if p[i] != p[i] else round(float(p[i]), 4), "q": round(float(q[i]), 4), "zona_ml": "RAGU" if ragu[i] else "LOLOS",
                            "keputusan": kep, "keputusan_jalur_ml_saja": kep_ml, "fraud_kunci": int(y[i])}
        per = [x for x in klaim.values() if x["keputusan"] == "PERIKSA"]
        out = {"set": self.set, "dibuat": time.strftime("%Y-%m-%d %H:%M"), "tau": tau, "pilihan": K["pilihan"], "uji_kering": self.dry,
               "rumus": {"jalur_ml": "f = (p_hakim + q(s)) / 2" if K["pilihan"] != "V5a" else "f = p_hakim",
                         "jalur_bukti_aturan": "f = max(f_ml, (p_hakim + k_aturan) / 2), hanya bila hakim tidak menolak semua temuan terverifikasi"},
               "ringkas": n, "lampiran_kunci": {"periksa_fraud": int(sum(x["fraud_kunci"] for x in per)),
                                                "periksa_jalur_aturan_fraud": int(sum(x["fraud_kunci"] for x in per if x["jalur"] == "bukti_aturan"))},
               "klaim": klaim}
        (self.kerja / f"gerbang_{self.set}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
        self.st.set(gerbang={**n, "uji_kering": self.dry})
        say(f"gerbang: dibaca {n['dibaca']}, PERIKSA {n['periksa']} (jalur ML {n['periksa_jalur_ml']}, jalur bukti aturan {n['periksa_jalur_aturan']}; "
            f"dari LOLOS {n['periksa_dari_lolos']}), DIBERSIHKAN {n['dibersihkan']}; hakim menerima {n['hakim_terima']} / menolak {n['hakim_tolak']} temuan"
            + (" [uji kering: angka hakim palsu]" if self.dry else ""))
        return out

    # ------------------------------------------------------------------------------------------------ stage 3: swarm
    def swarm(self) -> None:
        masuk = self.kerja / f"berkas_{self.set}_swarm.jsonl"
        hasil, agen = self.kerja / f"hasil_{self.set}.json", self.kerja / f"agen_{self.set}.json"
        if not masuk.exists():
            raise SystemExit("jalankan tahap zona dulu")
        n = sum(1 for x in masuk.read_text("utf-8").splitlines() if x.strip())
        prog = re.compile(r"(\d+)/(\d+) batch · \$([\d.]+)")

        def pantau(s: str) -> None:
            mm = prog.search(s)
            if mm:
                self.st.set(progres={"batch": int(mm.group(1)), "batch_total": int(mm.group(2)), "usd_tahap_ini": float(mm.group(3))})

        if self.dry:
            if PY_ADK.exists():
                rc, ekor = self.jalankan_proses([PY_ADK, "-W", "ignore", Path(__file__), "_swarm_palsu", "--kerja", self.kerja, "--set", self.set,
                                                 "--masuk", masuk, "--keluar", hasil, "--agen", agen], self.dir / "log_swarm.txt", anak_env(), pantau)
                if rc != 0 or not hasil.exists():
                    raise SystemExit("swarm uji kering gagal: " + " | ".join(ekor[-5:]))
                say("swarm (uji kering, tanpa model):", ekor[-1][:200])
            else:  # no ADK environment: the RAGU claims stay unread (the report says so)
                hasil.write_text(json.dumps({"set": self.set, "model": "tidak dijalankan (uji kering)", "hasil": {}, "batch": -(-n // 8),
                                             "biaya": {"usd_perkiraan": 0.0, "panggilan": 0, "berhenti": "uji kering: swarm tidak dijalankan"}}), "utf-8")
                agen.write_text("{}", "utf-8")
                say("swarm: uji kering tanpa .venv-adk: RAGU tidak dibaca")
            self.gerbang_tulis()
            return
        if not PY_ADK.exists():
            raise SystemExit(f"{PY_ADK} tidak ada (lingkungan ADK untuk swarm)")
        env = anak_env(SWARM_V5_KERJA=str(self.kerja))
        ADK = HERE / "swarm_v5_adk.py"

        def biaya_dari(ekor: list[str]) -> dict | None:
            for s in reversed(ekor):
                if s.startswith("biaya {"):
                    return json.loads(s[len("biaya "):s.index(" | ")])
            return None

        smoke = self.kerja / f"hasil_smoke_{self.set}.json"
        if not smoke.exists():
            if self.terpakai() + SMOKE_USD > self.a.batas_usd:
                raise SystemExit("batas biaya sudah habis")
            rc, ekor = self.jalankan_proses([PY_ADK, "-W", "ignore", ADK, "jalankan", "--set", self.set, "--masuk", masuk, "--keluar", smoke,
                                             "--batas", SMOKE_USD, "--paralel", 1, "--maks", 8], self.dir / "log_swarm.txt", env, pantau)
            b = biaya_dari(ekor)
            if b:
                self.catat_biaya("smoke", b)
            if rc != 0 or not b or not json.loads(smoke.read_text("utf-8")).get("hasil"):
                smoke.unlink(missing_ok=True)
                raise SystemExit("smoke swarm gagal (kredensial / kuota Vertex?): " + " | ".join(ekor[-4:]))
            say("smoke:", ekor[-1][:200])
        sisa = round(self.a.batas_usd - self.terpakai() - CADANGAN_NARASI, 3)
        if sisa <= 0:
            raise SystemExit(f"batas ${self.a.batas_usd} sudah terpakai ({self.terpakai():.3f})")
        self.st.set(swarm={"klaim": n, "batas_tahap": sisa})
        rc, ekor = self.jalankan_proses([PY_ADK, "-W", "ignore", ADK, "jalankan", "--set", self.set, "--masuk", masuk, "--keluar", hasil,
                                         "--batas", sisa, "--paralel", self.a.paralel_swarm], self.dir / "log_swarm.txt", env, pantau)
        b = biaya_dari(ekor)
        if b:
            self.catat_biaya("swarm", b)
        if rc != 0 or not hasil.exists():
            raise SystemExit("swarm gagal: " + " | ".join(ekor[-5:]))
        rc, ekor = self.jalankan_proses([PY_ADK, "-W", "ignore", ADK, "ekspor", "--set", self.set, "--masuk", masuk, "--keluar", agen],
                                        self.dir / "log_swarm.txt", env)
        if rc != 0 or not agen.exists():
            raise SystemExit("ekspor pendapat agen gagal: " + " | ".join(ekor[-3:]))
        H = json.loads(hasil.read_text("utf-8"))
        self.st.set(swarm={"klaim": n, "dibaca": len(H.get("hasil") or {}), "berhenti": (H.get("biaya") or {}).get("berhenti"), "batas_tahap": sisa})
        say("swarm:", ekor[-1][:200])
        self.gerbang_tulis()

    # ------------------------------------------------------------------------------------------------ stage 4: laporan
    def laporan(self, tahap: str = "laporan") -> None:
        for nm in (f"hasil_{self.set}.json", f"agen_{self.set}.json"):
            if not (self.kerja / nm).exists():
                raise SystemExit(f"{nm} belum ada: jalankan tahap swarm dulu")
        self.gerbang_tulis()
        lc = (HERE / "laporan_cabang.py").read_text("utf-8")
        if (self.kerja / f"jalur_{self.set}.json").exists() and "jalur_" not in lc:
            self.st.set(peringatan_jalur="laporan_cabang.py belum membaca jalur_<set>.json / gerbang_<set>.json: klaim yang dirutekan aturan dan "
                                         "jalur bukti aturan belum tampil di laporan (keputusannya ada di gerbang_<set>.json)")
        args = [PY, HERE / "laporan_cabang.py", "--set", self.set, "--kc", self.kc, "--label", self.label]
        if self.tema:
            if laporan_dukung_tema():
                args += ["--tema", ",".join(self.tema)]
            else:
                self.st.set(peringatan="laporan_cabang.py belum mendukung --tema: laporan mencakup semua tema klaim KC")
                say("PERINGATAN: laporan_cabang.py belum mendukung --tema; laporan mencakup semua tema")
        with Kunci(f"jalan_kc_tema-{self.set}-{tahap}", self.st, self.a.tunggu_kunci):  # the report loads every replica's features
            rc, ekor = self.jalankan_proses(args, self.dir / f"log_{tahap}.txt", self.env_pipa())
        if rc != 0:
            raise SystemExit("laporan_cabang.py gagal: " + " | ".join(ekor[-6:]))
        out = (self.basis or ROOT / "data" / "aip" / "cabang") / self.set
        graf = next((s for s in ekor if "branch graph file" in s), None)
        self.st.set(keluaran={"laporan": str(out / f"kc_{self.kc}.json"), "graf": str(out / f"graf_{self.kc}.json"), "index": str(out / "index.json"),
                              "runs_json": None if self.basis else str(ROOT / "data" / "aip" / "cabang" / "runs.json"),
                              "ringkas": next((s[:400] for s in ekor if " KC -> " in s), None), "graf_log": graf,
                              "jalur": str(self.kerja / f"jalur_{self.set}.json"), "gerbang": str(self.kerja / f"gerbang_{self.set}.json"),
                              "iot": str(self.iot_akar()) if (self.iot_akar() / "bukti.json").exists() else None})
        say("laporan:", next((s[:300] for s in ekor if " KC -> " in s), ekor[-1][:300] if ekor else ""))
        if graf:
            say("graf:", graf[:200])

    # ------------------------------------------------------------------------------------------------ stage 5: narasi
    def narasi(self) -> None:
        if self.dry:
            say("narasi: uji kering, agen penulis tidak dipanggil")
            return
        tugas = self.kerja / f"narasi_tugas_{self.set}.jsonl"
        if not tugas.exists():
            raise SystemExit("narasi_tugas belum ada: jalankan tahap laporan dulu")
        sisa = round(min(CADANGAN_NARASI, self.a.batas_usd - self.terpakai()), 3)
        if sisa <= 0:
            say("narasi: batas biaya habis; laporan tanpa narasi")
            return
        rc, ekor = self.jalankan_proses([PY_ADK, "-W", "ignore", HERE / "swarm_v5_adk.py", "narasi", "--set", self.set, "--masuk", tugas,
                                         "--keluar", self.kerja / f"narasi_{self.set}.json", "--batas", sisa, "--paralel", 3],
                                        self.dir / "log_narasi.txt", anak_env(SWARM_V5_KERJA=str(self.kerja)))
        for s in reversed(ekor):
            if s.startswith("biaya {"):
                self.catat_biaya("narasi", json.loads(s[len("biaya "):s.index(" | ")]))
                break
        if rc != 0:
            raise SystemExit("agen penulis gagal: " + " | ".join(ekor[-4:]))
        self.laporan("laporan_narasi")

    # ------------------------------------------------------------------------------------------------ all
    def jalankan(self) -> None:
        if self.a.ulang:
            for f in [*self.dir.glob("hasil_*.npz"), self.dir / "replika.json", *self.dir.glob("log_[0-9][0-9].txt")]:
                f.unlink(missing_ok=True)
            for k in (self.kerja, self.kerja_lain):
                for f in k.glob(f"zona_{self.set}.*"):
                    f.unlink()
        say(f"set {self.set} · {'UJI KERING (tanpa model AI)' if self.dry else 'NYATA (batas $' + str(self.a.batas_usd) + ')'} · KC {self.kc} · "
            f"tema {self.tema or 'semua'} · {len(self.replika)} replika · IoT {self.st.d.get('iot_sumber') or 'tidak ada'} · tahap {','.join(self.tahap)}")
        try:
            for t in self.tahap:
                self.st.set(tahap=t, progres=None)
                getattr(self, t)()
                self.st.selesai_tahap(t)
            self.st.set(tahap=None, selesai=True, galat=None, progres=None, status="selesai")
            say("SELESAI", json.dumps(self.st.d.get("keluaran") or {}, ensure_ascii=False)[:500])
        except KeyboardInterrupt:
            self.st.set(galat="dibatalkan", status="dibatalkan")
            raise
        except (Exception, SystemExit) as e:  # noqa: BLE001 - the status says what stopped the run
            self.st.set(galat=str(e)[:1500], status="gagal")
            say("BERHENTI:", str(e)[:500])
            raise


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("perintah", nargs="?", default="jalankan", choices=["jalankan", "status", "_chunk", "_swarm_palsu"])
    ap.add_argument("--set", default="tema_jantung", help="run name (folder .tmp/kc_tema/<set>, report data/aip/cabang/<set>)")
    ap.add_argument("--data", default=str(DATA), help="theme dataset folder (klaim/ rekam_medis/ kunci/ peserta/ ringkasan.json)")
    ap.add_argument("--dataset", default="", help='a folder name of "Data Sintetis/" (the app launcher\'s {dataset}); overrides --data')
    ap.add_argument("--kc", default="", help="branch id (default: the dataset's, e.g. sul-7371)")
    ap.add_argument("--tema", default="", help="theme codes of laporan_cabang.tema_klaim, e.g. I or I,N (default: all themes)")
    ap.add_argument("--replika", default="", help="replicas, e.g. 60,61 or 9-61 (default: all)")
    ap.add_argument("--replika-terakhir", type=int, default=0, help="only the last N replicas")
    ap.add_argument("--batas-usd", type=float, default=20.0, help="ceiling for every model call of this set (smoke + swarm + writer)")
    ap.add_argument("--dry-run", action="store_true", help="no model call: fake swarm offline, no writer, report outside the app")
    ap.add_argument("--tulis-app", action="store_true", help="with --dry-run: still write the report to data/aip/cabang (+ runs.json)")
    ap.add_argument("--label", default="", help="the run's label in runs.json / the report")
    ap.add_argument("--tahap", default="", help=f"only these stages, comma-separated: {','.join(TAHAP)}")
    ap.add_argument("--tanpa-rme", action="store_true", help="ingest the claims without their SATUSEHAT records")
    ap.add_argument("--iot", default="", help="IoT input folder (docs/IOT_FORMAT_MASUKAN.md: alat, sesi, pembacaan, jangkar, klaim_alat, manifest)")
    ap.add_argument("--iot-sintetis", action="store_true", help="generate synthetic IoT data for the set's branch first (fixed seed)")
    ap.add_argument("--iot-seed", type=int, default=IOT_SEED, help="seed of --iot-sintetis")
    ap.add_argument("--ulang-iot", action="store_true", help="with --iot-sintetis: generate the synthetic IoT data again")
    ap.add_argument("--paralel-chunk", type=int, default=1, help="replicas through the engine at once (each ~2 GB RAM, ~1 GB disk)")
    ap.add_argument("--paralel-swarm", type=int, default=3, help="swarm batches at once")
    ap.add_argument("--maks-klaim", type=int, default=0, help="test only: the first N claims of each replica's stream")
    ap.add_argument("--tunggu-kunci", type=float, default=120, help="minutes to wait for .tmp/BERAT.lock")
    ap.add_argument("--ulang", action="store_true", help="redo the features and zones of this set (the swarm cache is kept)")
    ap.add_argument("--ulang-zona", action="store_true", help="redo the zones only")
    # internal
    ap.add_argument("--set-dir"); ap.add_argument("--nn", type=int); ap.add_argument("--replika-satu", type=int)
    ap.add_argument("--kerja"); ap.add_argument("--masuk"); ap.add_argument("--keluar"); ap.add_argument("--agen")
    a = ap.parse_args()
    if a.perintah == "_chunk":
        chunk(Path(a.set_dir), a.nn, a.replika_satu, Path(a.data), not a.tanpa_rme, a.maks_klaim or None)
        sys.stdout.flush()
        os._exit(0)  # the engine's threads end with the process
    if a.perintah == "_swarm_palsu":
        swarm_palsu(Path(a.kerja), a.set, Path(a.masuk), Path(a.keluar), Path(a.agen))
        return
    if a.perintah == "status":
        f = AKAR / a.set / "status.json"
        print(f.read_text("utf-8") if f.exists() else f"belum ada {f}")
        return
    Runner(a).jalankan()


if __name__ == "__main__":
    main()
