"""The investigation network of /testing, built the way an entity-resolution graph tool shows it: documents (claims) and
entities (resolved members, hospitals, the INA-CBG code) joined by edges. A claim's network starts from the claim (the
focal document), adds its member and hospital, the earlier claims the models compared it with (Model 1's neighbours),
and the ring Model 2 measured (the other hospitals the member visited within +-14 days, and the claims of members
shared by both hospitals). Any node can be expanded. Members are shown pseudonymised (P-xxxxx). Synthetic data only."""
from __future__ import annotations

import hashlib
from typing import Any, Optional

from fitur import CAPS, RELASI_NAMA

MAKS_KLAIM_EKSPANSI = 14


def samar(pid: Any) -> str:
    return f"P-{hashlib.md5(str(pid).encode()).hexdigest()[:5].upper()}"


class Jaringan:
    """Builds node/link sets over the stream. `view[i]` is the claim summary (penjelas.ringkas), `labels` the hospital
    labels, `peta_samar` maps the pseudonym back to the stream's member id (only inside the service)."""

    def __init__(self, st: Any, view: list[dict], labels: dict) -> None:
        self.st, self.view, self.labels = st, view, labels
        self.peta_samar: dict[str, Any] = {}
        for fd in st.f:
            self.peta_samar.setdefault(samar(fd["peserta"]), fd["peserta"])

    def baru(self, i: int) -> None:
        self.peta_samar.setdefault(samar(self.st.f[i]["peserta"]), self.st.f[i]["peserta"])

    # ---- nodes
    def _klaim(self, g: dict, j: int, **extra: Any) -> str:
        v, fd = self.view[j], self.st.f[j]
        nid = f"k:{j}"
        if nid not in g["_seen"]:
            g["_seen"].add(nid)
            g["nodes"].append({"id": nid, "tipe": "klaim", "label": f"{v['tgl']} · {v['kode']}", "idx": j, "tgl": v["tgl"], "kode": v["kode"],
                               "dx": v["dx"], "biaya": v["biaya"], "keputusan": v["keputusan"], "rs": v["rs"], "peserta": samar(fd["peserta"]),
                               "tingkat": v.get("tingkat"), "los": v.get("los"), "modus": v.get("modus") or [], "alasan": v.get("alasan") or [], **extra})
        else:
            self._tambah(g, nid, extra)
        return nid

    @staticmethod
    def _tambah(g: dict, nid: str, extra: dict) -> None:
        for n in g["nodes"]:
            if n["id"] == nid:
                for k, v_ in extra.items():
                    if k == "sorot":
                        n["sorot"] = sorted(set(n.get("sorot") or []) | set(v_ or []))
                    elif v_ and not n.get(k):
                        n[k] = v_

    def _peserta(self, g: dict, pid: Any, **extra: Any) -> str:
        s = samar(pid)
        nid = f"p:{s}"
        if nid not in g["_seen"]:
            g["_seen"].add(nid)
            g["nodes"].append({"id": nid, "tipe": "peserta", "label": s, "klaim_di_aliran": len(self.st.by_mem.get(pid, [])), **extra})
        elif extra:
            self._tambah(g, nid, extra)
        return nid

    def _rs(self, g: dict, fac: str, **extra: Any) -> str:
        nid = f"f:{fac}"
        if nid not in g["_seen"]:
            g["_seen"].add(nid)
            g["nodes"].append({"id": nid, "tipe": "rs", "label": self.labels.get(fac, fac) or fac, "klaim_di_aliran": len(self.st.by_fac.get(fac, [])), **extra})
        elif extra:
            self._tambah(g, nid, extra)
        return nid

    def _kode(self, g: dict, kode: str) -> str:
        nid = f"c:{kode}"
        if nid not in g["_seen"]:
            g["_seen"].add(nid)
            g["nodes"].append({"id": nid, "tipe": "kode", "label": f"INA-CBG {kode}", "klaim_di_aliran": len(self.st.rel["kode"].get(kode, []))})
        return nid

    def _link(self, g: dict, a: str, b: str, rel: str, **extra: Any) -> None:
        key = (a, b, rel)
        if key not in g["_links"]:
            g["_links"].add(key)
            g["links"].append({"source": a, "target": b, "rel": rel, **extra})

    def _dokumen(self, g: dict, j: int, **extra: Any) -> str:
        """A claim with its two entities (member, hospital)."""
        fd = self.st.f[j]
        k = self._klaim(g, j, **extra)
        self._link(g, k, self._peserta(g, fd["peserta"]), "milik peserta")
        self._link(g, k, self._rs(g, fd["faskes"]), "di RS")
        return k

    @staticmethod
    def _kosong() -> dict:
        return {"nodes": [], "links": [], "_seen": set(), "_links": set()}

    @staticmethod
    def _selesai(g: dict, **meta: Any) -> dict:
        return {"nodes": g["nodes"], "links": g["links"], **meta}

    # ---- the focal claim's network
    def fokus(self, i: int, ring: dict) -> dict:
        g = self._kosong()
        fd = self.st.f[i]
        k = self._dokumen(g, i, fokus=True, sorot=["fokus"])
        self._link(g, k, self._kode(g, fd["kode"]), "kode INA-CBG")
        # Model 1: the earlier claims compared per relation (documents linked through their own entities)
        for r, ids in self.st.neighbours(i).items():
            for j in ids[-6:]:
                kj = self._dokumen(g, j, sorot=["model1"], relasi=RELASI_NAMA[r])
                if r == "kode":
                    self._link(g, kj, self._kode(g, fd["kode"]), "kode INA-CBG")
                elif r == "faskes_kode":
                    self._link(g, kj, self._kode(g, fd["kode"]), "kode INA-CBG")
        # Model 2: the ring within +-14 days: the member's claims at other hospitals, and the shared members' claims
        d = fd["day"]
        for h in ring["w14"]["rs"][:5]:
            fac = h["faskes"]
            self._rs(g, fac, sorot=["model2"])
            for dd, j, gg in self.st.by_mem[fd["peserta"]]:
                if gg == fac and abs(dd - d) <= 14 and j != i:
                    self._dokumen(g, j, sorot=["model2"])
            for s in h["peserta"][:8]:
                pid = self.peta_samar.get(s)
                if pid is None:
                    continue
                self._peserta(g, pid, sorot=["model2"])
                for dd, j, gg in self.st.by_mem[pid]:
                    if gg in (fac, fd["faskes"]) and abs(dd - d) <= 14:
                        self._dokumen(g, j, sorot=["model2"])
        for n in g["nodes"]:
            n.setdefault("sorot", [])
        return self._selesai(g, fokus=f"k:{i}")

    # ---- expansion of one node
    def ekspansi(self, nid: str, sekitar_hari: Optional[int] = None) -> dict:
        g = self._kosong()
        kind, _, key = nid.partition(":")
        if kind == "k":
            j = int(key)
            if not 0 <= j < len(self.st.f):
                raise KeyError(nid)
            self._dokumen(g, j)
            for r, ids in self.st.neighbours(j).items():
                for jj in ids[-4:]:
                    self._dokumen(g, jj, relasi=RELASI_NAMA[r])
        elif kind == "p":
            pid = self.peta_samar.get(key)
            if pid is None:
                raise KeyError(nid)
            for _dd, j, _g in self.st.by_mem[pid][-MAKS_KLAIM_EKSPANSI:]:
                self._dokumen(g, j)
        elif kind == "f":
            v = self.st.by_fac.get(key)
            if v is None:
                raise KeyError(nid)
            rows = v if sekitar_hari is None else [x for x in v if abs(x[0] - sekitar_hari) <= 7]
            for _dd, j, _m in rows[-MAKS_KLAIM_EKSPANSI:]:
                self._dokumen(g, j)
        elif kind == "c":
            for j in self.st.rel["kode"].get(key, [])[-MAKS_KLAIM_EKSPANSI:]:
                k = self._dokumen(g, j)
                self._link(g, k, self._kode(g, key), "kode INA-CBG")
        else:
            raise KeyError(nid)
        for n in g["nodes"]:
            n.setdefault("sorot", [])
        return self._selesai(g, dari=nid)

    def lini_masa(self, nid: str) -> list[dict]:
        """The member's claims in time order (for the data viewer)."""
        kind, _, key = nid.partition(":")
        if kind != "p" or key not in self.peta_samar:
            return []
        out = []
        for dd, j, fac in sorted(self.st.by_mem[self.peta_samar[key]]):
            v = self.view[j]
            out.append({"id": f"k:{j}", "tgl": v["tgl"], "rs": v["rs"], "kode": v["kode"], "tingkat": v.get("tingkat"), "los": v.get("los"),
                        "biaya": v["biaya"], "keputusan": v["keputusan"]})
        return out[-40:]

    def tetangga(self, i: int) -> list[dict]:
        """Model 1's neighbours as a list (what the LLM reads)."""
        out = []
        for r, ids in self.st.neighbours(i).items():
            for j in ids[-6:]:
                v = self.view[j]
                out.append({"relasi": RELASI_NAMA[r], "tgl": v["tgl"], "kode": v["kode"], "rs": v["rs"], "dx": v["dx"], "biaya": v["biaya"],
                            "lama_rawat": v.get("los"), "keputusan_rule": v["keputusan"], "peserta": samar(self.st.f[j]["peserta"])})
        return out


__all__ = ["Jaringan", "samar", "CAPS"]
