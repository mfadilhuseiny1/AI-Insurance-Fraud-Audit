"""Prompt v2 for the LLM screen (the user, 2026-11-08: "perbaiki promptnya, allow it buat bandingin nilai klaim sama nilai
ina cbg sama nilai median dataset dan rule2 terkait", "kaitin sama ontologi"). OpenAI Decisions itself cannot be re-run
(the user's standing rule: never use the OpenAI key again), so v2 runs on JEv (OpenRouter) on the same 80 claims as v1.

What v2 adds to v1 (the same facts Decisions read):
  - a rubric over three sides: tariff (bill vs INA-CBG + top-ups vs the median and p90 bill of the same code), clinical,
    and rules / patterns; no "choose wajar when in doubt";
  - the platform's own rule catalogue (GET /api/aip/aturan), minus the rules derived from the label or the ML score
    (they would hand the model the answer), and the rules this claim triggers, computed from its features;
  - its context in the ontology: the INA-CBG code node (median and p90 bill, median tariff, how common), the diagnosis node,
    the facility node (its case-mix indices against the national median of facilities of the same kind), the patient node.
Nothing in it is computed from the label. Written once, not tuned on these claims. Same $5 budget as v1 (shared file).
"""

from __future__ import annotations

import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
KERJA = Path(__file__).resolve().parents[2] / "data" / "aip" / "ml" / "perbandingan" / "kerja"  # work files (row-level: never in git)
sys.path.insert(0, str(HERE))
import jev_run as J  # noqa: E402

OUT = KERJA / "jev_v2_verdicts.jsonl"
V1 = KERJA / "jev_verdicts.jsonl"
BUDGET = 5.00 - 0.50  # the user's $5 OpenRouter cap, less a margin; v1's spend counts against it
# rules a model must not see: they are the label (a verifier correction), or the ML model's score
LEAKY = {"skrining_selisih", "klaim_dikoreksi", "kode_koreksi", "faskes_koreksi_vs_ekspektasi", "faskes_lolos_verifikasi", "ml_lolos_verifikasi",
         "ml_ditandai", "skrining_skor"}
FAC = ["f_jumlah_klaim", "f_pct_rawat_inap", "f_pct_keparahan_berat", "f_idx_los", "f_pct_prosedur_rj", "f_pct_tarif_tambahan", "f_pct_kembar",
       "f_pct_peserta_sekali", "f_hhi_inacbg", "f_hhi_dx", "f_rata_dx_sekunder", "f_idx_tarif_kode"]
FAC_LABEL = {"f_jumlah_klaim": "jumlah klaim", "f_pct_rawat_inap": "porsi rawat inap", "f_pct_keparahan_berat": "porsi keparahan III",
             "f_idx_los": "indeks LOS (terhadap median kode)", "f_pct_prosedur_rj": "porsi rawat jalan berprosedur", "f_pct_tarif_tambahan": "porsi bertarif tambahan",
             "f_pct_kembar": "porsi klaim kembar", "f_pct_peserta_sekali": "porsi peserta sekali datang", "f_hhi_inacbg": "konsentrasi kode INA-CBG (HHI)",
             "f_hhi_dx": "konsentrasi diagnosis (HHI)", "f_rata_dx_sekunder": "rata-rata diagnosis sekunder", "f_idx_tarif_kode": "indeks tarif terhadap median kode"}


def rules_catalogue() -> str:
    req = urllib.request.Request("http://127.0.0.1:8300/api/aip/aturan", headers={"Authorization": f"Bearer {J.env('ADMIN_ACCESS_TOKEN')}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        rows = json.loads(r.read())["aturan"]
    keep = [r for r in rows if r["id"] not in LEAKY and r.get("lapisan") in ("fakta", "skrining", "penanda")]
    lines = []
    for r in keep:
        cond = " ".join(str(r.get("kondisi") or "").split())[:220]
        mode = f" [modus: {r['modus'][:70]}]" if r.get("modus") and not str(r["modus"]).startswith("bukan") else ""
        lines.append(f"- {r['id']} ({r['entitas']}): {r['nama']}. {cond}{mode}")
    return "\n".join(lines)


def ontology(ids: list[str]) -> dict[str, dict]:
    """Each claim's neighbourhood: its own numbers and the code, diagnosis, facility and patient nodes it links to."""
    import duckdb
    import pandas as pd

    con = duckdb.connect()
    con.execute("SET memory_limit = '2GB'")
    con.execute(f"CREATE VIEW fitur AS SELECT * FROM read_parquet('{J.FEATURES.as_posix()}')")
    con.register("ids", pd.DataFrame({"klaim_id": ids}))
    c = con.execute("""SELECT f.* FROM fitur f JOIN ids USING (klaim_id)""").df()
    codes = pd.DataFrame({"inacbg_kode": c["inacbg_kode"].dropna().unique()})
    con.register("codes", codes)
    kode = con.execute("""SELECT inacbg_kode, count(*) AS n, median(biaya_tagih) AS tagih_median, quantile_cont(biaya_tagih, 0.9) AS tagih_p90,
                                 median(tarif_inacbg) AS tarif_median, median(los) AS los_median, quantile_cont(los, 0.9) AS los_p90,
                                 avg(CASE WHEN tarif_tambahan > 0 THEN 1 ELSE 0 END) AS porsi_tarif_tambahan
                          FROM fitur JOIN codes USING (inacbg_kode) GROUP BY 1""").df().set_index("inacbg_kode")
    nat = con.execute(f"""SELECT jenis_fkrtl, {', '.join(f'median({x}) AS {x}' for x in FAC)}
                          FROM (SELECT DISTINCT faskes_profil_id, jenis_fkrtl, {', '.join(FAC)} FROM fitur) GROUP BY 1""").df().set_index("jenis_fkrtl")
    r2 = lambda v: None if v is None or pd.isna(v) else round(float(v), 3)  # noqa: E731
    out = {}
    for _, x in c.iterrows():
        k = kode.loc[x["inacbg_kode"]] if x["inacbg_kode"] in kode.index else None
        hits = []
        if x.get("flag_ganda"):
            hits.append("skrining_calon_ganda: calon klaim ganda (peserta, tanggal dan kode sama)")
        if x.get("flag_los_ekstrem"):
            hits.append("skrining_los_ekstrem: lama rawat di atas p99 kodenya")
        if (x.get("rasio_tagih_tarif") or 0) > 1.0001:
            hits.append(f"klaim_di_atas_tarif: tagihan {x['rasio_tagih_tarif']:.2f}x tarif INA-CBG + tarif tambahan")
        if (x.get("tarif_tambahan") or 0) > 0:
            hits.append("klaim_topup_khusus: ada tarif tambahan (special CMG)")
        if (x.get("kembar") or 0) > 0:
            hits.append(f"klaim kembar: {int(x['kembar'])} klaim lain peserta ini di hari dan kode yang sama")
        if x.get("los_di_atas_p90"):
            hits.append("lama rawat di atas p90 kodenya")
        fac = {FAC_LABEL[f]: {"faskes_ini": r2(x.get(f)), "median_nasional_faskes_sejenis": r2(nat.loc[x["jenis_fkrtl"], f]) if x["jenis_fkrtl"] in nat.index else None}
               for f in FAC}
        out[x["klaim_id"]] = {
            "node_kode_inacbg": None if k is None else {
                "kode": x["inacbg_kode"], "klaim_dengan_kode_ini_di_dataset": int(k["n"]), "tagihan_median_kode_rp": r2(k["tagih_median"]),
                "tagihan_p90_kode_rp": r2(k["tagih_p90"]), "tarif_inacbg_median_kode_rp": r2(k["tarif_median"]), "los_median_kode": r2(k["los_median"]),
                "los_p90_kode": r2(k["los_p90"]), "porsi_kode_ini_bertarif_tambahan": r2(k["porsi_tarif_tambahan"])},
            "perbandingan_nilai_klaim": {
                "tagihan_rp": r2(x["biaya_tagih"]), "tarif_inacbg_rp": r2(x["tarif_inacbg"]), "tarif_tambahan_rp": r2(x["tarif_tambahan"]),
                "tagihan_dibanding_tarif_plus_tambahan": r2(x["rasio_tagih_tarif"]), "selisih_tagihan_dan_tarif_rp": r2(x["selisih_tagih_tarif"]),
                "tagihan_dibanding_median_kode": r2(x["biaya_tagih"] / k["tagih_median"]) if k is not None and k["tagih_median"] else None,
                "tarif_dibanding_median_tarif_kode": r2(x["idx_tarif_kode"]), "los_dibanding_median_kode": r2(x["idx_los"])},
            "node_diagnosis": {"peluang_keparahan_berat_untuk_dx_ini": r2(x["p_berat_dx"]), "peluang_berprosedur_untuk_dx_ini": r2(x["p_prosedur_dx"]),
                               "jumlah_diagnosis_sekunder": r2(x["dx_sekunder"])},
            "node_peserta": {"kunjungan_peserta_total": r2(x["kunjungan_peserta"]), "kunjungan_peserta_di_faskes_ini": r2(x["kunjungan_peserta_faskes"]),
                             "hari_sejak_kunjungan_sebelumnya": r2(x["hari_sejak_sebelumnya"]), "klaim_kembar_hari_dan_kode_sama": r2(x["kembar"])},
            "node_faskes": {"jenis": x["jenis_fkrtl"], "tipe": x.get("tipe_fkrtl"), "profil_case_mix": fac},
            "aturan_terpicu": hits or ["tidak ada aturan tingkat klaim yang terpicu"],
        }
    return out


RUBRIC_V2 = """Anda verifikator klaim JKN (BPJS Kesehatan) yang berpengalaman dengan INA-CBG, ICD-10, ICD-9-CM dan aturan verifikasi. Nilai SATU klaim FKRTL dari faktanya dan dari konteksnya di ontologi data: node kode INA-CBG, diagnosis, faskes dan peserta yang terhubung dengannya.
Periksa tiga sisi, lalu timbang bersama:
1. Nilai klaim: tagihan dibanding tarif INA-CBG + tarif tambahan; tagihan dan tarif dibanding median dan p90 klaim berkode sama di dataset; tarif tambahan (special CMG) dibanding diagnosis dan prosedurnya.
2. Klinis: diagnosis masuk vs utama, diagnosis vs prosedur, keparahan vs diagnosis sekunder dan peluang keparahan berat untuk diagnosis itu, lama rawat vs median dan p90 kodenya, status pulang.
3. Aturan dan pola: aturan indikasi yang terpicu pada klaim ini (lihat katalog aturan platform), profil case-mix faskesnya dibanding median nasional faskes sejenis, dan riwayat peserta (kunjungan berulang, klaim kembar di hari dan kode yang sama).
Satu angka di atas median belum tentu janggal; yang menentukan adalah kombinasi yang tidak dijelaskan fakta lain. Data ini tidak memuat rekam medis, hasil lab, obat, atau hak kelas: ketiadaannya bukan kejanggalan. Berikan peluang yang terkalibrasi, bukan condong ke satu tingkat."""

LEVELS_V2 = [
    ("wajar", "nilai, klinis dan aturan konsisten, atau penyimpangannya kecil dan dijelaskan fakta lain"),
    ("perlu_diperiksa", "ada hal spesifik (nilai klaim, klinis, atau aturan yang terpicu) yang hanya bisa dipastikan dengan dokumen"),
    ("mencurigakan", "ketidaksesuaian yang jelas, atau beberapa sinyal sekaligus: tagihan di atas tarif tanpa dasar, nilai jauh di atas p90 kodenya, keparahan atau prosedur tidak didukung, LOS jauh di atas p90 tanpa alasan, calon klaim ganda atau kembar, profil faskes yang menyimpang kuat ke arah yang sama"),
]


def prompt_v2(fakta: dict, ctx: dict, rules: str) -> str:
    lv = "\n".join(f"- {k}: {d}" for k, d in LEVELS_V2)
    tg = "\n".join(f"- {c['value']}: {c['description']}" for c in J.TAG_CHOICES)
    return (RUBRIC_V2 + "\n\nKatalog aturan indikasi platform (aturan yang dibentuk dari hasil verifikasi atau skor model tidak dicantumkan):\n" + rules
            + "\n\nFakta klaim (JSON):\n" + json.dumps(fakta, ensure_ascii=False, default=str)
            + "\n\nKonteks ontologi klaim ini (JSON):\n" + json.dumps(ctx, ensure_ascii=False, default=str)
            + "\n\nJawab dua pertanyaan, hanya dalam JSON sesuai skema.\n"
            f"1. kesimpulan: kesimpulan telaah klaim ini. Beri peluang (0-1, jumlahnya 1) untuk setiap tingkat, lalu tingkat dengan peluang terbesar:\n{lv}\n"
            f"2. tag: {J.T.DECISION_QUESTIONS[1]['instructions']}\n{tg}")


def spent_v1() -> float:
    return sum(json.loads(x).get("usd") or 0 for x in V1.read_text("utf-8").splitlines()) if V1.exists() else 0.0


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    key = J.env("OPENROUTER_API_KEY")
    rows = J.sample()
    done = {}
    if OUT.exists():
        for line in OUT.read_text("utf-8").splitlines():
            r = json.loads(line)
            done[r["klaim_id"]] = r
    todo = [r for r in rows if not done.get(r["klaim_id"], {}).get("ok")]
    spent = spent_v1() + sum(r.get("usd") or 0 for r in done.values())
    print(f"v2: {len(rows)} claims, {len(todo)} to ask; OpenRouter spent so far (v1 + v2) ${spent:.4f}, cap ${BUDGET:.2f}", flush=True)
    if not todo:
        return
    rules = rules_catalogue()
    F = J.facts([r["klaim_id"] for r in todo])
    O = ontology([r["klaim_id"] for r in todo])
    first = prompt_v2(F[todo[0]["klaim_id"]]["fakta"], O[todo[0]["klaim_id"]], rules)
    print(f"prompt v2: {len(rules.splitlines())} rules in the catalogue, ~{len(first) // 4:,} tokens a claim (v1 ~{len(J.prompt(F[todo[0]['klaim_id']]['fakta'])) // 4:,})", flush=True)

    def one(r: dict) -> dict:
        res = J.call(key, prompt_v2(F[r["klaim_id"]]["fakta"], O[r["klaim_id"]], rules), True)
        out = {"klaim_id": r["klaim_id"], "y": r["y"], "ms": res.get("ms"), "prompt": "v2"}
        if "error" in res:
            return {**out, "ok": False, "why": res["error"], "usd": 0.0}
        u = res.get("usage") or {}
        out.update({"usd": float(u.get("cost") or 0.0), "prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens"),
                    "routed_to": res.get("model"), "provider": res.get("provider")})
        return {**out, **J.parse(res)}

    with OUT.open("a", encoding="utf-8") as fh, ThreadPoolExecutor(max_workers=4) as pool:
        i = 0
        while i < len(todo):
            batch = todo[i: i + 4]
            i += len(batch)
            worst = max([r.get("usd") or 0 for r in done.values()] + [0.02])
            if spent + worst * len(batch) * 1.5 > BUDGET:
                print(f"budget: ${spent:.3f} spent, next batch could pass ${BUDGET:.2f}; stopping", flush=True)
                break
            for res in pool.map(one, batch):
                fh.write(json.dumps(res, ensure_ascii=False) + "\n")
                fh.flush()
                done[res["klaim_id"]] = res
                spent += res.get("usd") or 0.0
                if not res.get("ok"):
                    print(f"  FAILED {str(res.get('why'))[:160]}", flush=True)
    ok = [r for r in done.values() if r.get("ok")]
    print(f"v2 answered {len(ok)} of {len(rows)}; OpenRouter spent (v1 + v2) ${spent:.4f}; routed: "
          + ", ".join(f"{k} {v}" for k, v in sorted(__import__('collections').Counter(r.get('routed_to') for r in ok).items(), key=lambda kv: -kv[1])), flush=True)


if __name__ == "__main__":
    main()
