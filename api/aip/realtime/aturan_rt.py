"""Claim rules that read the member registry (entity resolution: who the card belongs to), the code references and the
lines a hospital sends with its claim. Each returns signals (graf.sig); their weight, tag and modes come from
modus.SIGNALS when the engine scores them.

  KLAIM_SETELAH_MENINGGAL   the registry's death year is before the service year (registry, coarse: the year only)
  MENINGGAL_TERCATAT        an earlier claim or visit in the stream ended with the member's death (graf.deaths)
  TIDAK_SESUAI_PESERTA      a diagnosis or INA-CBG group impossible for the card holder's sex or age (obstetric, male-
                            or female-only, perinatal)
  KARTU_KELUARGA            ... and another member of the same family fits it: the card of a relative was likely used
  PASANGAN_KODE_LANGKA      a diagnosis → INA-CBG pair seen <= 3 times among >= 1,000 claims of that diagnosis
  KODE_PROSEDUR_TANPA_TINDAKAN  a procedure group (the code's 2nd digit 1–3) with no procedure on the claim
  DX_SEKUNDER_BERLEBIH      secondary diagnoses above the code's p99 + 2
  KELAS_DI_ATAS_HAK         inpatient class above the member's entitlement (PBI may not upgrade; others may, paying the
                            difference: mitigated)
  TOPUP_TIDAK_LAZIM         a special-CMG top-up type the code almost never carries (<= 2 of >= 200 claims)
  TOPUP_DI_ATAS_PEER        a top-up above 1.5× the p95 of that code and type (>= 20 claims with it)
  OBAT_DIKURANGI / OBAT_TIDAK_DISERAHKAN / HASIL_PEMERIKSAAN_TIDAK_COCOK   the hospital's dispensing and result lines
"""

from __future__ import annotations

from datetime import date
from typing import Any, Optional

from aip.realtime.graf import sig
from aip.realtime.referensi import TOPUPS

PBI = ("PBI APBN", "PBI APBD")
SEX_ONLY_M = (("N40", "N51"), ("C60", "C63"))
SEX_ONLY_F = (("N70", "N98"), ("C51", "C58"), ("O00", "O99"))


def _in(dx: str, ranges: tuple) -> bool:
    return any(a <= dx <= b for a, b in ranges)


def _age(born: Any, at: date) -> Optional[float]:
    if born is None or born != born:
        return None
    # a pandas Timestamp (or datetime) is a date subclass that cannot be subtracted from a date: take its date
    b = born.date() if hasattr(born, "hour") else born
    a = at.date() if hasattr(at, "hour") else at
    return (a - b).days / 365.25


def mismatch(dx: Optional[str], code: Optional[str], jk: Optional[str], age: Optional[float]) -> Optional[str]:
    """Why the diagnosis/code cannot belong to this card holder, or None."""
    dx = dx or ""
    obst = dx.startswith("O") or (code or "").startswith("O-")
    if jk == "L" and (obst or _in(dx, SEX_ONLY_F)):
        return f"diagnosis/kode {dx or code} hanya untuk perempuan, pemegang kartu laki-laki"
    if jk == "P" and _in(dx, SEX_ONLY_M):
        return f"diagnosis {dx} hanya untuk laki-laki, pemegang kartu perempuan"
    if obst and age is not None and (age < 10 or age > 55):
        return f"diagnosis/kode kebidanan {dx or code}, usia pemegang kartu {age:.0f} tahun"
    if dx.startswith("P") and age is not None and age > 1.5:
        return f"diagnosis perinatal {dx}, usia pemegang kartu {age:.0f} tahun"
    return None


def fits(dx: Optional[str], code: Optional[str], jk: Optional[str], age: Optional[float]) -> bool:
    return mismatch(dx, code, jk, age) is None and jk is not None and age is not None


def claim_rules(c: Any, ref: dict, m: Optional[dict], R: Any, con: Any, meta: dict, deaths: dict[int, date]) -> list[dict]:
    out: list[dict] = []
    d: date = c.tgl_datang
    f = ref["f"]
    pid = int(c.peserta_id)
    # death: in the stream (strong), in the registry (coarse)
    dd = deaths.get(pid)
    if dd and d > dd:
        out.append(sig("MENINGGAL_TERCATAT", "", None, 1.0, 0, ("peserta", str(pid)),
                       f"klaim/kunjungan sebelumnya peserta ini berakhir meninggal pada {dd}; klaim ini masuk {d}"))
    if m:
        ym = m.get("tahun_meninggal")
        if ym is not None and ym == ym and int(ym) < d.year:
            gap = d.year - int(ym)
            out.append(sig("KLAIM_SETELAH_MENINGGAL", "", None, 1.0 if gap >= 2 else 0.6, 0, ("peserta", str(pid)),
                           f"registri kepesertaan mencatat peserta meninggal tahun {int(ym)}; layanan tahun {d.year}",
                           mitigasi=[{"kode": "REGISTRI_TAHUN", "label": "registri hanya mencatat tahun kematian (bisa terlambat/keliru dicatat)", "faktor": 0.3}]
                           if gap < 2 else []))
        age = _age(m.get("tgl_lahir"), d)
        why = mismatch(c.dx_primer_icd3, c.inacbg_kode, m.get("jk"), age)
        if why:
            mit = []
            if m.get("tgl_lahir_pengganti") is True or m.get("tgl_lahir_pengganti") == 1:
                mit.append({"kode": "TGL_LAHIR_PENGGANTI", "label": "tanggal lahir di registri adalah tanggal pengganti", "faktor": 0.5})
            out.append(sig("TIDAK_SESUAI_PESERTA", "", None, 1.0, 0, ("faskes", f), why, [], mit))
            kel = m.get("keluarga_id")
            kel = kel if kel is not None and kel == kel else None
            fam = [x for x in R.family(con, c.edisi, kel, pid) if fits(c.dx_primer_icd3, c.inacbg_kode, x.get("jk"), _age(x.get("tgl_lahir"), d))]
            if fam:
                out.append(sig("KARTU_KELUARGA", "", None, 1.0, 0, ("peserta", str(pid)),
                               f"{len(fam)} anggota keluarga yang sama (…{str(fam[0]['peserta_id'])[-4:]}) cocok dengan diagnosis ini: kartu kerabat "
                               "kemungkinan dipakai", [f"peserta:{x['peserta_id']}" for x in fam[:5]]))
        # class above the entitlement
        hak = m.get("hak")
        hak = int(hak) if hak is not None and hak == hak else None  # a missing entitlement arrives as NaN from pandas
        kelas = _kelas(c.kelas_rawat)
        if c.tingkat_pelayanan == "RITL" and hak and kelas and kelas < hak:
            pbi = m.get("segmen") in PBI
            mit = [] if pbi else [{"kode": "NAIK_KELAS_SENDIRI", "label": "peserta non-PBI boleh naik kelas atas permintaan sendiri (membayar selisih)", "faktor": 0.6}]
            out.append(sig("KELAS_DI_ATAS_HAK", "", None, 1.0, 0, ("faskes", f),
                           f"dirawat di Kelas {kelas}, hak kelas peserta Kelas {int(hak)} ({m.get('segmen') or '-'}{'; PBI tidak boleh naik kelas' if pbi else ''})",
                           [], mit))
    elif meta.get("hak_kelas") and c.tingkat_pelayanan == "RITL":
        kelas = _kelas(c.kelas_rawat)
        if kelas and kelas < int(meta["hak_kelas"]):
            out.append(sig("KELAS_DI_ATAS_HAK", "", None, 1.0, 0, ("faskes", f),
                           f"dirawat di Kelas {kelas}, hak kelas di SEP Kelas {meta['hak_kelas']} (kiriman faskes)", [],
                           [{"kode": "NAIK_KELAS_SENDIRI", "label": "naik kelas atas permintaan sendiri dimungkinkan untuk peserta non-PBI", "faktor": 0.6}]))
    # the code against its references
    rp = R.rare_pair(c.dx_primer_icd3, c.inacbg_kode)
    if rp:
        out.append(sig("PASANGAN_KODE_LANGKA", "", None, 1.0, 0, ("faskes", f),
                       f"diagnosis {c.dx_primer_icd3} dengan kode {c.inacbg_kode}: {rp[0]} kali dari {rp[1]:,} klaim diagnosis ini setahun".replace(",", ".")))
    code = c.inacbg_kode or ""
    if len(code) > 2 and code[2] in "123" and not (c.prosedur or "").strip():
        out.append(sig("KODE_PROSEDUR_TANPA_TINDAKAN", "", None, 1.0, 0, ("faskes", f),
                       f"kode {code} adalah kelompok prosedur (digit {code[2]}) tetapi klaim tidak mencantumkan tindakan apa pun"))
    k = R.kode.get(code)
    if k and k["n"] >= 200 and c.jumlah_dx_sekunder is not None and c.jumlah_dx_sekunder > k["dx_sek_p99"] + 2:
        out.append(sig("DX_SEKUNDER_BERLEBIH", "", None, 1.0, 0, ("faskes", f),
                       f"{c.jumlah_dx_sekunder} diagnosis sekunder, p99 kode {code} {k['dx_sek_p99']:.0f}"))
    for col, label in TOPUPS.items():
        v = getattr(c, col, 0) or 0
        if v <= 0:
            continue
        t = R.topup.get((code, col))
        if k and k["n"] >= 200 and t and t["n"] <= 2:
            out.append(sig("TOPUP_TIDAK_LAZIM", "", None, 1.0, 0, ("faskes", f),
                           f"top-up {label} Rp{v:,.0f} pada kode {code}, yang hanya {t['n']} kali membawa top-up itu dari {k['n']:,} klaim setahun".replace(",", ".")))
        elif t and t["n"] >= 20 and t["p95"] > 0 and v > 1.5 * t["p95"]:
            out.append(sig("TOPUP_DI_ATAS_PEER", "", None, min(1.0, (v / t["p95"] - 1)), 0, ("faskes", f),
                           f"top-up {label} Rp{v:,.0f} = {v / t['p95']:.1f}× p95 kode {code} (Rp{t['p95']:,.0f})".replace(",", ".")))
    # the hospital's lines: dispensing (M17, M18) and results against the device/LIS (M20)
    for o in meta.get("obat") or []:
        bill, given, rx = float(o.get("ditagih") or 0), float(o.get("diserahkan") or 0), float(o.get("diresepkan") or 0)
        name = o.get("nama") or o.get("kode") or "obat"
        if bill > 0 and given <= 0:
            out.append(sig("OBAT_TIDAK_DISERAHKAN", "", None, 1.0, 0, ("faskes", f), f"{name}: ditagih {bill:g}, diserahkan 0"))
        elif bill > 0 and given < bill:
            out.append(sig("OBAT_DIKURANGI", "", None, min(1.0, (bill - given) / bill * 2), 0, ("faskes", f),
                           f"{name}: diresepkan {rx:g}, ditagih {bill:g}, diserahkan {given:g}"))
    for p in meta.get("pemeriksaan") or []:
        a, b = p.get("nilai_klaim"), p.get("nilai_alat")
        if a is None or b is None:
            continue
        tol = float(p.get("toleransi") or 0.15)
        diff = abs(float(a) - float(b)) / max(abs(float(b)), 1e-9)
        if diff > tol:
            out.append(sig("HASIL_PEMERIKSAAN_TIDAK_COCOK", "", None, min(1.0, diff / (3 * tol)), 0, ("faskes", f),
                           f"{p.get('parameter')}: di klaim {a} {p.get('satuan') or ''}, dari alat/LIS {b} (selisih {diff:.0%}, toleransi {tol:.0%})"))
    return out


def _kelas(v: Any) -> Optional[int]:
    if not v:
        return None
    s = str(v).strip()[-1:]
    return int(s) if s in "123" else None


def visit_rules(pid: int, d: date, m: Optional[dict], f: str, deaths: dict[int, date], what: str) -> list[dict]:
    """Death against an FKTP visit or a non-capitation claim."""
    out = []
    dd = deaths.get(pid)
    if dd and d > dd:
        out.append(sig("MENINGGAL_TERCATAT", "", None, 1.0, 0, ("peserta", str(pid)), f"peserta tercatat meninggal {dd} di aliran; {what} {d}"))
    elif m and m.get("tahun_meninggal") is not None and m["tahun_meninggal"] == m["tahun_meninggal"] and int(m["tahun_meninggal"]) < d.year - 1:
        out.append(sig("KUNJUNGAN_SETELAH_MENINGGAL", "", None, 1.0, 0, ("faskes", f),
                       f"registri mencatat peserta meninggal tahun {int(m['tahun_meninggal'])}; {what} {d}"))
    return out
