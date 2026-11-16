"""Packages the theme dataset (testing/gen_tema.py claims + testing/rekam_medis.py medical records) for use and handover:

  klaim/     the claims WITHOUT labels: every claim of the replicas' population (the stream an audit run would see) and the
             theme's claims at the branch's hospitals (parquet + CSV)
  peserta/   the members (sex, age, class entitlement): what a rule engine needs to check identity against the record
  kunci/     the answer key, kept apart: fraud labels per claim with the TRUE loss, and the planted medical-record mismatches
             and noise per claim; the generator's raw replica files (labels included) under kunci/mentah
  contoh/    example FHIR Bundles of single claims (a fake cardiac catheterisation, a cancelled one, upcoding, a borrowed card,
             a copied record, an honest catheterisation), each with its claim row and key row
  README.md, ringkasan.json

The true loss of a fraud claim: the whole bill for an identity scheme (fictitious claim, borrowed card, invented routine
session, duplicate) and for a claim a scheme added; for a claim a scheme changed, its bill minus its bill before the change
(signed: a split stay's first part can bill less than the whole stay did). The quality deviation (pulang_dini) is not fraud.
Every FHIR resource is checked: required elements of its ID Core profile as used here, unique ids, references resolving
inside its replica. Synthetic data only.

Usage: .venv/Scripts/python.exe testing/paket_tema.py [--folder "Data Sintetis/tema_jantung_kc_sul-7371"]"""
from __future__ import annotations

import argparse
import gzip
import json
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
# the whole bill is the loss: no service as billed (identity schemes, a duplicate; a cancelled surgery billed as done: an upper
# bound, the short pre-operative stay itself could be payable)
IDENTITAS = {"klaim_fiktif", "kartu_dipinjam", "sesi_rutin_fiktif", "klaim_berulang", "operasi_batal_ditagih"}
WAJIB = {  # required elements per resource as written here (ID Core minimum cardinality 1 that applies)
    "Patient": ["identifier", "name", "multipleBirthBoolean"], "Encounter": ["identifier", "status", "statusHistory", "class", "subject", "period", "serviceProvider"],
    "Condition": ["code", "subject", "encounter"], "Procedure": ["status", "code", "subject", "encounter"], "Observation": ["status", "code", "subject", "encounter"],
    "Medication": ["extension", "code"], "MedicationRequest": ["status", "intent", "medicationReference", "subject"],
    "MedicationDispense": ["status", "subject", "context"], "Composition": ["status", "type", "subject", "date", "author", "title"],
    "Organization": ["identifier", "name"], "Practitioner": ["identifier", "name"], "Location": ["name"], "DiagnosticReport": ["status", "code", "subject"],
}
KATETER = r"\b(?:3606|3607|0066|885[3-7]|372[123])"
CONTOH = [("tindakan_fiktif_kateter", "tindakan_fiktif", KATETER), ("operasi_batal_kateter", "operasi_batal_ditagih", KATETER),
          ("klaim_fiktif_tanpa_rm", "klaim_fiktif", None), ("rujukan_semu", "rujukan_semu", None), ("dokter_tiga_rs", "dokter_tiga_rs", None),
          ("upcoding_keparahan", "upcoding_keparahan", None), ("kartu_dipinjam", "kartu_dipinjam", None), ("kloning_rekam_medis", "kloning", None),
          ("diagnosis_utama_diganti", "diagnosis_utama_diganti", None), ("jujur_kateter", "normal", r"\b(?:3607|0066)")]


def polos(v):
    """A value as plain JSON: numpy scalars to Python numbers, dates to ISO text, NaN to null."""
    if hasattr(v, "item") and not isinstance(v, (str, bytes)):
        v = v.item()
    if isinstance(v, float) and v != v:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else v


def rp_m(v: float) -> str:
    return f"Rp{v / 1e9:,.2f} miliar".replace(",", "X").replace(".", ",").replace("X", ".")


def angka(v: float) -> str:
    return f"{int(v):,}".replace(",", ".")


def cek_fhir(folder: Path) -> dict:
    """Structure and references of every resource, per replica."""
    masalah: Counter = Counter()
    contoh_masalah: dict[str, str] = {}
    n = 0
    for d in sorted((folder / "rekam_medis").glob("replika_*")):
        ids: dict[str, set] = defaultdict(set)
        refs = []
        for f in d.glob("*.ndjson.gz"):
            with gzip.open(f, "rt", encoding="utf-8") as fh:
                for line in fh:
                    x = json.loads(line)
                    n += 1
                    t = x["resourceType"]
                    if x["id"] in ids[t]:
                        masalah[f"{t}: id ganda"] += 1
                    ids[t].add(x["id"])
                    if not (x.get("meta") or {}).get("profile"):
                        masalah[f"{t}: tanpa meta.profile"] += 1
                    for w in WAJIB.get(t, []):
                        if x.get(w) in (None, "", [], {}):
                            masalah[f"{t}: {w} kosong"] += 1
                            contoh_masalah.setdefault(f"{t}: {w} kosong", x["id"])
                    if t == "Procedure" and not ((x.get("code") or {}).get("coding")):
                        masalah["Procedure: code.coding kosong"] += 1
                    stack = [x]
                    while stack:
                        o = stack.pop()
                        if isinstance(o, dict):
                            r = o.get("reference")
                            if isinstance(r, str) and "/" in r:
                                refs.append(r)
                            stack.extend(o.values())
                        elif isinstance(o, list):
                            stack.extend(o)
        for r in refs:
            t, _, i = r.partition("/")
            if i not in ids.get(t, ()):
                masalah[f"referensi {t} tidak ada"] += 1
                contoh_masalah.setdefault(f"referensi {t} tidak ada", r)
    return {"sumber_daya": n, "masalah": dict(masalah), "contoh_masalah": contoh_masalah}


def bundle(folder: Path, r: int, enc: str) -> dict:
    """Every resource of one encounter, with the patient, hospital, doctor, ward and drugs it references."""
    d = folder / "rekam_medis" / f"replika_{r:02d}"
    semua: dict[str, dict] = {}
    for f in d.glob("*.ndjson.gz"):
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            for line in fh:
                x = json.loads(line)
                semua[f"{x['resourceType']}/{x['id']}"] = x
    pilih = {k: x for k, x in semua.items() if x["id"] == enc or (x.get("encounter") or x.get("context") or {}).get("reference") == f"Encounter/{enc}"}
    antre = list(pilih.values())
    while antre:
        o = antre.pop()
        if isinstance(o, dict):
            rr = o.get("reference")
            if isinstance(rr, str) and rr in semua and rr not in pilih:
                pilih[rr] = semua[rr]
                antre.append(semua[rr])
            antre.extend(o.values())
        elif isinstance(o, list):
            antre.extend(o)
    urut = ["Patient", "Organization", "Location", "Practitioner", "Encounter", "Condition", "Procedure", "Observation", "DiagnosticReport", "Medication",
            "MedicationRequest", "MedicationDispense", "Composition"]
    ent = sorted(pilih.values(), key=lambda x: (urut.index(x["resourceType"]) if x["resourceType"] in urut else 99, x["id"]))
    return {"resourceType": "Bundle", "type": "collection", "entry": [{"fullUrl": f"urn:sintetis:{x['resourceType']}/{x['id']}", "resource": x} for x in ent]}


def main(folder: Path) -> None:
    import generator3 as G
    from aip import layanan as L

    t0 = time.time()
    # rerunnable: the raw replica files start in klaim/ and end in kunci/mentah/
    files = sorted((folder / "klaim").glob("replika_*.parquet")) or sorted((folder / "kunci" / "mentah").glob("replika_*.parquet"))
    raw = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    meta = json.loads((folder / "ringkasan_klaim.json").read_text("utf-8"))
    tema = meta["tema"]
    import laporan_cabang as LC

    D = G.dunia()
    nama_rs = lambda f: f"{LC.label_rs(D.rs[f])} ({f[:6]})" if f in D.rs else f[:8]  # noqa: E731
    meta["rs_curang_label"] = {sk: [" → ".join(nama_rs(f) for f in x if isinstance(f, str) and len(f) == 32) if isinstance(x, (list, tuple)) else nama_rs(x)
                                    for x in v] for sk, v in (meta.get("rs_curang_kc") or {}).items()}
    kolom_klaim = [c for c in raw.columns if not c.startswith("_")]
    # ---- the answer key: fraud labels and the true loss
    asli = raw._asli.map(lambda s: json.loads(s or "{}"))
    fraud = raw._sk.map(G.adalah_fraud)
    bill_asli = asli.map(lambda a: a.get("bill"))
    rugi = []
    for sk, baru, b, ba, fr in zip(raw._sk, raw._baru, raw.biaya_tagih_rp, bill_asli, fraud):
        if not fr:
            rugi.append(0)
        elif sk in IDENTITAS or baru or pd.isna(ba):
            rugi.append(int(b) if (sk in IDENTITAS or baru) else 0)
        else:
            rugi.append(int(b) - int(ba))
    S = G.SKEMA
    label = pd.DataFrame({"kunjungan_fkrtl_id": raw.kunjungan_fkrtl_id, "replika": raw.replika, "tema": raw.tema, "rs_di_kc": raw.rs_di_kc,
                          "skema": raw._sk, "varian": raw._varian, "fraud": fraud, "mutu": raw._sk.map(lambda s: s != "normal" and not G.adalah_fraud(s)),
                          "famili": raw._sk.map(lambda s: (S.get(s) or {}).get("famili")), "modus": raw._sk.map(lambda s: (S.get(s) or {}).get("modus")),
                          "label_skema": raw._sk.map(lambda s: (S.get(s) or {}).get("label")), "klaim_tambahan": raw._baru,
                          "biaya_tagih_rp": raw.biaya_tagih_rp, "biaya_sebelum_skema_rp": bill_asli, "kerugian_benar_rp": rugi, "nilai_sebelum_skema": raw._asli})
    (folder / "kunci" / "mentah").mkdir(parents=True, exist_ok=True)
    label.to_parquet(folder / "kunci" / "label_fraud.parquet", index=False)
    bagian = sorted((folder / "kunci").glob("ketidaksesuaian_rm_*.parquet"))
    rm = pd.concat([pd.read_parquet(f) for f in bagian], ignore_index=True) if bagian else pd.read_parquet(folder / "kunci" / "ketidaksesuaian_rm.parquet")
    rm.to_parquet(folder / "kunci" / "ketidaksesuaian_rm.parquet", index=False)
    for f in (folder / "kunci").glob("ketidaksesuaian_rm_*.parquet"):
        f.unlink()
    # ---- claims without labels, members
    (folder / "peserta").mkdir(exist_ok=True)
    semua = raw[kolom_klaim]
    semua.to_parquet(folder / "klaim" / "klaim_semua.parquet", index=False)
    t = semua[semua.rs_di_kc & (semua.tema == tema)]
    nama = f"klaim_{meta['tema_nama']}_{meta['kc']}"
    t.to_parquet(folder / "klaim" / f"{nama}.parquet", index=False)
    t.to_csv(folder / "klaim" / f"{nama}.csv", index=False)
    peserta = raw.groupby(["replika", "peserta_id"], as_index=False).agg(jenis_kelamin=("_jk", "first"), usia_tahun=("_usia", "first"),
                                                                       hak_kelas=("_hak_kelas", "first"), asal=("_sumber_peserta", "first"))
    peserta["asal"] = peserta.asal.map({"perjalanan": "riwayat_2024", "baru": "pola_pasien_2024"}).fillna(peserta.asal)
    peserta.to_parquet(folder / "peserta" / "peserta.parquet", index=False)
    for f in files:
        if f.parent.name == "klaim":
            shutil.move(str(f), str(folder / "kunci" / "mentah" / f.name))
    print(f"claims {len(semua):,} ({len(t):,} theme at the branch), members {len(peserta):,} ({time.time() - t0:.0f} s)", flush=True)
    # ---- validation of every FHIR resource
    cek = cek_fhir(folder)
    print(f"FHIR: {cek['sumber_daya']:,} resources, problems {cek['masalah']} ({time.time() - t0:.0f} s)", flush=True)
    # ---- examples
    (folder / "contoh").mkdir(exist_ok=True)
    lt = label[label.rs_di_kc & (label.tema == tema)].merge(rm.drop(columns=["skema", "varian"]), on=["kunjungan_fkrtl_id", "replika"], how="left")
    rawt = raw.set_index("kunjungan_fkrtl_id")
    contoh_dibuat = []
    for nm, sk, pola in CONTOH:
        cand = lt[lt.skema == sk]
        if cand.rm_ada.fillna(False).any():  # a record when the scheme leaves one (a fictitious claim has none)
            cand = cand[cand.rm_ada.fillna(False)]
        if pola:
            cand = cand[cand.kunjungan_fkrtl_id.map(lambda c: bool(pd.Series([rawt.loc[c, "prosedur"] or ""]).str.contains(pola).iloc[0]))]
        if sk == "normal":
            cand = cand[cand.ketidaksesuaian.fillna("") == ""]
        if not len(cand):
            continue
        c = cand.iloc[0]
        row = rawt.loc[c.kunjungan_fkrtl_id]
        klaim = {k: polos(v) for k, v in row[[x for x in kolom_klaim if x != "kunjungan_fkrtl_id"]].items()}
        klaim = {"kunjungan_fkrtl_id": c.kunjungan_fkrtl_id, **klaim}
        kun = {k: polos(v) for k, v in c.items()}
        doc = {"keterangan": f"Contoh {nm.replace('_', ' ')}: klaim, kunci jawaban, dan rekam medis FHIR (Bundle) satu kunjungan.", "klaim": klaim, "kunci": kun,
               "rekam_medis": bundle(folder, int(c.replika), c.encounter) if c.rm_ada and isinstance(c.encounter, str)
               else {"resourceType": "Bundle", "type": "collection", "entry": [], "keterangan": "tidak ada kunjungan di rekam medis untuk klaim ini"}}
        (folder / "contoh" / f"{nm}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1, default=str), "utf-8")
        contoh_dibuat.append(nm)
    # ---- summary (the theme at the branch: the audit population)
    lt["tahun"] = lt.replika
    per = lt.groupby("replika").agg(klaim=("kunjungan_fkrtl_id", "size"), nilai=("biaya_tagih_rp", "sum"),
                                    fraud=("fraud", "sum"), nilai_fraud=("biaya_tagih_rp", lambda s: s[lt.loc[s.index, "fraud"]].sum()),
                                    rugi=("kerugian_benar_rp", "sum"))
    fr = lt[lt.fraud]
    skema = fr.groupby("skema").agg(klaim=("kunjungan_fkrtl_id", "size"), nilai_klaim_rp=("biaya_tagih_rp", "sum"), kerugian_benar_rp=("kerugian_benar_rp", "sum"),
                                    rm_ada=("rm_ada", "mean")).sort_values("kerugian_benar_rp", ascending=False)
    ket = Counter(x for v in lt.ketidaksesuaian.fillna("") for x in v.split("|") if x)
    noi = Counter(x for v in lt.noise.fillna("") for x in v.split("|") if x)
    tf = t
    ring = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "kc": meta["kc"], "kc_nama": meta["kc_nama"], "tema": tema, "tema_nama": meta["tema_nama"],
            "replika": int(lt.replika.nunique()), "jendela_per_replika": meta["jendela"],
            "klaim_tema_di_kc": int(len(lt)), "klaim_semua": int(len(semua)), "peserta": int(len(peserta)),
            "nilai_klaim_rp": int(lt.biaya_tagih_rp.sum()), "rawat_inap": float((tf.tingkat_pelayanan == "RITL").mean()),
            "fraud_klaim": int(lt.fraud.sum()), "fraud_persen": float(lt.fraud.mean()), "nilai_klaim_fraud_rp": int(fr.biaya_tagih_rp.sum()),
            "kerugian_benar_rp": int(lt.kerugian_benar_rp.sum()), "mutu_klaim": int(lt.mutu.sum()),
            "per_tahun": {"klaim_rata": float(per.klaim.mean()), "nilai_rata_rp": float(per.nilai.mean()), "nilai_min_rp": int(per.nilai.min()), "nilai_maks_rp": int(per.nilai.max()),
                          "fraud_rata": float(per.fraud.mean()), "nilai_fraud_rata_rp": float(per.nilai_fraud.mean()), "rugi_rata_rp": float(per.rugi.mean()),
                          "rugi_min_rp": int(per.rugi.min()), "rugi_maks_rp": int(per.rugi.max())},
            "per_skema": {k: {kk: (float(vv) if isinstance(vv, float) else int(vv)) for kk, vv in v.items()} for k, v in skema.to_dict("index").items()},
            "rekam_medis": {"klaim_dengan_rm_sendiri": int(lt.rm_ada.fillna(False).sum()), "ketidaksesuaian_ditanam": dict(ket.most_common()), "noise": dict(noi.most_common()),
                            "fraud_dengan_ketidaksesuaian": int((fr.ketidaksesuaian.fillna("") != "").sum()),
                            "fraud_tidak_terlihat_di_rm": int(fr.ketidaksesuaian.fillna("").str.fullmatch("tidak_terlihat_di_rm").sum())},
            "fhir": cek, "contoh": contoh_dibuat,
            "silver_2024": {"klaim": meta.get("per_replika", [{}])[0].get("target"), "keterangan": "volume nyata tema ini di KC (sampel sintetis 2024), skala 365 hari"}}
    (folder / "ringkasan.json").write_text(json.dumps(ring, ensure_ascii=False, indent=1, default=int), "utf-8")
    tulis_readme(folder, ring, meta, skema)
    print(f"summary and README written ({time.time() - t0:.0f} s)")


def tulis_readme(folder: Path, R: dict, meta: dict, skema: pd.DataFrame) -> None:
    p = R["per_tahun"]
    rm = R["rekam_medis"]
    baris_skema = "\n".join(f"| {k} | {angka(v['klaim'])} | {rp_m(v['nilai_klaim_rp'])} | {rp_m(v['kerugian_benar_rp'])} |" for k, v in R["per_skema"].items())
    baris_ket = "\n".join(f"| `{k}` | {angka(v)} |" for k, v in rm["ketidaksesuaian_ditanam"].items())
    baris_noise = ", ".join(f"`{k}` {angka(v)}" for k, v in rm["noise"].items())
    fh = R["fhir"]
    teks = f"""# Data sintetis: klaim tema {R['tema_nama']} di {R['kc_nama']} + rekam medis FHIR

Data **sintetis** untuk menguji audit satu tema klinis di satu kantor cabang: **{angka(R['klaim_tema_di_kc'])} klaim tema
{R['tema_nama']}** (diagnosis utama ICD-10 bab I, atau kode Z dengan CMG INA-CBG I, sama dengan aturan tema laporan
kantor cabang) di RS wilayah {R['kc_nama']}, lengkap dengan **rekam medis setiap kunjungan dalam FHIR R4** (profil ID Core
FHIR Indonesia / SATUSEHAT) dan **kunci jawaban** terpisah.

Bukan data pasien nyata. Identitas pasien berupa kode sintetis (IHS "P..." dan nomor peserta dari registri sintetis), tanpa
NIK dan tanpa nama.

## Ringkasan

| | Nilai |
|---|---|
| Klaim tema {R['tema_nama']} di RS {R['kc_nama']} | **{angka(R['klaim_tema_di_kc'])}** klaim, {R['replika']} ulangan × 1 tahun |
| Nilai klaim | **{rp_m(R['nilai_klaim_rp'])}** (per tahun rata-rata {rp_m(p['nilai_rata_rp'])}, rentang {rp_m(p['nilai_min_rp'])}–{rp_m(p['nilai_maks_rp'])}) |
| Klaim fraud yang ditanam (kebenaran) | **{angka(R['fraud_klaim'])}** klaim ({100 * R['fraud_persen']:.1f}%), nilai klaimnya **{rp_m(R['nilai_klaim_fraud_rp'])}** |
| Kerugian sebenarnya akibat fraud | **{rp_m(R['kerugian_benar_rp'])}** (per tahun rata-rata {rp_m(p['rugi_rata_rp'])}, rentang {rp_m(p['rugi_min_rp'])}–{rp_m(p['rugi_maks_rp'])}) |
| Penyimpangan mutu (pulang dini, bukan fraud) | {angka(R['mutu_klaim'])} klaim |
| Rawat inap | {100 * R['rawat_inap']:.1f}% |
| Semua klaim pasien yang sama (semua tema, semua RS) | {angka(R['klaim_semua'])} klaim, {angka(R['peserta'])} peserta-ulangan |
| Rekam medis FHIR | {angka(fh['sumber_daya'])} resource; {angka(rm['klaim_dengan_rm_sendiri'])} klaim punya kunjungan sendiri |

Angka fraud di atas adalah **kebenaran yang ditanam generator**, bukan hasil audit. Hasil audit (ML v7, rule engine, AI
Agent Swarm) belum dijalankan; nanti dibandingkan dengan kunci ini.

## Cara data dibuat

- **Ulangan setahun.** {R['kc_nama']} nyatanya punya ±{angka(meta['per_replika'][0]['target'])} klaim tema {R['tema_nama']}
  per tahun (sampel 2024). Agar kepadatan per RS tetap wajar, 100 ribu klaim dibuat sebagai {R['replika']} **ulangan
  independen satu tahun** ({meta['jendela'][0]} s/d {meta['jendela'][1]}), masing-masing setara volume nyata setahun.
  Total = jumlah semua ulangan; "per tahun" = rata-rata dan rentang antar-ulangan. Setiap ulangan adalah dunia
  terpisah: jangan gabungkan dua ulangan menjadi satu aliran klaim.
- **Pasien.**
  - Peserta yang di riwayat 2024 punya klaim tema ini di RS wilayah KC melanjutkan perjalanannya sendiri (model
    perjalanan generator 3).
  - Sisanya peserta baru se-KC (jenis kelamin dan kelompok umur dicocokkan) yang memutar ulang pola pasien tema ini di
    sampel 2024 (RS, tingkat layanan, diagnosis, kelompok INA-CBG, jarak hari).
  - Setiap episode diturunkan ulang oleh generator 3: keparahan, lama rawat, diagnosis sekunder, prosedur, tarif,
    top-up.
- **Fraud.** 22 skema generator 3 (Permenkes 16/2019, M04–M17) dan satu penyimpangan mutu, dengan laju yang ditetapkan
  generator sebelum uji apa pun. RS curang ditetapkan sekali (`{meta['garam_dunia']}`), sama di semua ulangan.
- **Skenario RS curang di KC.** Generator 3 memilih RS curang secara nasional (2–4 RS besar per skema), dan di dunia ini
  tidak ada yang jatuh di {R['kc_nama']}. Agar pola tingkat RS ikut teruji (klaim fiktif tanpa rekam medis, rekam medis
  disalin, rujukan semu, dokter di tiga RS, dan lain-lain), KC ini diberi satu RS curang per skema. Yang dipilih RS umum
  bervolume menengah; dua RS terbesar dibiarkan jujur:
{chr(10).join(f"  - `{sk}`: {', '.join(meta.get('rs_curang_label', {}).get(sk, []))}" for sk in meta.get('rs_curang_kc', {}))}
- **Rekam medis.** Ditulis dari episode yang *sebenarnya* terjadi, yaitu klaim sebelum diubah skema. Klaim jujur
  didukung rekam medisnya. Klaim yang diubah skema berbeda dengan rekam medisnya, dengan cara khas skema itu (tabel di
  bawah).
- **Noise.** Klaim jujur diberi gangguan dokumentasi wajar supaya rule engine bertemu false positive realistis:
  {baris_noise}.

## Isi folder

| Folder / file | Isi |
|---|---|
| `klaim/klaim_{R['tema_nama']}_{R['kc']}.parquet` / `.csv` | klaim tema ini di RS wilayah KC (format `KlaimIn` API + `replika`, `urut`, `tema`, `rs_di_kc`, `faskes_profil`), **tanpa label** |
| `klaim/klaim_semua.parquet` | semua klaim pasien yang sama (semua tema, semua RS): aliran yang dilihat sistem audit |
| `peserta/peserta.parquet` | peserta per ulangan: jenis kelamin, usia, hak kelas (untuk cek identitas vs rekam medis) |
| `rekam_medis/replika_XX/<Resource>.ndjson.gz` | FHIR R4 NDJSON per tipe resource, per ulangan |
| `kunci/label_fraud.parquet` | **kunci jawaban**: skema fraud per klaim, kerugian sebenarnya, nilai sebelum skema |
| `kunci/ketidaksesuaian_rm.parquet` | **kunci jawaban**: ketidaksesuaian klaim–rekam medis yang ditanam dan noise per klaim |
| `kunci/mentah/` | file mentah generator (berlabel) |
| `contoh/*.json` | contoh satu klaim: baris klaim, kunci, dan Bundle FHIR kunjungannya |
| `ringkasan.json` | semua angka di README |

**Kunci penghubung**
- Klaim ↔ rekam medis: `kunjungan_fkrtl_id` = `Encounter.identifier.value`, dengan `Encounter.id` = `enc-<kunjungan_fkrtl_id>`.
- Peserta ↔ Patient: `Patient.identifier` (system `urn:sintetis:jkn:no-peserta`) = `peserta_id`; `Patient.id` = `rXX-<peserta_id>`.
- Kunci ↔ klaim: `kunjungan_fkrtl_id` + `replika`.

## Rekam medis FHIR

- **Profil:** `meta.profile` = ID Core (`https://fhir.kemkes.go.id/r4/StructureDefinition/id-core-*`).
- **Resource:** Patient, Organization, Location, Practitioner, Encounter, Condition, Procedure, Observation,
  DiagnosticReport, Medication, MedicationRequest, MedicationDispense, Composition (resume medis rawat inap).
- **Kode:**
  - Condition: ICD-10 (`http://hl7.org/fhir/sid/icd-10`).
  - Procedure: ICD-9-CM (`http://hl7.org/fhir/sid/icd-9-cm`), sama dengan klaim.
  - Observation: LOINC + UCUM (tanda vital, troponin, CK-MB, NT-proBNP, kreatinin, glukosa, HbA1c, Hb, elektrolit,
    leukosit, LDL, INR, EKG, LVEF).
  - Encounter.class: v3-ActCode AMB/IMP/EMER.
  - Medication: ATC (`http://www.whocc.no/atc`).
- **Batasan:**
  - Kode KFA (Kamus Farmasi dan Alat Kesehatan) dikosongkan karena katalog KFA tidak tersedia; obat memakai ATC.
  - Sistem kode `medicationType` (`http://terminology.kemkes.go.id/CodeSystem/medication-type`, kode NC) mengikuti
    konvensi SATUSEHAT tetapi belum diverifikasi ke halaman IG.
  - Top-up special CMG memakai sistem lokal `urn:sintetis:inacbg:special-cmg`.
- **Rekam medis hanya untuk klaim tema {R['tema_nama']} di RS wilayah KC.** Klaim pasien lain di `klaim_semua` tidak
  punya rekam medis.
- **Pemeriksaan struktur:**
  - {angka(fh['sumber_daya'])} resource diperiksa: elemen wajib, id unik, referensi terselesaikan di ulangannya.
  - Masalah: {json.dumps(fh['masalah'], ensure_ascii=False) if fh['masalah'] else "tidak ada"}.

## Skema fraud → yang terlihat di rekam medis

| Skema | Rekam medis menunjukkan | Kode di `ketidaksesuaian` |
|---|---|---|
| klaim_fiktif, sesi_rutin_fiktif | tidak ada kunjungan sama sekali | `rm_tidak_ada` |
| klaim_berulang | tidak ada kunjungan sendiri (layanannya = klaim sebelumnya) | `kunjungan_ganda` |
| pemecahan_episode | satu rawat inap utuh menutupi kedua klaim | `episode_menyatu` |
| tindakan_fiktif | prosedur yang ditagih tidak ada; tanda vital dan lab normal | `prosedur_tidak_ada_di_rm`, `tanpa_indikasi_klinis` |
| operasi_batal_ditagih | prosedur tercatat `not-done` dengan alasan batal | `prosedur_batal` |
| tidak_sesuai_indikasi | prosedur dilakukan tanpa indikasi di rekam medis | `prosedur_tanpa_indikasi` |
| upcoding_keparahan, geser_bertahap | diagnosis sekunder lebih sedikit dari klaim; keparahan tak didukung vital/lab | `dx_sekunder_kurang`, `keparahan_tidak_didukung` |
| diagnosis_utama_diganti | diagnosis utama lain | `dx_utama_berbeda` |
| obat_alkes_fiktif | obat/alkes/pemeriksaan top-up tidak ada | `obat_alkes_tidak_ada_di_rm` |
| naik_kelas | kelas bangsal sesuai hak, bukan kelas yang ditagih | `kelas_rawat_berbeda` |
| rawat_inap_tanpa_indikasi | rawat inap dengan semua vital dan lab normal | `rawat_inap_tanpa_indikasi` |
| readmisi_direncanakan | rencana masuk kembali di resume sebelumnya; vital normal | `readmisi_terencana`, `tanpa_indikasi_klinis` |
| pulang_dini, pulang_dini_readmisi | pulang dengan tanda vital belum stabil | `pulang_belum_stabil` |
| los_diperpanjang | "boleh pulang" beberapa hari sebelum tanggal pulang yang ditagih | `boleh_pulang_lebih_awal` |
| kartu_dipinjam | jenis kelamin/umur orang yang dirawat beda dengan pemilik kartu | `identitas_tidak_cocok` |
| kloning | vital, lab, dan resume disalin dari kunjungan pasien lain | `rm_salinan` |
| rujukan_semu | rujukan dari RS lain tanpa alasan klinis | `rujukan_tanpa_indikasi` |
| dokter_tiga_rs | dokter yang sama di tiga RS | `dokter_banyak_rs` |
| tagihan_gelembung, topup_gelembung | rekam medis konsisten: hanya terlihat dari tagihan | `tidak_terlihat_di_rm` |

Ketidaksesuaian yang ditanam di data ini:

| Kode | Klaim |
|---|---|
{baris_ket}

{angka(rm['fraud_dengan_ketidaksesuaian'])} dari {angka(R['fraud_klaim'])} klaim fraud punya ketidaksesuaian di rekam medis
({angka(rm['fraud_tidak_terlihat_di_rm'])} hanya terlihat dari tagihan). Contoh yang Anda minta, yaitu klaim kateter
jantung yang tidak ada di rekam medis dengan tanda vital normal, ada di `contoh/tindakan_fiktif_kateter.json`.

## Fraud per skema (kebenaran)

| Skema | Klaim | Nilai klaim | Kerugian sebenarnya |
|---|---|---|---|
{baris_skema}

Kerugian sebenarnya:
- **Skema identitas** (klaim fiktif, kartu dipinjam, sesi fiktif, klaim berulang) dan klaim yang ditambahkan skema:
  seluruh tagihan.
- **Klaim yang diubah skema:** tagihan dikurangi tagihan sebelum diubah. Nilainya bisa negatif per baris, misalnya
  bagian pertama rawat inap yang dipecah.

## Membuat ulang

```powershell
$env:PYTHONHASHSEED = "0"
.venv\\Scripts\\python.exe testing\\gen_tema.py --kc {R['kc']} --tema {R['tema']} --replika {R['replika']}
.venv\\Scripts\\python.exe testing\\rekam_medis.py
.venv\\Scripts\\python.exe testing\\paket_tema.py
```
"""
    (folder / "README.md").write_text(teks, "utf-8")


if __name__ == "__main__":
    import os

    os.environ.setdefault("GEN3_W1", "2025-12-17")
    os.environ.setdefault("GEN3_GARAM", "gen3-tema-jantung")
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", default=str(ROOT / "Data Sintetis" / "tema_jantung_kc_sul-7371"))
    a = ap.parse_args()
    main(Path(a.folder))
