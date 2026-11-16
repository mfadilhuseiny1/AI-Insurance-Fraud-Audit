"""One file for ML Studio's Perbandingan tab: the aggregate results of compare_screen.py, jev_eval.py and bench_dl.py
(both tasks), with the notes the tab shows. No claim rows go in it."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
KERJA = Path(__file__).resolve().parents[2] / "data" / "aip" / "ml" / "perbandingan" / "kerja"  # work files (row-level: never in git)
SRC = KERJA
DEST = Path(__file__).resolve().parents[2] / "data" / "aip" / "ml" / "perbandingan" / "perbandingan.json"


def read(name: str):
    p = SRC / name
    return json.loads(p.read_text("utf-8")) if p.exists() else None


def main() -> None:
    screened = read("compare_screen.json")
    jev = read("jev_eval.json")
    bench = [b for b in (read("bench_semua.json"), read("bench_rumah_sakit.json")) if b]
    for b in bench:
        b.pop("features", None)
    names = {"Screened set (Klaim Berisiko + Skor Risiko Klaim ML)": "Semua klaim yang di-screen", "Screened set, hospitals only": "Rumah sakit saja",
             "Claims both Decisions and DeepSeek screened": "Klaim yang juga dinilai DeepSeek"}
    for b in screened["boards"]:
        b["label"] = names.get(b["label"], b["label"])
    spent = sum(json.loads(x).get("usd") or 0 for f in ("jev_verdicts.jsonl", "jev_v2_verdicts.jsonl") if (SRC / f).exists()
                for x in (SRC / f).read_text("utf-8").splitlines())
    doc = {
        "dibuat": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "screened": {"screened_total": screened["screened_total"], "boards": screened["boards"], "fits": screened["fits"]},
        "jev": jev,
        "benchmark": bench,
        "catatan": {
            "label": "Patokannya label data itu sendiri, flag_selisih_verifikasi: verifikator BPJS membayar lebih rendah dari tagihan (sebagian kecil klaim; "
                     "sebagian besar rawat inap Klinik Utama, pola administratif). Label inilah yang dipelajari ML dan deep learning, sedangkan LLM ditanya hal lain "
                     "('apakah klaim ini janggal secara klinis?'). Jadi perbandingan ini menguntungkan ML dan deep learning: LLM yang buruk di sini belum tentu buruk "
                     "sebagai penelaah klinis, hanya tidak menemukan klaim yang dikoreksi verifikator.",
            "llm": "Set yang di-screen (Klaim Berisiko + Skor Risiko Klaim ML) dipilih oleh model ML produksi yang pernah dilatih dengan semua klaim ini, sehingga "
                   "seluruh klaim yang dikoreksi masuk ke dalamnya. Skor ML dan deep learning di halaman ini out-of-fold, bukan skor produksi. Vonis OpenAI "
                   "Decisions (Blu 1.3) dan DeepSeek (Blu 1.1) dibaca dari cache telaah 30 Oktober tanpa panggilan baru; JEv dijalankan 8 November pada 80 klaim "
                   "dengan fakta dan rubrik yang sama, setelah pengguna menyatakan izin tertulis BPJS ada, lalu sekali lagi dengan prompt v2 (ditulis sekali, "
                   "tidak disetel pada 80 klaim ini). 80 klaim adalah sampel kecil: interval JEv lebar.",
            "folds": "FT-Transformer (Gorishniy dkk., NeurIPS 2021): d = 32, 3 lapis, 4 head, tanpa dropout (di CPU ini dropout memakan 60% waktu latih), AdamW, "
                     "early stopping pada 10% data latih, bobot kelas positif akar rasio. Belum di-tuning dan dilatih di CPU: hasil deep learning bisa membaik dengan "
                     "tuning, tetapi pada data tabel seperti ini model tree biasanya sudah setara atau lebih baik.",
            "skrip": "Dihitung dengan skrip di api/ml_perbandingan (bench_dl.py, compare_screen.py, jev_run.py, jev_eval.py, jev_v2.py, jev_eval2.py, gabung.py) "
                     "di atas tabel fitur cache 27 Oktober, yang juga dipakai model 0.6.0. Hanya angka agregat yang disimpan di sini; biaya OpenRouter seluruhnya "
                     f"${spent:.2f}.",
        },
    }
    DEST.parent.mkdir(parents=True, exist_ok=True)
    tmp = DEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(DEST)
    print(f"written {DEST} ({DEST.stat().st_size:,} bytes): {len(doc['screened']['boards'])} screened boards, JEv {'yes' if jev else 'no'}, "
          f"{len(bench)} benchmark tasks")


if __name__ == "__main__":
    main()
