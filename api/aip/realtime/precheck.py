"""Pre-check kelengkapan: the central audit's answer to a hospital BEFORE it submits a claim (the bridge between the two
layers: the hospital's own prevention in ai-jkn, and this realtime audit across all hospitals).

What it tells the hospital, and why each is safe to tell:
  - documents a verifier will look for on a claim like this one, by public verification rules (procedure → operation
    report, severity III → results supporting the secondary diagnoses, class upgrade → statement, top-up → proof of use);
  - a stay above the code's own norm (the insurer's p90 length of stay of that INA-CBG code: an aggregate, like the
    norms the grouper publishes) → integrated progress notes;
  - what the verifiers asked THIS hospital for on its earlier claims of the same CMG (its own requests, aggregated);
  - conflicts with this hospital's OWN earlier submissions (the same RM number with overlapping dates, a readmission).

What it never tells: a score, a decision, a signal, the anomaly model's view, or anything about other hospitals or the
member's claims elsewhere (no tipping-off, no disclosure). The answer does not depend on the fraud engine at all, so
asking many times reveals nothing about how a claim would be scored.

Every pre-check is logged (store table `precheck`, billing fields only, no name). When the claim arrives, the auditor
sees how many pre-checks it had and what changed between them, as context. It is not a fraud signal: penalising use
would teach hospitals not to check, and with no score to probe there is little to learn from probing.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import uuid
from collections import deque
from datetime import date
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

PER_MENIT = 60  # pre-checks per hospital system per minute
PER_DRAF_HARI = 40  # pre-checks of one draft per day
CATATAN = ("Daftar ini dari aturan verifikasi, norma kode INA-CBG, dan riwayat permintaan verifikator untuk faskes Anda. "
           "Pre-check tidak memuat skor atau keputusan dan tidak memengaruhi penilaian klaim.")


class PrecheckIn(BaseModel):
    """A draft as the hospital has it now. No patient name: the RM number is enough to find its own earlier claims."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    sumber: str = Field("ai-jkn", pattern=r"^[a-z0-9-]{2,40}$")
    klaim_id: Optional[str] = Field(None, max_length=64, pattern=r"^[A-Za-z0-9-]*$")
    no_rm: str = Field("", max_length=64)
    jenis_episode: Optional[Literal["ri", "rj", "igd"]] = None
    tanggal_masuk: Optional[date] = None
    tanggal_pulang: Optional[date] = None
    diagnosis_utama: Optional[str] = Field(None, max_length=16)
    diagnosis_sekunder: list[str] = Field(default_factory=list, max_length=60)
    tindakan: list[str] = Field(default_factory=list, max_length=80)
    inacbg_kode: Optional[str] = Field(None, max_length=20)
    biaya_tagih_rp: Optional[int] = Field(None, ge=0, le=10_000_000_000)
    kelas_rawat: Optional[int] = Field(None, ge=1, le=3)
    hak_kelas: Optional[int] = Field(None, ge=1, le=3)
    topup_kode: Optional[str] = Field(None, max_length=40)


def norm_rm(rm: str) -> str:
    return re.sub(r"\s+", "", rm or "").upper()


def draft_key(sumber: str, no_rm: str, tanggal_masuk: Any, klaim_id: Optional[str] = None) -> Optional[str]:
    """One draft across its edits and its submission: the hospital's RM number and admission date (or its claim id)."""
    rm = norm_rm(no_rm)
    if rm and tanggal_masuk:
        base = f"{sumber}|{rm}|{tanggal_masuk}"
    elif klaim_id:
        base = f"{sumber}|id|{klaim_id}"
    else:
        return None
    return "dr-" + hashlib.sha256(base.encode()).hexdigest()[:16]


def _code(s: Optional[str]) -> str:
    c = (s or "").strip().upper()
    return c if re.match(r"^[A-Z]-[0-9]-[0-9]{2}-[0IV]+$", c) else ""


def _los(p: PrecheckIn) -> Optional[int]:
    if p.jenis_episode != "ri" or not p.tanggal_masuk or not p.tanggal_pulang or p.tanggal_pulang < p.tanggal_masuk:
        return None
    return max(1, (p.tanggal_pulang - p.tanggal_masuk).days)


def summary(p: PrecheckIn) -> dict:
    """The billing fields of a draft, to show the auditor what changed between pre-checks (no name, no free text)."""
    return {"inacbg": _code(p.inacbg_kode) or None, "dx": (p.diagnosis_utama or "").upper() or None, "dx_sekunder": len(p.diagnosis_sekunder),
            "tindakan": len(p.tindakan), "los": _los(p), "biaya": p.biaya_tagih_rp, "kelas_rawat": p.kelas_rawat, "topup": bool(p.topup_kode)}


def changes(prev: dict, cur: dict) -> list[dict]:
    return [{"medan": k, "dari": prev.get(k), "ke": cur.get(k)} for k in cur if prev.get(k) != cur.get(k)]


class Limiter:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.hits: dict[str, deque] = {}

    def allow(self, sumber: str, now: float) -> bool:
        with self.lock:
            q = self.hits.setdefault(sumber, deque())
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= PER_MENIT:
                return False
            q.append(now)
            return True


LIMIT = Limiter()


def _doc(kode: str, dokumen: str, alasan: str, dasar: str) -> dict:
    return {"kode": kode, "dokumen": dokumen, "alasan": alasan, "dasar": dasar}


class Accepted:
    """Submissions accepted but maybe not decided yet (the engine queues them): a pre-check a second later must see them."""

    def __init__(self, size: int = 2000) -> None:
        self.lock = threading.Lock()
        self.items: dict[str, deque] = {}
        self.size = size

    def add(self, sumber: str, entitas: str, klaim_id: str, tgl_datang: Any, tgl_pulang: Any, tanda_terima: str) -> None:
        key = f"faskes:{sumber}.{klaim_id}"
        with self.lock:
            q = self.items.setdefault(sumber, deque(maxlen=self.size))
            for old in [x for x in q if x["klaim"] == key]:  # a re-submission replaces the claim's earlier dates
                q.remove(old)
            q.append({"entitas": {"entitas": entitas}, "klaim": key, "tgl_datang": str(tgl_datang),
                      "tgl_pulang": str(tgl_pulang) if tgl_pulang else None, "tanda_terima": tanda_terima})

    def of(self, sumber: str) -> list[dict]:
        with self.lock:
            return list(self.items.get(sumber, ()))


ACCEPTED = Accepted()


def _own_claims(store: Any, resolver: Any, sumber: str, rm: str, skip: Optional[str]) -> list[dict]:
    """This hospital's earlier submissions for the same patient entity (its own RM number), newest first: the decided
    events in the store and the accepted ones still in the engine's queue (one entry per claim, a re-submission replaces)."""
    if not rm or resolver is None:
        return []
    eid = resolver.by_rm.get((sumber, rm))
    if not eid:
        return []
    out: dict[str, dict] = {}
    rows = [json.loads(rec) for (rec,) in store.rows("SELECT rec FROM peristiwa WHERE sumber = ? ORDER BY seq LIMIT 5000", (f"faskes:{sumber}",))]
    for e in rows + ACCEPTED.of(sumber):
        if (e.get("entitas") or {}).get("entitas") != eid:
            continue
        k = str(e.get("klaim", ""))
        if skip and k.endswith(f".{skip}"):
            continue
        out[k] = e
    return list(reversed(out.values()))


def _requested_for(store: Any, sumber: str, cmg: str) -> tuple[int, dict[str, int]]:
    """How many of this hospital's claims of the CMG drew a request, and how often each document was asked for."""
    n_claims: set[str] = set()
    docs: dict[str, int] = {}
    for r in store.requests_of_source(sumber):
        e = store.event(r["peristiwa"]) or {}
        if "-".join(str(e.get("kode") or "").split("-")[:3]) != cmg:
            continue
        n_claims.add(r["peristiwa"])
        for b in r.get("butir") or []:
            d = (b.get("dokumen") or "").strip()
            if d:
                docs[d] = docs.get(d, 0) + 1
    return len(n_claims), docs


def check(p: PrecheckIn, store: Any, resolver: Any, los_ref: dict[str, tuple[float, float]]) -> dict:
    docs: list[dict] = []
    warn: list[dict] = []
    code = _code(p.inacbg_kode)
    sev = code.split("-")[-1] if code else ""
    los = _los(p)
    n2 = len(p.diagnosis_sekunder)
    if p.tindakan:
        docs.append(_doc("laporan_tindakan", "Laporan operasi / laporan tindakan", f"{len(p.tindakan)} kode tindakan pada klaim", "aturan verifikasi"))
    if sev == "III":
        docs.append(_doc("penunjang_dx_sekunder", "Hasil penunjang (laboratorium, radiologi) yang mendukung diagnosis sekunder",
                         f"keparahan III ditentukan diagnosis sekunder; draf memuat {n2} diagnosis sekunder", "aturan verifikasi"))
    if los is not None and code in los_ref:
        med, p90 = los_ref[code]
        if p90 and los > p90:
            docs.append(_doc("cppt", "Catatan perkembangan pasien terintegrasi (CPPT) seluruh hari rawat",
                             f"lama rawat {los} hari, di atas 90% klaim kode {code} ({p90:.0f} hari; median {med:.0f})", "norma kode INA-CBG"))
    if p.kelas_rawat and p.hak_kelas and p.kelas_rawat < p.hak_kelas:
        docs.append(_doc("naik_kelas", "Surat pernyataan naik kelas dan bukti selisih biaya",
                         f"dirawat di kelas {p.kelas_rawat}, hak kelas {p.hak_kelas}", "aturan verifikasi"))
    if p.topup_kode:
        docs.append(_doc("topup", "Bukti pemakaian obat / alat kesehatan top-up (special CMG)", f"top-up {p.topup_kode} diajukan", "aturan verifikasi"))

    rm = norm_rm(p.no_rm)
    if p.tanggal_masuk:
        a = p.tanggal_masuk
        b = p.tanggal_pulang or a
        for e in _own_claims(store, resolver, p.sumber, rm, p.klaim_id):
            try:
                d0 = date.fromisoformat(str(e.get("tgl_datang"))[:10])
                d1 = date.fromisoformat(str(e.get("tgl_pulang") or e.get("tgl_datang"))[:10])
            except ValueError:
                continue
            if d0 <= b and a <= d1:
                warn.append({"kode": "beririsan", "pesan": f"Klaim lain untuk no RM ini sudah dikirim dengan tanggal rawat {d0}–{d1}, beririsan dengan draf ini.",
                             "tanda_terima": e.get("tanda_terima")})
            elif p.jenis_episode == "ri" and 0 <= (a - d1).days <= 30:
                docs.append(_doc("resume_sebelumnya", "Resume medis episode sebelumnya",
                                 f"pasien pulang {(a - d1).days} hari sebelum masuk lagi (klaim {d0} yang sudah dikirim)", "kiriman faskes ini sebelumnya"))
                break
    if code:
        cmg = "-".join(code.split("-")[:3])
        n, asked = _requested_for(store, p.sumber, cmg)
        for d, k in sorted(asked.items(), key=lambda x: -x[1])[:3]:
            if k >= 2:
                docs.append(_doc("riwayat_permintaan", d, f"verifikator meminta dokumen ini {k} kali pada {n} klaim {cmg} faskes Anda",
                                 "riwayat permintaan verifikator"))
    seen: set[str] = set()
    uniq = []
    for d in docs:
        k = d["dokumen"].lower()
        if k not in seen:
            seen.add(k)
            uniq.append(d)
    return {"dokumen": uniq[:8], "peringatan": warn[:5], "catatan": CATATAN}


def run(p: PrecheckIn, store: Any, resolver: Any, los_ref: dict, now_iso: str) -> dict:
    """Check, log, and answer. Raises ValueError('batas') when the hospital or the draft is over its limit."""
    if not LIMIT.allow(p.sumber, time.time()):
        raise ValueError(f"batas {PER_MENIT} pre-check per menit untuk sistem ini tercapai")
    key = draft_key(p.sumber, p.no_rm, p.tanggal_masuk, p.klaim_id)
    if key and store.precheck_count(key, now_iso[:10]) >= PER_DRAF_HARI:
        raise ValueError(f"batas {PER_DRAF_HARI} pre-check per draf per hari tercapai")
    out = check(p, store, resolver, los_ref)
    rid = "pc-" + uuid.uuid4().hex[:12]
    store.add_precheck({"id": rid, "sumber": p.sumber, "kunci": key, "pada": now_iso, "ringkas": summary(p),
                        "dokumen": [d["kode"] for d in out["dokumen"]], "peringatan": [w["kode"] for w in out["peringatan"]]})
    return {"id": rid, "kunci_draf": key, "pada": now_iso, **out}


def history(store: Any, sumber: str, key: Optional[str]) -> list[dict]:
    """The pre-checks of one draft, oldest first, each with what changed since the one before (for the auditor)."""
    if not key:
        return []
    rows = store.prechecks(sumber, key)
    prev: Optional[dict] = None
    for r in rows:
        r["berubah"] = changes(prev, r["ringkas"]) if prev is not None else []
        prev = r["ringkas"]
    return rows
