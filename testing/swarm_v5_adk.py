"""v5's multi-agent swarm for uncertain claims, on Google ADK (plan and rules: testing/kriteria_v5.json). Synthetic data only.

Run with the ADK environment:  .venv-adk/Scripts/python.exe testing/swarm_v5_adk.py jalankan --masuk X.jsonl --keluar Y.jsonl --set NAMA
                                .venv-adk/Scripts/python.exe testing/swarm_v5_adk.py uji        (offline, a fake model, no network)

One batch = 8 claims (shuffled with a fixed seed, ids masked K1..K8). The ADK tree of a batch:

  SequentialAgent swarm_v5
    ParallelAgent spesialis
      LlmAgent koding    coding & clinical             -> state pendapat_koding
      LlmAgent tagihan   billing                       -> state pendapat_tagihan
      LlmAgent episode   episode, identity & network   -> state pendapat_episode
    LlmAgent hakim       the judge: dossiers + the three opinions -> state putusan (final fraud probability p)

The dossiers (testing/swarm_v5.py berkas) hold facts derived from features only: no model score, label or scheme name. Since p3
(2026-11-15) a dossier also carries the rule engines' findings, de-identified and numbered R1..Rn with the specialist that owns
each (swarm_v5.bagian_aturan): "Temuan rekam medis (RME)" (the claim against the hospital's SATUSEHAT record) and "Bukti pemakaian
alat (IoT)" (device on-time, run length and mode measured by a current clamp on the power cable: usage, not clinical data). The
judge states for every finding whether it accepts or rejects it (`aturan` in its answer); the gate's rule-evidence lane
(swarm_v5.gerbang) counts only findings the judge did not reject.
Model: DeepSeek V4.1 Flash on Google Vertex AI Model Garden (MaaS), through Vertex's OpenAI-compatible endpoint with the
platform's Google credentials (as aip/vertex.py: the gcloud application-default file, GOOGLE_CLOUD_PROJECT, location
global). Provider: Vertex AI only (the user's instruction, 2026-11-13).
Spend: tokens are priced after every model call (after_model_callback); a batch starts only under the ceiling; 5 failed
batches in a row stop the run. Every complete batch is cached (.tmp/swarm_v5/cache_adk.jsonl) per (set, batch, prompt
version), the batch key holding each claim's key AND its dossier's fingerprint (kunci_batch): a rerun never pays twice, and a
changed dossier (new IoT data, a corrected record) is never answered from an older dossier's cache. Credentials and tokens are never printed. These calls are outside the platform's
Vertex ledger (aip/vertex.py), so this script keeps its own ceiling."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

from google.adk.agents import LlmAgent, ParallelAgent, SequentialAgent
from google.adk.agents.run_config import RunConfig
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
KERJA = Path(os.environ.get("SWARM_V5_KERJA") or ROOT / ".tmp" / "swarm_v5")  # testing/uji_riil.py: elsewhere
CACHE = KERJA / "cache_adk.jsonl"
APP = "swarm_v5"
MODEL = "deepseek-ai/deepseek-v4.1-flash-maas"  # Vertex MaaS publisher/model (api/aip/models.py DEEPSEEK)
HARGA = (0.30, 1.20)  # USD per million tokens in / out, Vertex list price (api/aip/models.py)
# p2 (the user, 2026-11-13: "kasih prompt yg bagus"): written from domain knowledge before any accuracy was seen.
# p3 (2026-11-15): + the rule engines' findings in the dossier (medical record, IoT usage), their owners, the judge's stance on each.
VERSI = "v5-adk-p3"
VERSI_NETRAL = "swarm-v5-p3"  # the same version without the framework's name (docs/API_CABANG_V1.md `versi_prompt`)
VERSI_PENULIS = "v5-adk-p2"   # the writer agent's prompt (PENULIS) did not change in p3: its cache stays valid
BATCH = 8
SPESIALIS = ("koding", "tagihan", "episode")

KONTEKS = """Anda auditor senior anti-fraud klaim JKN (BPJS Kesehatan), klaim rumah sakit (FKRTL) dengan tarif paket INA-CBG.
Klaim di bawah sudah lolos penyaringan awal tetapi RAGU: banyak yang normal, sebagian fraud. Tugas Anda MEMBEDAKAN keduanya.

CARA MEMBACA BERKAS
- Baris 1: kode INA-CBG (huruf CMG - tipe kasus - nomor - keparahan I/II/III), jenis rawat (RITL inap / RJTL jalan), keparahan, tipe kasus, jenis RS, kelas rawat.
- "persentil vs klaim normal": posisi klaim dibanding semua klaim normal (p50 = biasa, p95+ = tinggi, p5- = rendah). Persentil umum
  (tagihan, LOS) wajar tinggi untuk kasus berat; yang lebih bermakna adalah yang RELATIF TERHADAP KODE: "tarif / median tarif kode",
  "LOS / median LOS kode", "biaya / median biaya kode", "top-up / median top-up kode", "dx sekunder di atas p90 kode".
- "RS: ..." = profil rumah sakit (bukan klaim ini): menyimpang sedikit itu biasa; hanya bermakna jika SEJALAN dengan anomali klaim.
- "fitur mekanisme": hanya yang bukan nol yang ditulis. Hitungan >= 1 berarti kejadian itu ADA.
- "riwayat graph": jumlah klaim peserta sebelumnya, dan klaim sebelumnya di RS ini dengan kode sama.
- "jaringan": jumlah peserta lain yang berbagi RS dalam +-3 hari (pola kolusi/rujukan semu bila >= 2).
- "rule yang menyala": temuan rule engine. Rule bisa salah; KLAIM_GANDA_RIWAYAT dan MENINGGAL_TERCATAT sering alarm salah di data ini.
- "Temuan rekam medis (RME)": mesin aturan mencocokkan klaim dengan rekam medis elektronik RS (SATUSEHAT). Tiap ketidaksesuaian
  bernomor [R1], [R2] ... dengan pemiliknya (koding / tagihan / episode), kekuatannya 0-1 (sudah dikurangi faktor peringan, mis.
  rekam medis tanpa data klinis) dan tanda "terverifikasi" bila ketidaksesuaian itu dapat dicek langsung pada dokumen.
  "rekam medis tidak tersedia" BUKAN temuan; "tidak ada ketidaksesuaian" adalah fakta yang MEMBELA klaim.
- "Bukti pemakaian alat (IoT)": waktu nyala, lama dan mode alat (ventilator, mesin dialisis, monitor ICU) yang DIUKUR sensor arus
  pada kabel daya alat. Ini catatan pemakaian alat, BUKAN data klinis pasien (tidak ada tanda vital). "jangkar bukti cocok" = catatan
  alat tidak diubah sejak dijangkarkan sebelum klaim. Jam alat yang SESUAI tagihan juga membela klaim (mis. menjelaskan LOS panjang).
- Tanggal ditulis relatif terhadap tanggal masuk klaim: H0 = hari masuk, H+3 = tiga hari sesudahnya.
- Temuan aturan bisa salah (dokumentasi RS belum lengkap, alat diganti, pencatatan terlambat). Temuan terverifikasi yang kuat dan
  tidak dibantah fakta lain adalah bukti spesifik; temuan lemah atau yang perlu telaah klinis hanya pendukung.

PENJELASAN NORMAL (jangan dihukum bila hanya ini yang ada)
- Pasien baru / kunjungan pertama ke RS ini, atau tanpa riwayat: lazim (rujukan, pindah domisili).
- Biaya/LOS tinggi yang SESUAI kode dan keparahannya; kasus keparahan III di RS rujukan.
- Kode berulang pada terapi rutin (hemodialisis, kemoterapi, fisioterapi, kontrol bulanan).
- LOS pendek saja = isu mutu (pulang dini), bukan fraud, kecuali disertai readmisi/pemecahan episode.

SKALA p (peluang klaim ini fraud) — pakai seluruh rentang dan BEDAKAN antar klaim (ini peringkat):
0.02-0.10 tidak ada anomali bermakna | 0.10-0.30 satu anomali lemah dengan penjelasan normal yang masuk akal |
0.30-0.55 pola cocok satu modus tapi buktinya tunggal/lemah | 0.55-0.80 dua+ indikator konsisten untuk modus yang SAMA |
0.80-0.97 sinyal mekanisme yang sulit dijelaskan normal (mis. kartu dipakai di RS lain hari sama, >= 2 klaim mirip peserta lain di RS
yang sama, top-up >= 3x median kode yang jarang untuk kode itu, dx sekunder jauh di atas p90 kode + keparahan naik) DAN didukung fakta lain.
Nilai hanya dari fakta berkas; jangan mengarang. Jawab JSON saja."""
FOKUS = {
    "koding": """PERAN: spesialis KODING & KLINIS. Modus (Permenkes 16/2019): upcoding (keparahan/kode lebih tinggi dari kondisi), dx sekunder
berlebih untuk menaikkan keparahan, prosedur ditagih tanpa tindakan, kode tidak sesuai indikasi, rawat inap tanpa indikasi, LOS
diperpanjang, pulang dini lalu readmisi.
Bukti kuat: dx sekunder di atas p90 kode + keparahan II/III; tarif/median kode tinggi tanpa alasan klinis; "peluang keparahan berat
untuk diagnosis ini" rendah tapi keparahan III; "peluang ada prosedur untuk diagnosis ini" rendah tapi tipe kasus prosedur;
LOS/median kode jauh di atas 1 tanpa keparahan tinggi.
Temuan aturan milik Anda: [Rn · koding] (rekam medis: tindakan yang ditagih tidak tercatat, diagnosis/keparahan tidak tercatat atau
dibantah hasil ukur, jenis rawat, indikasi). Nilai masing-masing; sebut nomornya di "bukti".""",
    "tagihan": """PERAN: spesialis TAGIHAN. Modus: tagihan melebihi paket (tagihan / (tarif + top-up) > 1), top-up (tarif tambahan: obat, alkes,
prosedur, investigasi khusus) digelembungkan atau fiktif, obat/alkes fiktif, tagihan RS yang menggelembung secara sistematis.
Bukti kuat: top-up / median top-up kode >= 2-3x, top-up yang jarang untuk kode itu, biaya / median biaya kode tinggi sementara keparahan
dan LOS biasa, profil RS (% top-up, indeks tarif kode) yang SEJALAN dengan anomali klaim.
Temuan aturan milik Anda: [Rn · tagihan] (IoT: jam alat dipakai vs jam ditagih, ambang seperti 96 jam untuk ventilasi 96.72, dan
dampak tarifnya; rekam medis: obat/alat/implan dan kelas rawat yang ditagih). Nilai masing-masing; sebut nomornya di "bukti".""",
    "episode": """PERAN: spesialis EPISODE, IDENTITAS & JARINGAN. Modus: klaim ganda/berulang, pemecahan episode (satu perawatan ditagih
beberapa kali), readmisi direncanakan (pulang dini lalu masuk lagi untuk paket baru), kartu dipinjam / peserta di RS lain pada hari
yang sama, kloning klaim (salinan klaim peserta lain), phantom billing, rujukan semu dan kolusi antar-RS.
Bukti kuat: klaim peserta di RS lain hari sama >= 1; klaim mirip peserta lain di RS sama (3/14 hari) >= 2; klaim dekat dengan biaya
mirip; readmisi jeda pendek di RS sama dengan dx sama setelah rawat pendek; peserta lain berbagi RS +-3 hari >= 2; klaim kembar.
Temuan aturan milik Anda: [Rn · episode] (alat terikat ke pasien lain pada jam yang sama, jangkar bukti alat tidak cocok, kunjungan
tidak ada atau dipakai dua klaim, LOS melebihi rekam medis, episode dipecah, pasien bukan pemilik kartu). Nilai masing-masing; sebut
nomornya di "bukti".""",
}
FORMAT = ('Jawab: {"klaim": [{"id": "K1", "bukti": "<= 25 kata: fakta berkas yang menentukan", "p": 0.0-1.0, '
          '"famili": "koding|tagihan|episode|identitas|jaringan|normal", "alasan": "<= 15 kata"}]} untuk SETIAP id. Tulis bukti DULU, baru p.')
HAKIM = """PERAN: HAKIM. Anda menerima berkas yang sama dan pendapat tiga spesialis (koding, tagihan, episode).
1. Periksa ulang: apakah bukti tiap spesialis benar ada di berkas? Abaikan bukti yang tidak ada atau salah baca.
2. Satu spesialis dengan bukti SPESIFIK dan KUAT yang tidak dibantah fakta lain cukup untuk p tinggi; jangan dirata-rata ke bawah.
3. Beberapa anomali LEMAH dari bidang berbeda yang tidak membentuk satu modus: p rendah-menengah.
4. Spesialis cenderung curiga di bidangnya sendiri; jangan ikut skor tertinggi tanpa bukti.
5. Untuk SETIAP temuan aturan [Rn] di berkas klaim, nyatakan sikap: "terima" (fakta berkas mendukung dan tidak ada penjelasan normal)
   atau "tolak" (dibantah fakta lain, ada penjelasan normal, atau buktinya lemah), dengan alasan singkat. Sikap Anda dicatat dan
   menentukan apakah temuan itu dipakai sebagai bukti. p tetap penilaian Anda atas SELURUH berkas.
Pakai SKALA p yang sama, bedakan antar klaim."""
FORMAT_HAKIM = ('Jawab: {"klaim": [{"id": "K1", "bukti": "<= 25 kata: fakta berkas yang menentukan", "p": 0.0-1.0, '
                '"famili": "koding|tagihan|episode|identitas|jaringan|normal", "alasan": "<= 15 kata", '
                '"aturan": [{"id": "R1", "sikap": "terima|tolak", "alasan": "<= 12 kata"}]}]} untuk SETIAP id. "aturan" berisi SETIAP '
                'temuan [Rn] klaim itu; [] bila klaim tanpa temuan aturan. Tulis bukti DULU, baru p.')


# ------------------------------------------------------------------------------------------------------------ helpers
def _env_lokal(nama: str) -> str:
    v = os.environ.get(nama, "").strip()
    if v:
        return v
    f = ROOT / ".env.local"
    if f.exists():
        m = re.search(r'^\s*' + nama + r'\s*=\s*"?([^"\r\n]+)"?', f.read_text("utf-8"), re.M)
        if m:
            return m.group(1).strip()
    return ""


class Vertex:
    """Vertex AI credentials as the platform reads them (aip/vertex.py); the token refreshes itself when it expires."""

    def __init__(self) -> None:
        import google.auth

        self.proyek = _env_lokal("BLUESANDAI_VERTEX_PROJECT") or _env_lokal("GOOGLE_CLOUD_PROJECT")
        self.lokasi = _env_lokal("BLUESANDAI_VERTEX_LOCATION") or "global"
        named = _env_lokal("BLUESANDAI_VERTEX_CREDENTIALS")
        base = Path(os.environ["APPDATA"]) / "gcloud" if os.name == "nt" and os.environ.get("APPDATA") else Path.home() / ".config" / "gcloud"
        path = Path(named) if named else base / "application_default_credentials.json"
        if not self.proyek or not path.is_file():
            raise SystemExit("Vertex AI belum dikonfigurasi (project / application-default credentials)")
        self.creds, _ = google.auth.load_credentials_from_file(str(path), scopes=["https://www.googleapis.com/auth/cloud-platform"],
                                                               quota_project_id=self.proyek)

    def token(self) -> str:
        import google.auth.transport.requests

        if not self.creds.valid:
            self.creds.refresh(google.auth.transport.requests.Request())
        return self.creds.token

    def api_base(self) -> str:
        host = "aiplatform.googleapis.com" if self.lokasi == "global" else f"{self.lokasi}-aiplatform.googleapis.com"
        return f"https://{host}/v1/projects/{self.proyek}/locations/{self.lokasi}/endpoints/openapi"


def json_dari(teks: str) -> Optional[dict]:
    if not teks:
        return None
    teks = re.sub(r"<think>.*?</think>", "", teks, flags=re.S)
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", teks, re.S)
    cand = m.group(1) if m else None
    if cand is None:
        a, b = teks.find("{"), teks.rfind("}")
        cand = teks[a:b + 1] if a >= 0 and b > a else None
    for c in ((cand, re.sub(r",\s*([}\]])", r"\1", cand)) if cand else ()):
        try:
            return json.loads(c)
        except ValueError:
            continue
    return None


def rapikan(teks: Any, ids: list[str]) -> Optional[dict[str, dict]]:
    d = json_dari(teks if isinstance(teks, str) else json.dumps(teks) if isinstance(teks, dict) else "")
    if not isinstance(d, dict) or not isinstance(d.get("klaim"), list):
        return None
    out = {}
    for r in d["klaim"]:
        try:
            k, p = str(r["id"]).strip(), float(r["p"])
        except (KeyError, TypeError, ValueError):
            continue
        if k in ids and 0.0 <= p <= 1.0:
            out[k] = {"p": p, "famili": str(r.get("famili", ""))[:20], "alasan": str(r.get("alasan", ""))[:200], "bukti": str(r.get("bukti", ""))[:300]}
            # the judge's stance on each rule finding (p3): kept when well formed, never a reason to reject the answer
            sk = [{"id": str(x.get("id")).strip().upper(), "sikap": str(x.get("sikap", "")).strip().lower(), "alasan": str(x.get("alasan", ""))[:160]}
                  for x in (r.get("aturan") if isinstance(r.get("aturan"), list) else []) if isinstance(x, dict)]
            sk = [x for x in sk if re.fullmatch(r"R\d{1,2}", x["id"]) and x["sikap"] in ("terima", "tolak")]
            if sk:
                out[k]["aturan"] = sk
    return out if len(out) == len(ids) else None


class Biaya:
    def __init__(self) -> None:
        self.usd, self.panggilan, self.tok_in, self.tok_out = 0.0, 0, 0, 0

    def catat(self, callback_context: Any, llm_response: Any) -> None:
        """after_model_callback: price the call from its token counts (reasoning tokens counted as output)."""
        u = getattr(llm_response, "usage_metadata", None)
        if u is None:
            return None
        i = int(getattr(u, "prompt_token_count", 0) or 0)
        o = int(getattr(u, "candidates_token_count", 0) or 0) + int(getattr(u, "thoughts_token_count", 0) or 0)
        self.tok_in += i; self.tok_out += o; self.panggilan += 1
        self.usd += i * HARGA[0] / 1e6 + o * HARGA[1] / 1e6
        return None


# ------------------------------------------------------------------------------------------------------------ the ADK tree
def model_vertex(vx: Vertex) -> Callable[[], Any]:
    import litellm
    from google.adk.models.lite_llm import LiteLlm

    litellm.suppress_debug_info = True

    def buat() -> Any:  # one model per agent per batch, built with a fresh token
        return LiteLlm(model=f"openai/{MODEL}", api_base=vx.api_base(), api_key=vx.token(), max_tokens=3000, temperature=0.2,
                       timeout=150, num_retries=2)
    return buat


def pohon(model: Callable[[], Any], biaya: Biaya) -> SequentialAgent:
    def instr(teks: str) -> Callable[[Any], str]:
        return lambda _ctx: teks

    def instr_hakim(ctx: Any) -> str:
        op = "\n".join(f"[{a}] {ctx.state.get(f'pendapat_{a}', '')}" for a in SPESIALIS)
        return f"{KONTEKS}\n\n{HAKIM}\n{FORMAT_HAKIM}\n\nPENDAPAT SPESIALIS:\n{op}"

    sp = [LlmAgent(name=a, model=model(), instruction=instr(f"{KONTEKS}\n\n{FOKUS[a]}\n{FORMAT}"), output_key=f"pendapat_{a}",
                   after_model_callback=biaya.catat) for a in SPESIALIS]
    hakim = LlmAgent(name="hakim", model=model(), instruction=instr_hakim, output_key="putusan", after_model_callback=biaya.catat)
    return SequentialAgent(name="swarm_v5", sub_agents=[ParallelAgent(name="spesialis", sub_agents=sp), hakim])


async def satu_batch(model: Callable[[], Any], biaya: Biaya, teks_batch: str, ids: list[str]) -> Optional[dict]:
    svc = InMemorySessionService()
    runner = Runner(app_name=APP, agent=pohon(model, biaya), session_service=svc)
    s = await svc.create_session(app_name=APP, user_id="v5")
    msg = types.Content(role="user", parts=[types.Part(text=teks_batch)])
    async for _ in runner.run_async(user_id="v5", session_id=s.id, new_message=msg, run_config=RunConfig(max_llm_calls=8)):
        pass
    st = (await svc.get_session(app_name=APP, user_id="v5", session_id=s.id)).state
    jawab = {a: rapikan(st.get(f"pendapat_{a}"), ids) for a in SPESIALIS}
    jawab["hakim"] = rapikan(st.get("putusan"), ids)
    return jawab if all(jawab.values()) else None


# ------------------------------------------------------------------------------------------------------------ the run
def kunci_batch(nama_set: str, klaim: list[dict], b: list[int]) -> str:
    """The cache key of one batch: the set, each claim's key with its dossier's fingerprint, and the prompt version."""
    isi = "|".join(f"{klaim[i]['kunci']}#{hashlib.md5(klaim[i]['teks'].encode('utf-8')).hexdigest()[:10]}" for i in b)
    return f"{nama_set}|{hashlib.md5(isi.encode()).hexdigest()[:16]}|{VERSI}"


def muat_cache(path: Path) -> dict[str, dict]:
    d = {}
    if path.exists():
        for line in path.read_text("utf-8").splitlines():
            try:
                r = json.loads(line); d[r["kunci"]] = r
            except (ValueError, KeyError):
                continue
    return d


async def jalankan(nama_set: str, klaim: list[dict], model: Callable[[], Any], batas_usd: float, paralel: int = 6,
                   cache_path: Path = CACHE, log: Callable[[str], None] = print) -> dict:
    """klaim: [{kunci, teks}]. Returns {hasil: {kunci: {p, famili, alasan, spesialis}}, biaya, batch}."""
    cache = muat_cache(cache_path)
    urut = list(range(len(klaim)))
    random.Random(int(hashlib.md5(nama_set.encode()).hexdigest()[:8], 16)).shuffle(urut)
    batches = [urut[a:a + BATCH] for a in range(0, len(urut), BATCH)]
    biaya, sem = Biaya(), asyncio.Semaphore(paralel)
    st = {"gagal_beruntun": 0, "gagal": 0, "cache": 0, "berhenti": None, "selesai": 0}
    hasil: dict[str, dict] = {}
    t0 = time.time()

    async def kerja(b: list[int]) -> None:
        ids = [f"K{i + 1}" for i in range(len(b))]
        ck = kunci_batch(nama_set, klaim, b)
        bkey = ck.split("|")[1]
        jawab = cache.get(ck, {}).get("jawaban")
        if jawab:
            st["cache"] += 1
        else:
            async with sem:
                gagal_sah = 0
                for coba in range(6):
                    if st["berhenti"]:
                        return
                    if biaya.usd >= batas_usd:
                        st["berhenti"] = f"batas ${batas_usd} tercapai"; return
                    if gagal_sah >= 2:
                        break
                    tb = "\n\n".join(f"[{k}]\n{klaim[i]['teks']}" for k, i in zip(ids, b))
                    try:
                        jawab = await satu_batch(model, biaya, tb, ids)
                    except Exception as e:  # noqa: BLE001 - a model error fails this attempt only
                        teks_e = f"{type(e).__name__}: {e}"
                        if "429" in teks_e or "RateLimit" in teks_e or "exhausted" in teks_e:
                            st["throttle"] = st.get("throttle", 0) + 1  # Vertex quota: wait and retry, not a failure of the swarm
                            await asyncio.sleep(20 * (coba + 1) + random.random() * 10)
                            continue
                        log(f"  batch {bkey}: {teks_e[:160]}")
                        jawab = None
                    if not jawab:
                        gagal_sah += 1
                    if jawab:
                        st["gagal_beruntun"] = 0
                        r = {"kunci": ck, "jawaban": jawab, "waktu": time.strftime("%Y-%m-%d %H:%M:%S")}
                        cache[ck] = r
                        cache_path.parent.mkdir(parents=True, exist_ok=True)
                        with cache_path.open("a", encoding="utf-8") as fh:
                            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
                        break
                    st["gagal"] += 1; st["gagal_beruntun"] += 1
                    if st["gagal_beruntun"] >= 5:
                        st["berhenti"] = "5 kegagalan berturut-turut"; return
        if not jawab:
            return
        for k, i in zip(ids, b):
            hasil[klaim[i]["kunci"]] = {**jawab["hakim"][k], "spesialis": {a: jawab[a][k]["p"] for a in SPESIALIS}}
        st["selesai"] += 1
        if st["selesai"] % 10 == 0 or st["selesai"] == len(batches):
            log(f"[{(time.time() - t0) / 60:5.1f} min] {st['selesai']}/{len(batches)} batch · ${biaya.usd:.3f} · {biaya.panggilan} panggilan · cache {st['cache']} · gagal {st['gagal']}")

    await asyncio.gather(*(kerja(b) for b in batches))
    if st["berhenti"]:
        log(f"BERHENTI: {st['berhenti']}")
    return {"hasil": hasil, "batch": len(batches),
            "biaya": {"usd_perkiraan": round(biaya.usd, 4), "panggilan": biaya.panggilan, "token_masuk": biaya.tok_in, "token_keluar": biaya.tok_out, **st}}


# ------------------------------------------------------------------------------------------------------------ offline test
def uji_offline() -> None:
    """A fake ADK model: answers, a broken answer (retried), the cache, the ceiling and the failure stop. No network."""
    import tempfile
    from typing import AsyncGenerator

    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_request import LlmRequest
    from google.adk.models.llm_response import LlmResponse

    hit = {"n": 0, "rusak": 0}

    class Palsu(BaseLlm):
        mode: str = "baik"

        async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
            hit["n"] += 1
            if self.mode == "rusak":
                raise RuntimeError("HTTP 500")
            teks = " ".join(p.text or "" for c in llm_request.contents for p in (c.parts or []) if getattr(p, "text", None))
            ids = sorted(set(re.findall(r"\[(K\d+)\]", teks)), key=lambda x: int(x[1:]))
            out = json.dumps({"klaim": [{"id": k, "p": 0.3, "famili": "normal", "alasan": "uji"} for k in ids]})
            if self.mode == "sekali_rusak" and hit["rusak"] == 0:
                hit["rusak"] += 1; out = "bukan json"
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=out)]),
                              usage_metadata=types.GenerateContentResponseUsageMetadata(prompt_token_count=1000, candidates_token_count=200))

    klaim = [{"kunci": f"c{i}", "teks": f"klaim {i}"} for i in range(20)]
    with tempfile.TemporaryDirectory() as d:
        cp = Path(d) / "c.jsonl"
        r = asyncio.run(jalankan("uji", klaim, lambda: Palsu(model="palsu", mode="sekali_rusak"), 1.0, 2, cp, lambda s: None))
        assert len(r["hasil"]) == 20, r["biaya"]
        assert all(set(v["spesialis"]) == set(SPESIALIS) for v in r["hasil"].values())
        assert r["biaya"]["gagal"] == 1 and r["biaya"]["panggilan"] > 0
        n0 = hit["n"]
        r2 = asyncio.run(jalankan("uji", klaim, lambda: Palsu(model="palsu"), 1.0, 2, cp, lambda s: None))
        assert hit["n"] == n0 and len(r2["hasil"]) == 20 and r2["biaya"]["cache"] == 3, "the cache must answer a rerun"
        r3 = asyncio.run(jalankan("uji2", klaim, lambda: Palsu(model="palsu"), 0.0005, 1, Path(d) / "d.jsonl", lambda s: None))
        assert r3["biaya"]["berhenti"] and len(r3["hasil"]) < 20, "the ceiling must stop the run"
        r4 = asyncio.run(jalankan("uji3", klaim, lambda: Palsu(model="palsu", mode="rusak"), 1.0, 1, Path(d) / "e.jsonl", lambda s: None))
        assert not r4["hasil"] and r4["biaya"]["gagal"] >= 3, r4["biaya"]
        ubah = [{**x, "teks": x["teks"] + ("\nBukti pemakaian alat (IoT) — uji" if j == 0 else "")} for j, x in enumerate(klaim)]
        n1 = hit["n"]
        r5 = asyncio.run(jalankan("uji", ubah, lambda: Palsu(model="palsu"), 1.0, 2, cp, lambda s: None))
        assert r5["biaya"]["cache"] == 2 and hit["n"] > n1, "a changed dossier must be asked again, the other batches answered by the cache"
    st = rapikan('{"klaim": [{"id": "K1", "p": 0.7, "aturan": [{"id": "r1", "sikap": "Terima", "alasan": "x"}, {"id": "Z", "sikap": "terima"}]}]}', ["K1"])
    assert st and st["K1"]["aturan"] == [{"id": "R1", "sikap": "terima", "alasan": "x"}], st
    print("swarm_v5_adk offline: OK (ADK Sequential(Parallel(3 spesialis), hakim); broken answer retried; cache; ceiling; failures; "
          "dossier fingerprint in the cache key; the judge's stance on rule findings)")


# ------------------------------------------------------------------------------------------------------------ the writer
PENULIS = """Anda penulis laporan audit Kantor Cabang BPJS Kesehatan (gaya laporan konsultan). Untuk setiap exhibit, tulis:
- "makna": 1-2 kalimat MENGAPA PENTING bagi verifikator kantor cabang;
- "implikasi": 1 kalimat tindakan yang disarankan untuk kantor cabang (verifikasi, minta dokumen, kunjungan RS, dsb.).
ATURAN KERAS: pakai HANYA angka yang tertulis di fakta exhibit itu (boleh tanpa angka). Jangan mengarang angka, nama RS, atau persentase.
Bahasa Indonesia, lugas, istilah teknis boleh bahasa Inggris. Jawab JSON saja:
{"exhibit": [{"id": "<id persis>", "makna": "...", "implikasi": "..."}]} untuk SETIAP id."""


def pohon_penulis(model: Callable[[], Any], biaya: Biaya) -> LlmAgent:
    return LlmAgent(name="penulis", model=model(), instruction=lambda _ctx: PENULIS, output_key="narasi", after_model_callback=biaya.catat)


async def narasi(tugas: list[dict], model: Callable[[], Any], batas_usd: float, paralel: int = 3, log: Callable[[str], None] = print) -> dict:
    """tugas: [{kunci, judul, fakta: [...]}]; 6 exhibits per call; cached like the swarm. Returns {kunci: {makna, implikasi}}."""
    cache = muat_cache(CACHE)
    biaya, sem, out = Biaya(), asyncio.Semaphore(paralel), {}
    st = {"gagal": 0, "cache": 0}

    async def kerja(b: list[dict]) -> None:
        ck = "narasi|" + hashlib.md5(json.dumps(b, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16] + f"|{VERSI_PENULIS}"
        j = cache.get(ck, {}).get("jawaban")
        if j:
            st["cache"] += 1
        else:
            async with sem:
                for coba in range(4):
                    if biaya.usd >= batas_usd:
                        return
                    teks = "\n\n".join(f"[{t['kunci']}] {t['judul']}\nFakta:\n- " + "\n- ".join(t["fakta"]) for t in b)
                    try:
                        svc = InMemorySessionService()
                        runner = Runner(app_name=APP, agent=pohon_penulis(model, biaya), session_service=svc)
                        s = await svc.create_session(app_name=APP, user_id="v5")
                        async for _ in runner.run_async(user_id="v5", session_id=s.id, new_message=types.Content(role="user", parts=[types.Part(text=teks)]),
                                                        run_config=RunConfig(max_llm_calls=2)):
                            pass
                        d = json_dari((await svc.get_session(app_name=APP, user_id="v5", session_id=s.id)).state.get("narasi") or "")
                        rows = {str(r.get("id")): {"makna": str(r.get("makna", ""))[:600], "implikasi": str(r.get("implikasi", ""))[:400]}
                                for r in (d or {}).get("exhibit", []) if isinstance(r, dict)}
                        if all(t["kunci"] in rows for t in b):
                            j = rows; break
                        st["gagal"] += 1
                    except Exception as e:  # noqa: BLE001
                        if "429" in str(e) or "RateLimit" in str(e) or "exhausted" in str(e):
                            await asyncio.sleep(20 * (coba + 1) + random.random() * 10); continue
                        st["gagal"] += 1
                if not j:
                    return
                with CACHE.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"kunci": ck, "jawaban": j, "waktu": time.strftime("%Y-%m-%d %H:%M:%S")}, ensure_ascii=False) + "\n")
        out.update({k: v for k, v in j.items()})

    batches = [tugas[a:a + 6] for a in range(0, len(tugas), 6)]
    t0 = time.time()
    for a in range(0, len(batches), 20):
        await asyncio.gather(*(kerja(b) for b in batches[a:a + 20]))
        log(f"[{(time.time() - t0) / 60:5.1f} min] narasi {min(a + 20, len(batches))}/{len(batches)} batch · ${biaya.usd:.3f} · cache {st['cache']} · gagal {st['gagal']}")
    return {"narasi": out, "biaya": {"usd_perkiraan": round(biaya.usd, 4), "panggilan": biaya.panggilan, "token_masuk": biaya.tok_in, "token_keluar": biaya.tok_out, **st}}


def ekspor(nama_set: str, klaim: list[dict]) -> dict[str, dict]:
    """Every agent's answer per claim, read back from the cache (no model call): {kunci: {koding, tagihan, episode, hakim}}."""
    cache = muat_cache(CACHE)
    urut = list(range(len(klaim)))
    random.Random(int(hashlib.md5(nama_set.encode()).hexdigest()[:8], 16)).shuffle(urut)
    out: dict[str, dict] = {}
    for a in range(0, len(urut), BATCH):
        b = urut[a:a + BATCH]
        j = cache.get(kunci_batch(nama_set, klaim, b), {}).get("jawaban")
        if not j:
            continue
        for n, i in enumerate(b):
            k = f"K{n + 1}"
            out[klaim[i]["kunci"]] = {ag: j[ag][k] for ag in (*SPESIALIS, "hakim")}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["jalankan", "uji", "ekspor", "narasi"])
    ap.add_argument("--masuk"); ap.add_argument("--keluar"); ap.add_argument("--set")
    ap.add_argument("--batas", type=float, default=0.10); ap.add_argument("--paralel", type=int, default=6); ap.add_argument("--maks", type=int, default=0)
    a = ap.parse_args()
    if a.perintah == "uji":
        uji_offline(); return
    klaim = [json.loads(l) for l in Path(a.masuk).read_text("utf-8").splitlines() if l.strip()]
    if a.perintah == "narasi":
        r = asyncio.run(narasi(klaim, model_vertex(Vertex()), a.batas, max(1, a.paralel), lambda s: print(s, flush=True)))
        Path(a.keluar).write_text(json.dumps(r, ensure_ascii=False), "utf-8")
        print("biaya", json.dumps(r["biaya"]), "| narasi", len(r["narasi"]), "exhibit ->", a.keluar, flush=True)
        return
    if a.perintah == "ekspor":
        e = ekspor(a.set, klaim)
        Path(a.keluar).write_text(json.dumps(e, ensure_ascii=False), "utf-8")
        print(f"ekspor {len(e)}/{len(klaim)} klaim dari cache -> {a.keluar}")
        return
    if a.maks:
        klaim = klaim[: a.maks]
    print(f"{len(klaim)} klaim · {-(-len(klaim) // BATCH)} batch · batas ${a.batas} · model {MODEL} (Vertex AI)", flush=True)
    r = asyncio.run(jalankan(a.set, klaim, model_vertex(Vertex()), a.batas, a.paralel, CACHE, lambda s: print(s, flush=True)))
    Path(a.keluar).parent.mkdir(parents=True, exist_ok=True)
    Path(a.keluar).write_text(json.dumps({"set": a.set, "versi": VERSI, "model": MODEL, **r}, ensure_ascii=False), "utf-8")
    print("biaya", json.dumps(r["biaya"]), "| hasil", len(r["hasil"]), "klaim ->", a.keluar, flush=True)


if __name__ == "__main__":
    main()
