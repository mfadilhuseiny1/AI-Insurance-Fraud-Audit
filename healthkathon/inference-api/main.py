"""AI Inference Pipeline — BluesandAI, Healthkathon 2026 (BPJS Kesehatan × BINUS).

The judges' micro-pipeline (github.com/saidachmadd/ai-inference-pipeline-demo: client request → Pydantic validation →
feature engineering → ML inference → LLM service → JSON response), served from the model the team trained on the real
claims of the Data Sampel BPJS Kesehatan 2025 rather than synthetic rows:

  01 Client request   POST /verify, JSON — the judges' flat ClaimData, or the full claims contract (silver fields)
  02 Validation       Pydantic v2: types, ranges, closed sets, unknown fields refused
  03 Features         50 features (cost ratio, length-of-stay anomaly against the code's median and p90, severity, the
                      diagnosis' and code's statistics, the member's and facility's history) from the feature store the
                      production pipeline wrote — the same definitions as training (parity checked on real claims)
  04 ML inference     the pickle (model.pkl, joblib): CatBoost for hospitals, LightGBM for Klinik Utama, chosen by a
                      cross-validated benchmark of 9 techniques (Random Forest among them, statistically tied); the
                      probability put back on the population's scale; TreeSHAP reasons per claim
  05 LLM service      a clinical review of the claim (diagnoses, procedures, severity, stay against peers, notes) through
                      one pooled httpx.AsyncClient; every number it writes is checked against the facts it was given; a
                      timeout, a circuit breaker and a deterministic fallback keep the answer coming when the LLM is down
  06 JSON response    {status, fraud_probability, ai_reasoning} + the model, the clinical review, the tags, each stage's time

Many claims at once: POST /verify/batch (a JSON list) and POST /verify/csv (a CSV, one claim per row; GET /verify/csv/templat),
each claim through the same six stages, BATCH_PARALLEL at a time.

Run:  uvicorn main:app --host 0.0.0.0 --port 8000   (README.md: the three steps)
"""

from __future__ import annotations

import json
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Union

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

HERE = Path(__file__).resolve().parent
API = HERE.parent.parent / "api"  # the platform's code: ml_klaim (the classes inside the pickle) and the pipeline's stages
sys.path.insert(0, str(API))
load_dotenv(HERE / ".env")

from aip import layanan as L  # noqa: E402
from aip import medis  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bluesandai-inference")
PAKET = Path(os.getenv("PAKET_DIR") or HERE / "paket")
BATCH_MAX = int(os.getenv("BATCH_MAX") or 200)  # claims of one batch request (each one LLM review: minutes for hundreds)
BATCH_PARALLEL = int(os.getenv("BATCH_PARALLEL") or 8)  # claims in the pipeline at once


def load_package() -> dict[str, Any]:
    """The exported deployment package, loaded once (python export_paket.py makes it from the platform's deployed run)."""
    import joblib
    import onnxruntime as ort

    if not (PAKET / "model.pkl").is_file():
        raise RuntimeError(f"paket model tidak ada di {PAKET}: jalankan `python export_paket.py` (README langkah 2)")
    sig = json.loads((PAKET / "signature.json").read_text("utf-8"))
    bundle = joblib.load(PAKET / "model.pkl")
    sessions = {}
    for seg, info in (sig.get("segmen") or {}).items():
        f = PAKET / str(info.get("onnx") or "")
        # only an ONNX twin that passed the deployment's parity gate serves (the platform's own rule, aip/layanan.py): the
        # Random Forest of model v0.6.0 converts with max |Δp| 0.024 against its pickle, so it is served from the pickle
        if info.get("disajikan_dari") == "onnx" and info.get("onnx") and f.is_file():
            sessions[seg] = ort.InferenceSession(str(f), providers=["CPUExecutionProvider"])
    store = {n: (PAKET / "toko_fitur" / f"{n}.parquet").as_posix() for n in L.STORE if (PAKET / "toko_fitur" / f"{n}.parquet").is_file()}
    missing = [n for n in ("ref_kode", "ref_dx", "faskes") if n not in store]
    if missing:
        raise RuntimeError(f"toko fitur tidak lengkap di {PAKET / 'toko_fitur'}: {', '.join(missing)}")
    if "peserta" not in store:  # optional: without it every claim is its member's first visit (the answer says so)
        empty = PAKET / "toko_fitur" / "_peserta_kosong.parquet"
        if not empty.is_file():
            import duckdb

            duckdb.connect().execute(f"""COPY (SELECT NULL::VARCHAR AS edisi, NULL::BIGINT AS peserta_id, NULL::VARCHAR AS faskes_profil_id,
                NULL::DATE AS tgl_datang, NULL::VARCHAR AS inacbg_kode, 0::BIGINT AS n WHERE false) TO '{empty.as_posix()}' (FORMAT parquet)""")
        store["peserta"] = empty.as_posix()
    for seg, s in bundle["segments"].items():
        log.info("model %s: %s (pickle), ambang %.6f, ONNX %s", seg, s["name"], s["threshold"], "ya" if seg in sessions else "tidak")
    return {"run": sig.get("run") or "standalone", "dep": {"paket": str(PAKET), "model_versi": sig.get("model_versi"), "signature": sig},
            "bundle": bundle, "sessions": sessions, "store": store}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # startup: the model in memory once (load once, serve many) and one pooled HTTP client for the LLM
    app.state.pk = load_package()
    app.state.http = httpx.AsyncClient(timeout=float(os.getenv("LLM_TIMEOUT") or 30), limits=httpx.Limits(max_connections=32))
    key, base, model = os.getenv("LLM_API_KEY"), os.getenv("LLM_API_BASE_URL"), os.getenv("LLM_MODEL_NAME")
    if key and base and model:
        kind = "gemini" if "generativelanguage" in base else "openai"
        medis.PROVIDER.update(kind=kind, client=app.state.http, api_key=key, base_url=base, model=model, timeout=float(os.getenv("LLM_TIMEOUT") or 30))
        log.info("LLM: %s %s", kind, model)
    else:
        medis.PROVIDER.update(kind="none")
        log.warning("LLM tidak dikonfigurasi (.env): telaah klinis memakai fallback deterministik")
    L.LOG_DIR = HERE
    yield
    # shutdown: close the network connections
    await app.state.http.aclose()


app = FastAPI(title="BluesandAI — AI Inference Pipeline (Healthkathon 2026)", lifespan=lifespan,
              description="POST /verify: klaim → validasi → fitur → model (pickle) → telaah klinis LLM → {status, fraud_probability, ai_reasoning}")


@app.post("/verify")
async def verify(claim: Union[L.ClaimData, L.ClaimDataJuri]) -> dict:
    """One claim through the six stages; the judges' flat format or the full claims contract."""
    import anyio

    pk = app.state.pk
    if isinstance(claim, L.ClaimDataJuri):
        full, notes = await anyio.to_thread.run_sync(L.from_juri, claim, pk["store"])
        return await L._verify(full, pk, notes=notes)
    return await L._verify(claim, pk)


@app.post("/verify/batch")
async def verify_batch(req: L.VerifyBatchIn) -> dict:
    """Many claims in one request (a JSON list, each in the judges' format or the full claims contract), each through
    the six stages; a claim the contract refuses says why and the rest go on. {ringkasan, hasil: [the /verify answers]}."""
    if len(req.klaim) > BATCH_MAX:
        raise HTTPException(413, f"lebih dari {BATCH_MAX} klaim: pecah permintaan (BATCH_MAX di .env)")
    rows = L.read_claims_json(req.klaim, data_ok=False)
    done = await L.verify_many(rows, app.state.pk, req.pendapat_kedua, req.mesin, parallel=BATCH_PARALLEL, via="POST /verify/batch (JSON)")
    return L.many_answer(done)


@app.post("/verify/csv")
async def verify_csv(request: Request, keluaran: str = "csv", pendapat_kedua: bool = False) -> Response:
    """A CSV of claims, one per row with a header (GET /verify/csv/templat) — a file field `berkas` (multipart) or the
    body itself (text/csv). Answers a CSV: the input's columns, then status, fraud_probability, ai_reasoning and the
    details; ?keluaran=json for the /verify answers."""
    import anyio

    if (request.headers.get("content-type") or "").startswith("multipart/"):
        form = await request.form()
        f = form.get("berkas") or form.get("file")
        if f is None or not hasattr(f, "read"):
            raise HTTPException(400, "field berkas (file CSV) tidak ada")
        raw = await f.read()
    else:
        raw = await request.body()
    if len(raw) > L.MANY_BYTES:
        raise HTTPException(413, f"berkas lebih dari {L.MANY_BYTES // 1_000_000} MB")
    c = await anyio.to_thread.run_sync(L.read_claims_csv, raw, False)
    if len(c["baris"]) > BATCH_MAX:
        raise HTTPException(413, f"lebih dari {BATCH_MAX} klaim: pecah berkas (BATCH_MAX di .env)")
    done = await L.verify_many(c["baris"], app.state.pk, pendapat_kedua, "pkl", parallel=BATCH_PARALLEL, via="POST /verify/csv")
    if keluaran == "json":
        return JSONResponse(L.many_answer(done, c))
    return L._csv_response(L.results_csv(done, c["kolom"], c["pemisah"]), "hasil-verifikasi.csv")


@app.get("/verify/csv/templat")
def verify_csv_template(contoh: bool = False) -> Response:
    """The judges' columns with their two payloads: a CSV to fill; ?contoh=true: seven claims to try (constructed, not BPJS data)."""
    return L._csv_response(L.template_csv(contoh), "contoh-klaim.csv" if contoh else "templat-verifikasi-klaim.csv")


@app.get("/health")
def health() -> dict:
    pk = app.state.pk
    return {"status": "siap", "paket": str(PAKET), "model": {s: v["name"] for s, v in pk["bundle"]["segments"].items()},
            "onnx": sorted(pk["sessions"]), "toko_fitur": sorted(pk["store"]), "llm": {k: v for k, v in medis.PROVIDER.items() if k in ("kind", "model")},
            "circuit_breaker": {"gagal_beruntun": medis.BREAKER["fails"], "terbuka": medis.BREAKER["open_until"] > __import__("time").time()}}


@app.exception_handler(RuntimeError)
async def _runtime(_request, exc: RuntimeError):  # noqa: ANN001
    from fastapi.responses import JSONResponse

    return JSONResponse({"detail": str(exc)}, status_code=503)


if __name__ == "__main__":  # python main.py
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT") or 8000))
