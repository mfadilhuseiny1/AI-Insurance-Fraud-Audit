"""Upload a claim document, get the form filled: like the ai-jkn Kodifikasi / Verifikator upload, all through OpenRouter.

PDF, DOCX and TXT are read here (pypdf, python-docx); an image (JPG/PNG/WEBP) is transcribed by a vision model (Muse
Glimmer 30B). DeepSeek-V4.1-Flash then writes the form's fields as JSON, exactly as read: what is not in the document
stays empty, never guessed. The hospital is matched to the stream's hospital profiles by city, class and ownership.
The file is not stored. The result is a draft the person must check before scoring."""
from __future__ import annotations

import base64
import io
import re
from typing import Any

import llm as LLM

MAKS = {"pdf": 20_000_000, "gambar": 5_000_000, "lain": 2_000_000}
TIPE_GAMBAR = {"image/png", "image/jpeg", "image/jpg", "image/webp"}

KUNCI = [
    '"nama_pasien": "nama pasien persis seperti tertulis"',
    '"no_rm": "nomor rekam medis"', '"no_sep": "nomor SEP"', '"no_kartu": "nomor kartu JKN/BPJS"',
    '"tanggal_masuk": "yyyy-mm-dd"', '"tanggal_pulang": "yyyy-mm-dd"',
    '"jenis_episode": "ri untuk rawat inap, rj untuk rawat jalan, igd untuk gawat darurat"',
    '"kelas_rawat": 1, 2, atau 3 (null bila tidak tertulis)', '"hak_kelas": 1, 2, atau 3 (null bila tidak tertulis)',
    '"status_pulang": "mis. Sehat, Membaik, Meninggal, Dirujuk, Pulang APS"',
    '"diagnosis_utama": "kode ICD-10 diagnosis utama, mis. J18.9"', '"diagnosis_utama_teks": "nama diagnosis utama"',
    '"diagnosis_sekunder": ["kode ICD-10 tiap diagnosis sekunder"]', '"tindakan": ["kode ICD-9-CM dan nama tindakan, mis. 96.04 Intubasi"]',
    '"inacbg_kode": "kode grup INA-CBG, mis. J-4-16-I"', '"tarif_inacbg_rp": angka rupiah tarif INA-CBG (null bila tidak ada)',
    '"biaya_tagih_rp": angka rupiah total tagihan / rincian biaya RS (null bila tidak ada)',
    '"topup_jenis": "sa, sp, rr, si, atau sd bila ada special CMG yang diajukan"', '"topup_rp": angka rupiah special CMG (0 bila tidak ada)',
    '"nama_faskes": "nama rumah sakit"', '"kelas_rs": "A, B, C, atau D bila tertulis"', '"kepemilikan_rs": "pemerintah atau swasta bila tertulis"',
    '"kabkota_faskes": "kabupaten/kota rumah sakit bila tertulis"', '"provinsi_faskes": "provinsi bila tertulis"',
    '"segmen": "segmen peserta bila tertulis, mis. PBI APBN, PPU, PBPU"',
]
ATURAN = ("Tulis PERSIS yang terbaca. Bidang yang tidak ada di dokumen dikosongkan (\"\" atau null atau []), jangan ditebak. "
          "Tanggal ke format yyyy-mm-dd. Uang sebagai angka murni (Rp3.702.300 → 3702300).")


def _teks_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    r = PdfReader(io.BytesIO(data))
    return "\n".join((p.extract_text() or "") for p in r.pages[:30])[:60_000]


def _teks_docx(data: bytes) -> str:
    import docx

    d = docx.Document(io.BytesIO(data))
    parts = [p.text for p in d.paragraphs]
    for t in d.tables:
        for row in t.rows:
            parts.append(" | ".join(c.text for c in row.cells))
    return "\n".join(parts)[:60_000]


def _teks_gambar(nama: str, mime: str, data: bytes) -> tuple[str, float]:
    url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    msgs = [{"role": "user", "content": [
        {"type": "text", "text": f"Salin semua teks pada gambar dokumen klaim ini ({nama}) apa adanya, baris demi baris, termasuk angka, kode, dan tanggal. Jangan menambah apa pun."},
        {"type": "image_url", "image_url": {"url": url}}]}]
    r = LLM.panggil(msgs, LLM.VISI, max_tokens=3000, reasoning=None)
    return r["teks"], r["usd"]


def _kab(s: str) -> str:
    s = re.sub(r"\s+", " ", (s or "").upper().strip())
    return re.sub(r"^(KABUPATEN|KAB\.?)\s+", "", s)


def _cocokkan_rs(isian: dict, rs_list: list[dict]) -> tuple[str, str]:
    """The stream's hospital profile that fits the document: the exact city/regency name first (BANDUNG is not KOTA
    BANDUNG), then the class as written (Kelas C above Setara Type C), then the ownership; claim count breaks ties."""
    kab = _kab(isian.get("kabkota_faskes") or "")
    kelas = (isian.get("kelas_rs") or "").upper().strip()[:1]
    milik = (isian.get("kepemilikan_rs") or "").lower().strip()
    if not kab:
        return "", "Kota/kabupaten RS tidak terbaca: pilih RS manual."
    cands = [r for r in rs_list if _kab(r.get("kabkota") or "") == kab] or [r for r in rs_list if kab in _kab(r.get("kabkota") or "")]
    if not cands:
        return "", "Rumah sakit di dokumen tidak cocok dengan daftar RS aliran: pilih manual."

    def skor(r: dict) -> tuple:
        tipe = (r.get("tipe") or "").upper()
        s_kelas = 2 if kelas and re.search(rf"\bKELAS {kelas}\b", tipe) else 1 if kelas and re.search(rf"\bTYPE {kelas}\b", tipe) else 0
        own = (r.get("kepemilikan") or "").lower()
        s_milik = 1 if milik and (own.startswith(milik[:6]) or (milik.startswith("swasta") == own.startswith("swasta") and milik.startswith("swasta"))) else 0
        return (s_kelas, s_milik, r["klaim"])

    best = max(cands, key=skor)
    sk = skor(best)
    cocok = ["kota"] + (["kelas"] if sk[0] else []) + (["kepemilikan"] if sk[1] else [])
    alt = sum(1 for r in cands if skor(r)[:2] == sk[:2]) - 1
    return best["id"], f"RS dicocokkan ke {best['label']} ({', '.join(cocok)}){f'; {alt} profil lain sama cocoknya' if alt > 0 else ''}: periksa."


def ekstrak(nama: str, mime: str, data: bytes, rs_list: list[dict]) -> dict:
    mime = (mime or "").split(";")[0].strip().lower()
    low = nama.lower()
    if not data:
        raise ValueError("Berkas kosong.")
    biaya = 0.0
    if mime == "application/pdf" or low.endswith(".pdf"):
        if len(data) > MAKS["pdf"]:
            raise ValueError("PDF melebihi 20 MB.")
        teks, asal = _teks_pdf(data), "pdf"
        if len(teks.strip()) < 40:
            raise ValueError("PDF ini tidak berisi teks (hasil scan). Unggah halamannya sebagai gambar JPG atau PNG.")
    elif mime in TIPE_GAMBAR or low.endswith((".png", ".jpg", ".jpeg", ".webp")):
        if len(data) > MAKS["gambar"]:
            raise ValueError("Gambar melebihi 5 MB.")
        if not LLM.siap():
            raise ValueError("Pembacaan gambar dengan AI belum dikonfigurasi.")
        teks, biaya = _teks_gambar(nama, mime or "image/png", data)
        asal = "gambar"
    elif low.endswith(".docx"):
        if len(data) > MAKS["lain"]:
            raise ValueError("DOCX melebihi 2 MB.")
        teks, asal = _teks_docx(data), "docx"
    elif mime.startswith("text/") or low.endswith((".txt", ".csv", ".md")):
        teks, asal = data.decode("utf-8", errors="replace")[:60_000], "teks"
    else:
        raise ValueError(f"Tipe berkas tidak didukung ({mime or nama}). Gunakan PDF, DOCX, TXT, JPG, atau PNG.")
    if not teks.strip():
        raise ValueError("Tidak ada teks yang terbaca dari berkas.")
    if not LLM.siap():
        raise ValueError("Pengisian formulir dari dokumen dengan AI belum dikonfigurasi.")
    prompt = ("Baca dokumen klaim rumah sakit JKN berikut (resume medis, SEP, rincian biaya, atau lembar klaim) dan isi formulir. "
              f"{ATURAN}\nJawab HANYA satu objek JSON dengan kunci:\n{{{', '.join(KUNCI)}}}\n\nDokumen ({nama}):\n{teks}")
    # reasoning "low" with room for the answer: without an explicit effort the model can spend the whole budget thinking
    r = LLM.panggil([{"role": "user", "content": prompt}], LLM.TEKS, max_tokens=6000, reasoning="low")
    biaya += r["usd"]
    d = LLM.json_dari(r["teks"])
    if not d:
        raise ValueError("Hasil bacaan dokumen tidak berbentuk data terstruktur. Coba dokumen yang lebih jelas.")
    isian: dict[str, Any] = {}
    catatan: list[str] = []
    for k in ("nama_pasien", "no_rm", "no_sep", "tanggal_masuk", "tanggal_pulang", "status_pulang", "segmen", "inacbg_kode", "diagnosis_utama"):
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            isian[k] = v.strip()
    if isian.get("inacbg_kode"):
        isian["inacbg_kode"] = isian["inacbg_kode"].upper().replace(" ", "")
    for k in ("tanggal_masuk", "tanggal_pulang"):
        if k in isian and not re.match(r"^\d{4}-\d{2}-\d{2}$", isian[k]):
            catatan.append(f"{k} terbaca '{isian.pop(k)}', bukan yyyy-mm-dd: isi manual.")
    if d.get("jenis_episode") in ("ri", "rj", "igd"):
        isian["jenis_episode"] = d["jenis_episode"]
    for k in ("kelas_rawat", "hak_kelas"):
        try:
            v = int(d.get(k)) if d.get(k) not in (None, "") else None
            if v in (1, 2, 3):
                isian[k] = v
        except (TypeError, ValueError):
            pass
    for k in ("tarif_inacbg_rp", "biaya_tagih_rp", "topup_rp"):
        try:
            v = int(float(str(d.get(k)).replace(".", "").replace(",", ""))) if d.get(k) not in (None, "", 0) else None
            if v:
                isian[k] = v
        except (TypeError, ValueError):
            pass
    if d.get("topup_jenis") in ("sa", "sp", "rr", "si", "sd"):
        isian["topup_jenis"] = d["topup_jenis"]
    for k in ("diagnosis_sekunder", "tindakan"):
        v = d.get(k)
        if isinstance(v, list):
            isian[k] = [str(x).strip() for x in v if str(x).strip()][:60]
    if isian.get("nama_pasien") or isian.get("no_rm"):
        isian["pasien_mode"] = "baru"
    rs_id, ket = _cocokkan_rs(d, rs_list)
    if rs_id:
        isian["rs_id"] = rs_id
    catatan.append(ket)
    if d.get("hak_kelas") and isian.get("kelas_rawat") and str(d.get("hak_kelas")) != str(isian.get("kelas_rawat")):
        catatan.append(f"Hak kelas {d.get('hak_kelas')} berbeda dengan kelas rawat {isian.get('kelas_rawat')}.")
    return {"isian": isian, "terisi": sorted(isian), "catatan": catatan, "sumber_teks": asal, "biaya_usd": round(biaya, 5),
            "dibaca": {k: d.get(k) for k in ("nama_faskes", "kelas_rs", "kepemilikan_rs", "kabkota_faskes", "provinsi_faskes", "diagnosis_utama_teks", "no_kartu")}}
