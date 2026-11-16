"""The dynamic graph of the realtime stream and the signals read from it: a claim judged in its network context.

The graph is a sliding event-time window (WINDOW_DAYS) of the stream: member — facility (each claim is an edge, with
its dates, code, diagnosis and bill), and from it the facility — facility projection (the members two facilities
share). Every claim is added in arrival order and sees only what came before it (point in time). The signals:

  RAWAT_INAP_TUMPANG_TINDIH  the member is an inpatient at another facility on overlapping nights (impossible for one
                             person: a borrowed card or a phantom claim)
  KARTU_BANYAK_FASKES        the member's card at >= 3 facilities within 3 days
  KLAIM_GANDA_STREAM         the same member, facility, admission date and INA-CBG code already claimed under another id
  PEMECAHAN_EPISODE          readmitted to the same facility 0–3 days after discharge with the same diagnosis
  CINCIN_FASKES              the facility shares far more members with another than that pair's history predicts
                             (Poisson tail p < 1e-4 on the pair's own rate, >= 4 members); abnormal pairs that connect
                             form a ring
  KLONING_LINTAS_PESERTA     >= 3 members with identical inpatient claims (facility, date, code, diagnosis, stay, procedure,
                             bill) whose bill is not the package tariff
  LONJAKAN_KEPARAHAN         the facility's recent inpatient claims carry severity III far above its own history (exact
                             binomial tail p < 1e-4 on its last RITL claims): an upcoding burst
  RISIKO_ASOSIASI            the facility already sits in Box Karantina (risk by association; context, never a tag)

Mitigating context, Quantexa's "reasons a transaction is legitimate", lowers a signal's weight and is shown with it:
a referral up the hospital hierarchy (the previous claim discharged as "Rujuk", or a higher class in the same kab/kota),
an emergency admission (IGD), a discharge against advice, and verified device evidence sent with a hospital's claim.
"""

from __future__ import annotations

import collections
from datetime import date, timedelta
from typing import Any, Optional

WINDOW_DAYS = 30
CLOCK_MIN = 30  # events on a date before the event-time clock moves to it
RITL_WINDOW = 40  # a facility's recent inpatient claims read for a severity burst
P_PAIR = 1e-4
P_BURST = 1e-4

RANK = {"RS Kelas A": 4, "RS Kelas B": 3, "RS Kelas C": 2, "RS Kelas D": 1, "RS Swasta Setara Type A": 4, "RS Swasta Setara Type B": 3,
        "RS Swasta Setara Type C": 2, "RS Swasta Setara Type D": 1, "RS TNI Polri Kelas I": 4, "RS TNI Polri Kelas II": 3, "RS TNI Polri Kelas III": 2,
        "RS TNI Polri Kelas IV": 1}


def rank_of(tipe: Optional[str]) -> int:
    if not tipe:
        return 0
    return RANK.get(tipe, 3 if tipe.startswith("Khusus") else 2)


def poisson_sf(k: int, lam: float) -> float:
    """P(X >= k) for X ~ Poisson(lam)."""
    from scipy.stats import poisson

    return float(poisson.sf(k - 1, lam))


def binom_sf(k: int, n: int, p: float) -> float:
    from scipy.stats import binom

    return float(binom.sf(k - 1, n, p))


def sig(kode: str, label: str, tag: Optional[str], s: float, w: float, fokus: tuple[str, str], bukti: str, terkait: Optional[list] = None,
        mitigasi: Optional[list] = None) -> dict:
    return {"kode": kode, "label": label, "tag": tag, "s": round(max(0.0, min(1.0, s)), 3), "w": w, "fokus": list(fokus), "bukti": bukti,
            "terkait": terkait or [], "mitigasi": mitigasi or []}


class Graf:
    def __init__(self, pair_rate: dict[tuple[str, str], float], sev_base: dict[str, float], sev_pop: float,
                 los_base: Optional[dict[str, float]] = None) -> None:
        self.pair_rate = pair_rate  # shared members per day in the pair's history
        self.sev_base = sev_base  # each facility's share of severity III among its inpatient claims (history)
        self.sev_pop = sev_pop
        self.los_base = los_base or {}  # each facility's mean LOS index (LOS / the code's median) in its history
        self.los: dict[str, collections.deque] = collections.defaultdict(lambda: collections.deque(maxlen=30))
        self.los_shift: dict[str, dict] = {}
        self.deaths: dict[int, date] = {}  # members whose death the stream recorded (a claim or visit ending "Meninggal")
        self.date_counts: collections.Counter = collections.Counter()
        self.box: dict[str, str] = {}  # faskes -> Box Karantina group (refreshed by the engine)
        self.claims: dict[str, dict] = {}
        self.by_member: dict[int, list[str]] = collections.defaultdict(list)
        self.fac_members: dict[str, dict[int, date]] = collections.defaultdict(dict)
        self.pairs: dict[tuple[str, str], dict[int, date]] = collections.defaultdict(dict)
        self.abnormal: dict[tuple[str, str], dict] = {}
        self.fac_ritl: dict[str, collections.deque] = collections.defaultdict(lambda: collections.deque(maxlen=RITL_WINDOW))
        self.burst: dict[str, dict] = {}
        self.clones: dict[tuple, set[str]] = collections.defaultdict(set)
        self.dup: dict[tuple, str] = {}
        self.meta: dict[str, dict] = {}
        self.clock: Optional[date] = None
        self.start: Optional[date] = None
        self.added = 0

    # -------------------------------------------------------------------------------------------------
    def _tick(self, d: date) -> None:
        """The event-time clock follows the stream's service dates, but only to a date the stream has really reached
        (>= CLOCK_MIN events on it): a few claims dated ahead (claims arrive after the service; planted ones too) do not
        move it."""
        if self.start is None or d < self.start:
            self.start = d if self.start is None else min(self.start, d)
        self.date_counts[d] += 1
        if self.clock is None:
            self.clock = d
        elif d > self.clock and self.date_counts[d] >= CLOCK_MIN:
            self.clock = d

    def days(self) -> int:
        if not self.clock or not self.start:
            return 1
        return max(1, min(WINDOW_DAYS, (self.clock - self.start).days + 1))

    def _prune(self) -> None:
        cut = self.clock - timedelta(days=WINDOW_DAYS)
        old = [k for k, c in self.claims.items() if c["d"] < cut]
        for k in old:
            c = self.claims.pop(k)
            lst = self.by_member.get(c["pid"])
            if lst and k in lst:
                lst.remove(k)
                if not lst:
                    self.by_member.pop(c["pid"], None)
            self.clones.get(c["clone"], set()).discard(k)
            if self.dup.get(c["dupkey"]) == k:
                self.dup.pop(c["dupkey"], None)
        for f, mem in self.fac_members.items():
            for pid in [p for p, d in mem.items() if d < cut]:
                mem.pop(pid, None)
        for pk, mem in list(self.pairs.items()):
            for pid in [p for p, d in mem.items() if d < cut]:
                mem.pop(pid, None)
            if not mem:
                self.pairs.pop(pk, None)
                self.abnormal.pop(pk, None)

    def remove(self, key: str) -> None:
        """A claim resubmitted under the same id (a hospital's amendment): its earlier version leaves the graph."""
        c = self.claims.pop(key, None)
        if not c:
            return
        lst = self.by_member.get(c["pid"])
        if lst and key in lst:
            lst.remove(key)
        self.clones.get(c["clone"], set()).discard(key)
        if self.dup.get(c["dupkey"]) == key:
            self.dup.pop(c["dupkey"], None)

    # -------------------------------------------------------------------------------------------------
    def add(self, c: dict) -> list[dict]:
        """Add one claim (arrival order); return the graph's signals on it, each with its mitigating context."""
        d: date = c["d"]
        self._tick(d)
        self.added += 1
        if self.added % 2000 == 0:
            self._prune()
        f, pid, key = c["f"], c["pid"], c["key"]
        self.meta[f] = {"label": c["faskes_label"], "kab": c["kab"], "kab_nama": c.get("kab_nama"), "prov": c["prov"], "tipe": c["tipe"]}
        out: list[dict] = []
        mine = [self.claims[k] for k in self.by_member.get(pid, []) if k in self.claims]

        # 1 overlapping inpatient stays at another facility: strength by the nights both stays claim; a transfer within the
        # province (a referral, discharge recorded late) is the legitimate reading, weaker when the earlier stay says "Rujuk"
        if c["ritl"]:
            best = None
            for o in mine:
                if o["ritl"] and o["f"] != f and d < o["p"] and o["d"] < c["p"]:
                    nights = (min(c["p"], o["p"]) - max(d, o["d"])).days
                    if best is None or nights > best[0]:
                        best = (nights, o)
            if best:
                nights, o = best
                mit = []
                same_prov = c["kab"] and o["kab"] and c["kab"] // 100 == o["kab"] // 100
                first = o if o["d"] <= d else c
                if same_prov and (first.get("status_pulang") == "Rujuk" or nights <= 1):
                    mit.append({"kode": "RUJUKAN_PINDAH_RAWAT", "label": "pindah rawat dalam satu provinsi (dirujuk atau tumpang tindih 1 malam): bisa rujukan yang tanggal pulangnya tercatat terlambat", "faktor": 0.6})
                elif same_prov:
                    mit.append({"kode": "SATU_PROVINSI", "label": "kedua faskes satu provinsi: pindah rawat lebih mungkin daripada kartu dipinjam", "faktor": 0.4})
                out.append(sig("RAWAT_INAP_TUMPANG_TINDIH", "Rawat inap tumpang tindih di faskes lain", "KLAIM_FIKTIF", 0.4 + 0.3 * (nights - 1), 1.6,
                               ("peserta", str(pid)),
                               f"peserta yang sama dirawat inap di {o['faskes_label']} {o['d']} s.d. {o['p']} dan di sini {d} s.d. {c['p']}: "
                               f"{nights} malam diklaim dua faskes (satu orang tidak dapat dirawat inap di dua tempat pada malam yang sama)", [o["key"]], mit))
        # 2 one card at many facilities within 3 days
        near = {o["f"]: o for o in mine if abs((o["d"] - d).days) <= 3}
        near.pop(f, None)
        if len(near) >= 2:
            n = len(near) + 1
            mit = []
            chain = sorted([*near.values(), c], key=lambda x: x["d"])
            if all(b["rank"] >= a["rank"] and (a.get("status_pulang") == "Rujuk" or a["kab"] == b["kab"]) for a, b in zip(chain, chain[1:])):
                mit.append({"kode": "RUJUKAN_BERJENJANG", "label": "urutan faskes mengikuti rujukan berjenjang (kelas naik, dirujuk / satu kab/kota)", "faktor": 0.6})
            out.append(sig("KARTU_BANYAK_FASKES", "Satu kartu di banyak faskes", "KLAIM_FIKTIF", (n - 2) / 2, 1.0, ("peserta", str(pid)),
                           f"kartu peserta dipakai di {n} faskes dalam 3 hari: " + ", ".join(sorted({o['faskes_label'] for o in near.values()})),
                           [o["key"] for o in near.values()], mit))
        # 3 the same claim already in the stream under another id
        dupkey = (pid, f, d, c["kode"])
        c["dupkey"] = dupkey
        prev = self.dup.get(dupkey)
        if prev and prev != key and prev in self.claims:
            out.append(sig("KLAIM_GANDA_STREAM", "Klaim ganda (id berbeda)", "KLAIM_GANDA", 1.0, 1.6, ("faskes", f),
                           f"peserta, faskes, tanggal masuk {d} dan kode {c['kode']} yang sama sudah diklaim dengan id {prev.split(':', 1)[-1]}", [prev]))
        else:
            self.dup[dupkey] = key
        # 4b one episode split on one day: outpatient and inpatient (or two outpatient claims) at the same facility on the same
        # date, other codes than an exact duplicate (M08)
        same_day = [o for o in mine if o["f"] == f and o["d"] == d and o["key"] != key and o["kode"] != c["kode"]]
        if same_day:
            o = same_day[0]
            mixed = o["ritl"] != c["ritl"]
            mit = [] if mixed or o["dx3"] == c["dx3"] else [{"kode": "DIAGNOSIS_BERBEDA", "label": "dua rawat jalan dengan diagnosis berbeda: bisa dua poli atas rujukan internal", "faktor": 0.6}]
            out.append(sig("EPISODE_HARI_SAMA", "", None, 1.0 if mixed else 0.7, 0, ("faskes", f),
                           f"{'rawat jalan dan rawat inap' if mixed else 'dua rawat jalan'} peserta yang sama di faskes ini pada {d} ditagih terpisah "
                           f"({o['kode']} dan {c['kode']})", [o["key"]], mit))
        # 4c a repeat with the admission moved by a day: same member, facility and diagnosis, inpatient (M11)
        if c["ritl"]:
            o = next((o for o in mine if o["ritl"] and o["f"] == f and o["dx3"] == c["dx3"] and abs((o["d"] - d).days) == 1 and o["key"] != key), None)
            if o:
                out.append(sig("KLAIM_BERULANG_MIRIP", "", None, 1.0, 0, ("faskes", f),
                               f"rawat inap peserta, faskes dan diagnosis {c['dx3']} yang sama sudah diklaim dengan masuk {o['d']} (id {o['key'].split(':', 1)[-1]}); "
                               f"klaim ini masuk {d}", [o["key"]]))
        # 4d readmission 4-30 days after discharge with the same diagnosis (M16)
        if c["ritl"]:
            o = next((o for o in mine if o["ritl"] and o["f"] == f and o["dx3"] == c["dx3"] and 4 <= (d - o["p"]).days <= 30 and o["key"] != key), None)
            if o:
                out.append(sig("READMISI_DX_SAMA", "", None, 1.0, 0, ("faskes", f),
                               f"pulang {o['p']} lalu dirawat lagi {d} ({(d - o['p']).days} hari) dengan diagnosis {c['dx3']} yang sama", [o["key"]]))
        # 4e the facility's LOS index drifting above its own history (M12)
        if c["ritl"] and c.get("idx_los") is not None and c["idx_los"] == c["idx_los"]:
            q = self.los[f]
            q.append(float(c["idx_los"]))
            base = self.los_base.get(f)
            if base and base > 0 and len(q) >= 15:
                mean = sum(q) / len(q)
                sd = (sum((x - mean) ** 2 for x in q) / (len(q) - 1)) ** 0.5 or 1e-9
                z = (mean - base) / (sd / len(q) ** 0.5)
                if mean >= 1.4 * base and z >= 4:
                    self.los_shift[f] = {"rata": mean, "riwayat": base, "n": len(q), "z": z}
                elif f in self.los_shift and mean < 1.15 * base:
                    self.los_shift.pop(f, None)
            ls = self.los_shift.get(f)
            if ls and c["idx_los"] >= 1.4 * ls["riwayat"]:
                mit = []
                if (c.get("iomt") or {}).get("los"):
                    mit.append({"kode": "BUKTI_PERANGKAT", "label": "bukti perangkat IoMT terverifikasi mendukung lama rawat", "faktor": 0.7})
                out.append(sig("LOS_FASKES_BERGESER", "", None, 1.0, 0, ("faskes", f),
                               f"indeks lama rawat {ls['n']} rawat inap terakhir faskes ini rata-rata {ls['rata']:.2f}, riwayatnya {ls['riwayat']:.2f} "
                               f"(z = {ls['z']:.1f}); klaim ini {c['idx_los']:.2f}", [], mit))
        # a death the stream records: later claims of this member are checked against it
        if (c.get("status_pulang") or "").lower().startswith("meninggal"):
            self.deaths[pid] = min(self.deaths.get(pid, c["p"]), c["p"])
        # 4 a split episode: readmitted 0-3 days after discharge, same diagnosis, same facility
        if c["ritl"]:
            for o in mine:
                gap = (d - o["p"]).days
                if o["ritl"] and o["f"] == f and o["dx3"] == c["dx3"] and 0 <= gap <= 3 and o["key"] != key:
                    mit = []
                    if c.get("poli") == "IGD":
                        mit.append({"kode": "GAWAT_DARURAT", "label": "masuk lewat IGD (kegawatdaruratan)", "faktor": 0.5})
                    if o.get("status_pulang") == "Pulang Paksa":
                        mit.append({"kode": "PULANG_PAKSA", "label": "episode sebelumnya pulang paksa", "faktor": 0.5})
                    out.append(sig("PEMECAHAN_EPISODE", "Pemecahan episode", "PEMECAHAN_EPISODE", 1.0, 0.9, ("faskes", f),
                                   f"pulang {o['p']} lalu masuk lagi {d} ({gap} hari) di faskes yang sama dengan diagnosis {c['dx3']} yang sama",
                                   [o["key"]], mit))
                    break
        # 5 facility pairs sharing far more members than their history: rings
        mem = self.fac_members[f]
        mem[pid] = max(mem.get(pid, d), d)
        for g in {o["f"] for o in mine if o["f"] != f}:
            pk = (f, g) if f < g else (g, f)
            self.pairs[pk][pid] = d
            k = len(self.pairs[pk])
            lam = self.pair_rate.get(pk, 0.0) * self.days() + 0.01 * self.days()
            if k >= 4:
                p = poisson_sf(k, lam)
                if p < P_PAIR:
                    self.abnormal[pk] = {"anggota": k, "ekspektasi": round(lam, 3), "p": p, "pada": str(d)}
        hit = [(pk, self.abnormal[pk]) for pk in self.abnormal if f in pk and pid in self.pairs.get(pk, {})]
        if hit:
            ring = self.ring_of(f)
            pk, a = max(hit, key=lambda x: x[1]["anggota"])
            g = pk[0] if pk[1] == f else pk[1]
            mit = []
            mg = self.meta.get(g) or {}
            if mg.get("kab") == c["kab"] and rank_of(mg.get("tipe")) != c["rank"]:
                mit.append({"kode": "JEJARING_RUJUKAN", "label": "pasangan faskes satu kab/kota beda kelas: bisa jejaring rujukan yang wajar", "faktor": 0.5})
            w = 1.0 + (0.4 if len(ring) >= 3 else 0.0)
            out.append(sig("CINCIN_FASKES", "Jaringan faskes tidak wajar", "JARINGAN_FASKES", a["anggota"] / 8 * w, w,
                           ("jaringan", "|".join(sorted(ring))),
                           f"{a['anggota']} peserta bersama dengan {mg.get('label', g)} dalam {self.days()} hari, ekspektasi riwayat pasangan ini "
                           f"{a['ekspektasi']:.2f} (Poisson p = {a['p']:.1e}); cincin {len(ring)} faskes", [], mit))
        # 6 cloning across members
        if c["ritl"] and c["biaya"] > 0 and abs(c["biaya"] - c["tarif_total"]) > 1000:
            ck = (f, d, c["kode"], c["dx3"], c["los"], c["biaya"], c.get("prosedur") or "")
            c["clone"] = ck
            self.clones[ck].add(key)
            others = [k2 for k2 in self.clones[ck] if k2 != key and k2 in self.claims and self.claims[k2]["pid"] != pid]
            n = len({self.claims[k2]["pid"] for k2 in others}) + 1
            if n >= 3:
                out.append(sig("KLONING_LINTAS_PESERTA", "Klaim kembar lintas peserta (cloning)", "KLONING_KLAIM", (n - 1) / 3, 1.0, ("faskes", f),
                               f"{n} peserta dengan klaim rawat inap identik (tanggal {d}, kode {c['kode']}, diagnosis {c['dx3']}, {c['los']} hari, "
                               f"tagihan Rp{c['biaya']:,.0f} yang bukan tarif paket)".replace(",", "."), others[:10]))
        else:
            c["clone"] = ("-",)
        # 7 a severity-III burst at the facility
        if c["ritl"]:
            q = self.fac_ritl[f]
            q.append((key, c["sev3"]))
            n, k = len(q), sum(1 for _, s in q if s)
            p0 = min(max(self.sev_base.get(f, self.sev_pop), 0.005), 0.9)
            if n >= 15 and k >= 5:
                p = binom_sf(k, n, p0)
                if p < P_BURST:
                    self.burst[f] = {"n": n, "k": k, "p0": p0, "p": p, "pada": str(d)}
                elif f in self.burst and p > 1e-2:
                    self.burst.pop(f, None)
            b = self.burst.get(f)
            if b and c["sev3"]:
                mit = []
                if (c.get("iomt") or {}).get("keparahan"):
                    mit.append({"kode": "BUKTI_PERANGKAT", "label": "bukti perangkat IoMT terverifikasi mendukung keparahan", "faktor": 0.5})
                out.append(sig("LONJAKAN_KEPARAHAN", "Lonjakan keparahan III (upcoding)", "UPCODING_KEPARAHAN", 1.0, 0.8, ("faskes", f),
                               f"{b['k']} dari {b['n']} klaim rawat inap terakhir faskes ini keparahan III, riwayatnya {b['p0']:.1%} "
                               f"(binomial p = {b['p']:.1e})", [], mit))
        # 8 risk by association: the facility is already in Box Karantina
        grp = self.box.get(f)
        if grp in ("A", "B", "C"):
            s = {"A": 1.0, "B": 0.6, "C": 0.3}[grp]
            out.append(sig("RISIKO_ASOSIASI", "Faskes sudah di Box Karantina", None, s, 0.25, ("faskes", f),
                           f"faskes ini di Box Karantina kelompok {grp} (indikasi dan estimasi kerugian sebelumnya)"))
        self.claims[key] = c
        if key not in self.by_member[pid]:
            self.by_member[pid].append(key)
        return out

    # -------------------------------------------------------------------------------------------------
    def ring_of(self, f: str) -> set[str]:
        adj: dict[str, set[str]] = collections.defaultdict(set)
        for a, b in self.abnormal:
            adj[a].add(b)
            adj[b].add(a)
        seen, todo = {f}, [f]
        while todo:
            x = todo.pop()
            for y in adj.get(x, ()):
                if y not in seen:
                    seen.add(y)
                    todo.append(y)
        return seen

    def rings(self) -> list[dict]:
        done: set[str] = set()
        out = []
        for a, b in self.abnormal:
            if a in done:
                continue
            ring = self.ring_of(a)
            done |= ring
            pairs = [(pk, v) for pk, v in self.abnormal.items() if pk[0] in ring]
            members = set()
            for pk, _ in pairs:
                members |= set(self.pairs.get(pk, {}))
            out.append({"id": "|".join(sorted(ring)), "faskes": [{"id": x, **(self.meta.get(x) or {})} for x in sorted(ring)],
                        "pasangan": [{"a": pk[0], "b": pk[1], **v} for pk, v in pairs], "peserta": len(members)})
        return sorted(out, key=lambda r: -r["peserta"])

    def ego(self, jenis: str, kunci: str, limit: int = 60) -> dict:
        """The neighbourhood of an entity for the investigation view: nodes (faskes, peserta) and edges (claims, abnormal pairs)."""
        nodes: dict[str, dict] = {}
        edges: list[dict] = []

        def fnode(f: str, focus: bool = False) -> str:
            m = self.meta.get(f) or {}
            nodes.setdefault("f:" + f, {"id": "f:" + f, "jenis": "faskes", "label": m.get("label") or f[:8], "kab": m.get("kab_nama"), "tipe": m.get("tipe"),
                                        "box": self.box.get(f), "burst": f in self.burst, "fokus": focus})
            return "f:" + f

        def pnode(pid: int, focus: bool = False) -> str:
            nodes.setdefault(f"p:{pid}", {"id": f"p:{pid}", "jenis": "peserta", "label": f"peserta …{str(pid)[-4:]}", "fokus": focus})
            return f"p:{pid}"

        def claim_edge(k: str) -> None:
            c = self.claims.get(k)
            if c:
                edges.append({"a": pnode(c["pid"]), "b": fnode(c["f"]), "jenis": "klaim", "klaim": k, "tanggal": str(c["d"]), "kode": c["kode"],
                              "ritl": c["ritl"], "biaya": c["biaya"]})

        if jenis == "faskes":
            fnode(kunci, True)
            mem = sorted(self.fac_members.get(kunci, {}).items(), key=lambda x: x[1], reverse=True)[:limit]
            for pid, _ in mem:
                for k in self.by_member.get(pid, [])[-6:]:
                    claim_edge(k)
        elif jenis == "peserta":
            pid = int(kunci)
            pnode(pid, True)
            for k in self.by_member.get(pid, []):
                claim_edge(k)
        elif jenis == "jaringan":
            ring = kunci.split("|")
            for f in ring:
                fnode(f, True)
            shared = set()
            for pk in self.abnormal:
                if pk[0] in ring and pk[1] in ring:
                    shared |= set(self.pairs.get(pk, {}))
            for pid in list(shared)[:limit]:
                for k in self.by_member.get(pid, []):
                    if self.claims.get(k, {}).get("f") in ring:
                        claim_edge(k)
        for (a, b), v in self.abnormal.items():
            if "f:" + a in nodes and "f:" + b in nodes:
                edges.append({"a": "f:" + a, "b": "f:" + b, "jenis": "pasangan_tidak_wajar", "anggota": v["anggota"], "ekspektasi": v["ekspektasi"], "p": v["p"]})
        # duplicate claim edges collapse to one per pair of nodes per kind and date
        seen, uniq = set(), []
        for e in edges:
            sk = (e["a"], e["b"], e["jenis"], e.get("klaim"))
            if sk not in seen:
                seen.add(sk)
                uniq.append(e)
        return {"nodes": list(nodes.values()), "edges": uniq[:600], "jendela_hari": WINDOW_DAYS, "jam_peristiwa": str(self.clock) if self.clock else None}

    def summary(self) -> dict:
        return {"klaim_di_jendela": len(self.claims), "peserta": len(self.by_member), "faskes": len(self.fac_members),
                "pasangan_faskes": len(self.pairs), "pasangan_tidak_wajar": len(self.abnormal), "cincin": len(self.rings()),
                "lonjakan_keparahan": len(self.burst), "hari_teramati": self.days(), "jam_peristiwa": str(self.clock) if self.clock else None,
                "mulai": str(self.start) if self.start else None}


def build_baselines(con: Any, edisi: str, start: date, days: int = 60) -> tuple[dict, dict, float]:
    """From the member history before the stream window (the feature store's peserta table, already loaded in `con`):
    each facility pair's shared members per day, each facility's severity-III share (the store's facility profile), and
    the population's share."""
    lo = start - timedelta(days=days)
    rows = con.execute(f"""
WITH h AS (SELECT DISTINCT peserta_id, faskes_profil_id FROM peserta WHERE edisi = '{edisi}' AND tgl_datang >= DATE '{lo}' AND tgl_datang < DATE '{start}'),
m AS (SELECT peserta_id FROM h GROUP BY 1 HAVING count(*) BETWEEN 2 AND 12)
SELECT a.faskes_profil_id AS fa, b.faskes_profil_id AS fb, count(*) AS n
FROM h a JOIN h b ON a.peserta_id = b.peserta_id AND a.faskes_profil_id < b.faskes_profil_id
WHERE a.peserta_id IN (SELECT peserta_id FROM m) GROUP BY 1, 2""").fetchall()
    pair_rate = {(a, b): n / days for a, b, n in rows}
    # f_pct_keparahan_berat: the share (0-1) of the facility's RITL claims with severity III (ml_klaim.py)
    sev = {f: float(v) for f, v in
           con.execute("SELECT faskes_profil_id, f_pct_keparahan_berat FROM faskes WHERE f_pct_keparahan_berat IS NOT NULL").fetchall()}
    vals = sorted(sev.values())
    pop = vals[len(vals) // 2] if vals else 0.05
    return pair_rate, sev, pop if pop > 0 else 0.05
