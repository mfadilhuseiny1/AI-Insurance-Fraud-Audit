"""Entity resolution of the realtime stream: who and what a claim is about, resolved before it is scored.

- Members of the platform's claims (aip/layanan.KlaimIn) come with a member number: the sample (and its synthetic twin)
  carries pseudonymous numbers, so a member resolves by that key exactly. The honest limit: without names or birth
  dates there is nothing to match fuzzily, and the sample has no real facility ids either (a facility is a profile:
  kab/kota, ownership, kind, type — aip/layanan.profile_id).
- Patients of a hospital system's submission (ai-jkn's Kodifikasi) come as the hospital's own keys: a medical-record
  number, a SEP number and a name. They resolve here, Quantexa-style, to one patient entity:
    1. the same source and RM number          → the same entity (the hospital's key); a name that does not match the
                                                 entity's names is kept as a quality flag (over-linking: one RM number
                                                 carrying two people)
    2. otherwise a blocking key (the name's sorted tokens' first letters and length class) finds candidates; a
       candidate with a Jaro-Winkler similarity >= 0.93 is NOT merged (another RM number may be another person: a
       namesake) but recorded on both entities as a possible duplicate identity (under-linking) for a person to check
    3. else a new entity
  Each decision carries its rule and similarity, and each entity a quality score (1 − flags), as an investigator needs.
- The facility of a hospital submission is the insurer's own registry of that source (sumber.json, set in the
  Integrasi view): the insurer does not take a hospital's word for its own class or ownership.

Names are kept normalised (lower case, no titles or punctuation) for matching, and shown masked (B**** S*******).
"""

from __future__ import annotations

import hashlib
import re
import threading
import unicodedata
from typing import Any, Optional

TITLES = {"tn", "ny", "nn", "nona", "nyonya", "tuan", "an", "anak", "by", "bayi", "sdr", "sdri", "bpk", "bp", "bapak", "ibu", "bu", "dr", "drg",
          "h", "hj", "ir", "prof", "skm", "spd", "st", "se", "mm", "amd", "ners", "sked", "skom", "sh", "mh", "mkes", "alm", "almh"}
MATCH = 0.93  # a candidate of another RM number this similar is a possible duplicate identity (recorded, not merged)
SAME_RM_MIN = 0.80  # below this, two names on one RM number are a quality flag
MEMBER_BASE = 8_000_000_000_000  # member numbers of resolved hospital patients: far above the sample's own


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z\s]", " ", s)
    toks = [t for t in s.split() if t not in TITLES and len(t) > 1]
    return " ".join(toks)


def mask(name: str) -> str:
    return " ".join(t[0].upper() + "*" * (len(t) - 1) for t in (name or "").split()) or "-"


def jaro(a: str, b: str) -> float:
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if not la or not lb:
        return 0.0
    d = max(la, lb) // 2 - 1
    ma, mb = [False] * la, [False] * lb
    m = 0
    for i, c in enumerate(a):
        for j in range(max(0, i - d), min(lb, i + d + 1)):
            if not mb[j] and b[j] == c:
                ma[i] = mb[j] = True
                m += 1
                break
    if not m:
        return 0.0
    t, k = 0, 0
    for i in range(la):
        if ma[i]:
            while not mb[k]:
                k += 1
            if a[i] != b[k]:
                t += 1
            k += 1
    return (m / la + m / lb + (m - t / 2) / m) / 3


def jaro_winkler(a: str, b: str) -> float:
    j = jaro(a, b)
    p = 0
    for x, y in zip(a[:4], b[:4]):
        if x != y:
            break
        p += 1
    return j + p * 0.1 * (1 - j)


def similarity(a: str, b: str) -> float:
    """The better of the names as written and with their tokens sorted (word order varies: "Siti Aminah" / "Aminah Siti")."""
    if not a or not b:
        return 0.0
    return max(jaro_winkler(a, b), jaro_winkler(" ".join(sorted(a.split())), " ".join(sorted(b.split()))))


def block_key(name: str) -> str:
    toks = sorted(name.split())
    return "".join(t[0] for t in toks[:3]) + str(min(len(name) // 6, 5))


class Resolver:
    """The patient entities of hospital submissions, kept in the realtime store (store.py) and in memory."""

    def __init__(self, store: Any) -> None:
        self.store = store
        self.lock = threading.Lock()
        self.by_rm: dict[tuple[str, str], str] = {}
        self.blocks: dict[str, set[str]] = {}
        self.ents: dict[str, dict] = {}
        for e in store.entities("pasien"):
            self._index(e)

    def _index(self, e: dict) -> None:
        self.ents[e["id"]] = e
        for rm in e["rm"]:
            self.by_rm[(e["sumber"], rm)] = e["id"]
        for n in e["nama"]:
            self.blocks.setdefault(block_key(n), set()).add(e["id"])

    def resolve(self, sumber: str, no_rm: str, nama: str, no_sep: str = "") -> dict:
        """One patient of a hospital submission → its entity, with the rule that resolved it."""
        rm = re.sub(r"\s+", "", no_rm or "").upper()
        n = norm_name(nama)
        with self.lock:
            eid = self.by_rm.get((sumber, rm)) if rm else None
            flags: list[str] = []
            if eid:
                e = self.ents[eid]
                best = max((similarity(n, x) for x in e["nama"]), default=1.0) if n else 1.0
                rule, score = "cocok_no_rm", 1.0
                if n and n not in e["nama"]:
                    if best < SAME_RM_MIN:
                        flags.append(f"no RM {rm} dipakai nama lain (kemiripan {best:.2f}): kemungkinan dua orang pada satu no RM")
                    e["nama"].append(n)
                    self.blocks.setdefault(block_key(n), set()).add(eid)
            else:
                cands = []
                if n:
                    for cid in self.blocks.get(block_key(n), set()):
                        c = self.ents[cid]
                        if c["sumber"] != sumber:
                            continue
                        s = max(similarity(n, x) for x in c["nama"])
                        if s >= MATCH:
                            cands.append((s, cid))
                eid = "pt-" + hashlib.sha1(f"{sumber}|{rm or n}".encode()).hexdigest()[:12]
                e = {"id": eid, "jenis": "pasien", "sumber": sumber, "rm": [rm] if rm else [], "nama": [n] if n else [], "sep": [],
                     "kandidat_sama": [], "flag": [], "peserta_id": MEMBER_BASE + int(hashlib.sha1(eid.encode()).hexdigest()[:10], 16) % 10**12}
                rule, score = "baru", 1.0
                for s, cid in sorted(cands, reverse=True)[:5]:
                    e["kandidat_sama"].append({"entitas": cid, "kemiripan": round(s, 3)})
                    other = self.ents[cid]
                    if not any(k["entitas"] == eid for k in other["kandidat_sama"]):
                        other["kandidat_sama"].append({"entitas": eid, "kemiripan": round(s, 3)})
                        self.store.put_entity(other)
                if cands:
                    flags.append(f"nama mirip pasien lain di faskes ini dengan no RM berbeda (kemiripan {max(cands)[0]:.2f}): "
                                 "kemungkinan identitas ganda, tidak digabung otomatis")
                self._index(e)
            if no_sep and no_sep not in e["sep"]:
                e["sep"] = (e["sep"] + [no_sep])[-20:]
            for f in flags:
                if f not in e["flag"]:
                    e["flag"].append(f)
            e["kualitas"] = round(max(0.0, 1 - 0.25 * len(e["flag"])), 2)
            self.store.put_entity(e)
            return {"entitas": eid, "peserta_id": e["peserta_id"], "aturan": rule, "kemiripan": score, "flag": flags,
                    "nama_samaran": mask(n), "kualitas": e["kualitas"], "kandidat_sama": e["kandidat_sama"][:5]}

    def view(self, eid: str) -> Optional[dict]:
        e = self.ents.get(eid)
        if not e:
            return None
        return {"id": e["id"], "sumber": e["sumber"], "no_rm": e["rm"], "nama": [mask(n) for n in e["nama"]], "sep": len(e["sep"]),
                "kandidat_sama": e["kandidat_sama"], "flag": e["flag"], "kualitas": e.get("kualitas", 1.0), "peserta_id": e["peserta_id"]}
