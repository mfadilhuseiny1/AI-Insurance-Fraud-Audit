"""FKTP visits and non-capitation claims in the stream: per facility, each compared with its own history (referensi.py),
and per member, each compared with what the member already had.

FKTP visits
  RUJUKAN_NON_SPESIALISTIK   a referral of a diagnosis handled at FKTP (modus.NON_SPESIALISTIK)            per visit, weak
  RUJUKAN_LONCAT_JENJANG     such a referral straight to a class-A hospital                                 per visit
  RRNS_FKTP_NAIK / RRNS_PUSKESMAS_NAIK  the facility's last 40 referrals hold far more non-specialist ones than its
                             history (exact binomial p < 1e-4); for a government FKTP it is the capitation proxy (M01)
  KONSENTRASI_RUJUKAN        the facility's last 30 referrals go to one destination far more than its history (M10)
  KONTAK_SEMU                the facility's last 80 visits hold far more online/home-visit contacts than its history (M01)
  KONTAK_RENDAH              periodic, per capitation unit: visits over the stream's days far below the unit's history
                             (Poisson lower tail p < 1e-8) while capitation is paid for every registered member (M01)
Non-capitation claims (M02)
  NONKAP_GANDA               the same member, procedure and date again; the same ANC visit number or a delivery again
                             within 270 days
  NONKAP_FREKUENSI           a chronic-programme test again within 25 days (HbA1c within 80)
  NONKAP_TIDAK_SESUAI_PESERTA  family planning, antenatal care or delivery for a man, or outside ages 10–55
  NONKAP_TARIF               billed above 1.25× the procedure's p95
  NONKAP_TANGGAL             procedure date outside the visit
  NONKAP_LONJAKAN            the facility's claims per stream day far above its history (Poisson p < 1e-6)
"""

from __future__ import annotations

import collections
import re
from datetime import date, timedelta
from typing import Any, Optional

from aip.realtime.graf import CLOCK_MIN, binom_sf, poisson_sf, sig
from aip.realtime.modus import CONTACT_ONLY_POLI, NON_SPESIALISTIK
from aip.realtime.referensi import profile, unit

ANC = re.compile(r"ANC (\d)")
CHRONIC = ("Gula Darah", "Kolesterol", "Ureum", "Kreatinin", "Microalbumin", "HbA1c")
FEMALE_ONLY = ("ANC", "Persalinan", "KB : Suntik", "KB : Pemasangan", "KB : Pil", "IUD", "Implant", "Nifas")


class FktpState:
    def __init__(self, R: Any, deaths: dict[int, date]) -> None:
        self.R = R
        self.deaths = deaths
        self.refs: dict[str, collections.deque] = collections.defaultdict(lambda: collections.deque(maxlen=40))
        self.dest: dict[str, collections.deque] = collections.defaultdict(lambda: collections.deque(maxlen=30))
        self.contact: dict[str, collections.deque] = collections.defaultdict(lambda: collections.deque(maxlen=80))
        self.unit_days: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
        self.unit_meta: dict[str, dict] = {}
        self.nk_seen: dict[tuple, str] = {}
        self.nk_last: dict[tuple, date] = {}
        self.nk_days: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
        self.nk_chronic: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
        self.active: dict[str, dict] = {}  # facility-level anomalies in force: (kind, facility) -> details
        self.meta: dict[str, dict] = {}
        self.clock: Optional[date] = None
        self.start: Optional[date] = None
        self.date_counts: collections.Counter = collections.Counter()
        self.alerted_units: set[str] = set()

    def _tick(self, d: date) -> None:
        """As graf.Graf._tick: the clock moves only to a date the stream has really reached."""
        if self.start is None or d < self.start:
            self.start = d if self.start is None else min(self.start, d)
        self.date_counts[d] += 1
        if self.clock is None:
            self.clock = d
        elif d > self.clock and self.date_counts[d] >= CLOCK_MIN:
            self.clock = d

    # ---------------------------------------------------------------------------------------------------
    def visit(self, v: Any) -> tuple[str, list[dict]]:
        d = v.tgl_datang
        self._tick(d)
        f = profile("FKTP", v.kabkota_fktp_kode, v.kepemilikan_fktp, v.jenis_fktp, v.tipe_fktp)
        u = unit(v.kabkota_fktp_kode, v.kepemilikan_fktp, v.jenis_fktp)
        gov = (v.kepemilikan_fktp or "").upper().startswith("PEM")
        self.meta[f] = {"label": f"{v.jenis_fktp} · {v.kepemilikan_fktp} · {v.kabkota_fktp or v.kabkota_fktp_kode}", "pemerintah": gov, "unit": u}
        self.unit_days[u][d] += 1
        self.unit_meta[u] = {"label": f"{v.jenis_fktp} · {v.kepemilikan_fktp} · {v.kabkota_fktp or v.kabkota_fktp_kode} (semua unit)", "pemerintah": gov,
                             "faskes": f}
        base = self.R.fktp.get(f) or {}
        out: list[dict] = []
        # contact-only visits (capitation proxy)
        q = self.contact[f]
        q.append((v.poli or "").upper() in CONTACT_ONLY_POLI)
        n, k = len(q), sum(q)
        p0 = min(max(base.get("kontak_semu", 0.02), 0.01), 0.9)
        if n >= 40 and k >= 20 and binom_sf(k, n, p0) < 1e-5:
            self.active[("kontak", f)] = {"k": k, "n": n, "p0": p0}
        elif ("kontak", f) in self.active and binom_sf(k, n, p0) > 1e-2:
            self.active.pop(("kontak", f), None)
        if ("kontak", f) in self.active and q[-1]:
            a = self.active[("kontak", f)]
            out.append(sig("KONTAK_SEMU", "", None, 1.0, 0, ("faskes", f),
                           f"{a['k']} dari {a['n']} kunjungan terakhir {self.meta[f]['label']} hanya kontak online/home-visit; riwayatnya {a['p0']:.1%}"
                           + (" (FKTP pemerintah: angka kontak KBK bisa dipenuhi tanpa layanan)" if gov else "")))
        # referrals
        if (v.status_pulang or "").upper() == "RUJUK LANJUT":
            nonspec = (v.dx_icd3 or "") in NON_SPESIALISTIK
            tujuan = "|".join(str(x) for x in (v.kabkota_rujukan_kode, v.kepemilikan_rujukan, v.jenis_faskes_rujukan, v.tipe_faskes_rujukan) if x is not None)
            if nonspec:
                out.append(sig("RUJUKAN_NON_SPESIALISTIK", "", None, 1.0, 0, ("faskes", f),
                               f"rujukan diagnosis {v.dx_icd3} yang termasuk kompetensi FKTP (4A) ke {v.tipe_faskes_rujukan or v.jenis_faskes_rujukan or '-'}"))
                tipe = (v.tipe_faskes_rujukan or "")
                if tipe.endswith("Kelas A") or tipe.endswith("Type A"):
                    out.append(sig("RUJUKAN_LONCAT_JENJANG", "", None, 1.0, 0, ("faskes", f),
                                   f"rujukan diagnosis kompetensi FKTP {v.dx_icd3} langsung ke {tipe} (rujukan berjenjang dimulai dari kelas C/D)"))
            r = self.refs[f]
            r.append(nonspec)
            n, k = len(r), sum(r)
            p0 = min(max(base.get("rrns") or 0.1, 0.02), 0.9)
            kind = "RRNS_PUSKESMAS_NAIK" if gov else "RRNS_FKTP_NAIK"
            if n >= 20 and k >= 8 and binom_sf(k, n, p0) < 1e-4:
                self.active[("rrns", f)] = {"k": k, "n": n, "p0": p0}
            elif ("rrns", f) in self.active and binom_sf(k, n, p0) > 1e-2:
                self.active.pop(("rrns", f), None)
            if ("rrns", f) in self.active and nonspec:
                a = self.active[("rrns", f)]
                out.append(sig(kind, "", None, 1.0, 0, ("faskes", f),
                               f"{a['k']} dari {a['n']} rujukan terakhir non-spesialistik, riwayat FKTP ini {a['p0']:.1%} (binomial p = {binom_sf(a['k'], a['n'], a['p0']):.1e})"
                               + ("; FKTP pemerintah: beban layanan berpindah ke FKRTL sementara kapitasi tetap dibayar" if gov else "")))
            dq = self.dest[f]
            dq.append(tujuan)
            top, cnt = collections.Counter(dq).most_common(1)[0]
            share = (self.R.fktp_dest.get(f) or {}).get(top, 0.0)
            p0 = min(max(share, 0.03), 0.95)
            if len(dq) >= 15 and cnt >= 10 and binom_sf(cnt, len(dq), p0) < 1e-4:
                self.active[("dest", f)] = {"tujuan": top, "k": cnt, "n": len(dq), "p0": p0}
            elif ("dest", f) in self.active and binom_sf(cnt, len(dq), p0) > 1e-2:
                self.active.pop(("dest", f), None)
            a = self.active.get(("dest", f))
            if a and tujuan == a["tujuan"]:
                out.append(sig("KONSENTRASI_RUJUKAN", "", None, 1.0, 0, ("faskes", f),
                               f"{a['k']} dari {a['n']} rujukan terakhir ke tujuan yang sama ({v.tipe_faskes_rujukan or '-'} · {v.kepemilikan_rujukan or '-'} · "
                               f"kab {v.kabkota_rujukan_kode}); riwayat FKTP ini ke tujuan itu {a['p0']:.1%}"))
        return f, out

    def low_contact(self) -> list[tuple[str, dict]]:
        """Capitation units whose visits over the last three complete stream days are far below their history (checked
        periodically): a rolling window, so a unit that stops serving mid-stream is seen within days."""
        out = []
        if not self.clock or not self.start:
            return out
        days = min(3, (self.clock - self.start).days)  # whole days behind the clock (the clock's own day is still filling)
        if days < 3:
            return out
        lo = self.clock - timedelta(days=days)
        for u, base in self.R.unit.items():
            if u in self.alerted_units or not (u.split("|")[1].startswith("PEM")):
                continue
            exp = base["per_hari"] * days
            if exp < 60:
                continue
            seen = sum(n for dd, n in self.unit_days.get(u, {}).items() if lo <= dd < self.clock)
            if seen < 0.35 * exp:
                from scipy.stats import poisson

                p = float(poisson.cdf(seen, exp))
                if p < 1e-8:
                    self.alerted_units.add(u)
                    meta = self.unit_meta.get(u) or {"label": u, "faskes": u}
                    out.append((meta.get("faskes") or u, sig("KONTAK_RENDAH", "", None, 1.0, 0, ("faskes", meta.get("faskes") or u),
                                                             f"{meta['label']}: {seen} kunjungan dalam {days} hari, ekspektasi riwayat {exp:.0f} "
                                                             f"({base['terdaftar']:,} peserta terdaftar, Poisson p = {p:.1e}); kapitasi tetap dibayar penuh".replace(",", "."))))
        return out

    # ---------------------------------------------------------------------------------------------------
    def nonkap(self, n: Any, m: Optional[dict], age: Optional[float]) -> tuple[str, list[dict]]:
        d = n.tgl_tindakan or n.tgl_kunjungan
        self._tick(d)
        f = profile("NONKAPITASI", n.kabkota_faskes_kode, n.kepemilikan_faskes, n.jenis_faskes, n.tipe_faskes)
        self.meta[f] = {"label": f"{n.jenis_faskes} · {n.kepemilikan_faskes} · {n.kabkota_faskes or n.kabkota_faskes_kode} (nonkapitasi)"}
        pid = int(n.peserta_id)
        t = n.tindakan or ""
        out: list[dict] = []
        key = (pid, t, d)
        prev = self.nk_seen.get(key)
        if prev and prev != n.kunjungan_id:
            out.append(sig("NONKAP_GANDA", "", None, 1.0, 0, ("faskes", f), f"{t} untuk peserta yang sama pada {d} sudah diklaim (kunjungan {prev})"))
        else:
            self.nk_seen[key] = n.kunjungan_id
        anc = ANC.search(t)
        group = f"ANC{anc.group(1)}" if anc else ("PERSALINAN" if "Persalinan" in t else None)
        if group:
            last = self.nk_last.get((pid, group))
            if last and 0 < (d - last).days <= 270 and not prev:
                out.append(sig("NONKAP_GANDA", "", None, 1.0, 0, ("faskes", f), f"{t} sudah diklaim untuk peserta ini {last} ({(d - last).days} hari lalu, satu kehamilan)"))
            self.nk_last[(pid, group)] = d
        chronic = next((c for c in CHRONIC if c in t), None)
        if chronic:
            last = self.nk_last.get((pid, t))
            lim = 80 if "HbA1c" in t else 25
            if last and 0 < (d - last).days <= lim:
                out.append(sig("NONKAP_FREKUENSI", "", None, 1.0, 0, ("faskes", f), f"{t} diulang {(d - last).days} hari setelah {last} (ketentuan ≥ {lim} hari)"))
            self.nk_last[(pid, t)] = d
        if m and any(x in t for x in FEMALE_ONLY):
            if m.get("jk") == "L":
                out.append(sig("NONKAP_TIDAK_SESUAI_PESERTA", "", None, 1.0, 0, ("faskes", f), f"{t} ditagih untuk peserta laki-laki"))
            elif age is not None and (age < 10 or age > 55):
                out.append(sig("NONKAP_TIDAK_SESUAI_PESERTA", "", None, 1.0, 0, ("faskes", f), f"{t} ditagih untuk peserta usia {age:.0f} tahun"))
        norm = self.R.nonkap_tindakan.get(t)
        if norm and norm["n"] >= 30 and norm["p95"] > 0 and n.biaya_tagih_rp > 1.25 * norm["p95"]:
            out.append(sig("NONKAP_TARIF", "", None, min(1.0, n.biaya_tagih_rp / norm["p95"] - 1), 0, ("faskes", f),
                           f"{t} ditagih Rp{n.biaya_tagih_rp:,.0f}; median Rp{norm['median']:,.0f}, p95 Rp{norm['p95']:,.0f}".replace(",", ".")))
        if n.tgl_tindakan and (n.tgl_tindakan < n.tgl_kunjungan or (n.tgl_pulang and n.tgl_tindakan > n.tgl_pulang)):
            out.append(sig("NONKAP_TANGGAL", "", None, 1.0, 0, ("faskes", f), f"tanggal tindakan {n.tgl_tindakan} di luar kunjungan {n.tgl_kunjungan}–{n.tgl_pulang}"))
        days = self.nk_days[f]
        days[d] += 1
        if chronic:
            self.nk_chronic[f][d] += 1
        rate = self.R.nonkap_fac.get(f, 0.0)
        exp = max(rate, 0.2)
        if days[d] >= max(15, 4 * rate) and poisson_sf(days[d], exp) < 1e-6:
            mit = []
            if self.nk_chronic[f][d] >= 0.7 * days[d]:
                # a Prolanis club's lab day: the members are tested together once a month
                mit.append({"kode": "HARI_PROLANIS", "label": "sebagian besar pemeriksaan Prolanis/PRB hari itu: hari kegiatan klub yang wajar", "faktor": 0.6})
            out.append(sig("NONKAP_LONJAKAN", "", None, 1.0, 0, ("faskes", f),
                           f"{days[d]} klaim nonkapitasi pada {d}, riwayat faskes ini {rate:.1f} per hari", [], mit))
        return f, out
