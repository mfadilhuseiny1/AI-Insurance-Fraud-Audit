"""BluesandAI Parse API.

Wraps partition strategies from the vendored `unstructured` package (../unstructured) behind a small job API for the
Next.js UI: upload a file, start a parse job, poll progress, fetch results.

What the client sees is deliberately limited to tiers, prices and results: which engine, model or
provider handled a page, and what it cost us, stay on the server (job.json / result.internal.json).

Agentic tiers only ever use vision models; local OCR is never used, and a page the primary model
refuses goes to an OpenRouter fallback model.

Run (from this folder, with the repo's virtualenv); the UI on :8888 calls it directly:
    ..\\.venv\\Scripts\\python.exe -m uvicorn server:app --port 8000
"""

from __future__ import annotations

import functools
import gzip
import io
import hashlib
import json
import mimetypes
import logging
import os
import queue
import re
import shutil
import sys
import tempfile
import threading
import time
import uuid
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
# AI JKN Audit runs beside the platform it was copied from: instance.env at the root gives it its own ports, session
# cookie and container names. Read before any module that reads its settings at import; a variable already set wins.
if (ROOT / "instance.env").is_file():
    for _line in (ROOT / "instance.env").read_text("utf-8").splitlines():
        if "=" in _line and not _line.lstrip().startswith("#"):
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())
# the `unstructured` package is vendored at the repo root; it also finds .env.local there
sys.path.insert(0, str(ROOT))
DATA = Path(os.environ.get("BLUESANDAI_DATA_DIR", ROOT / "data"))
FILES_DIR, JOBS_DIR = DATA / "files", DATA / "jobs"
for d in (FILES_DIR, JOBS_DIR):
    d.mkdir(parents=True, exist_ok=True)

log = logging.getLogger("bluesandai.api")


def _find_poppler() -> Optional[str]:
    """pdf2image (used to render pages) needs Poppler's binaries on PATH."""
    if os.environ.get("POPPLER_PATH"):
        return os.environ["POPPLER_PATH"]
    winget = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    hits = sorted(winget.glob("oschwartz10612.Poppler_*/poppler-*/Library/bin")) if winget.is_dir() else []
    return str(hits[-1]) if hits else None


if poppler := _find_poppler():
    os.environ["PATH"] = poppler + os.pathsep + os.environ["PATH"]

import pypdfium2 as pdfium  # noqa: E402
import requests  # noqa: E402
from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response  # noqa: E402
from PIL import Image, ImageSequence  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402
import pikepdf  # noqa: E402

import auth  # noqa: E402
import auth_sso  # noqa: E402,F401  (adds the single sign-on routes to auth.router before it is mounted)
import dataset_retention  # noqa: E402
import dataset_versions  # noqa: E402
import db  # noqa: E402
import drive  # noqa: E402
import drive_import  # noqa: E402
import pipeline_datasets  # noqa: E402
import pipeline_ai  # noqa: E402
import pipeline_parse  # noqa: E402
import pipeline_runtime  # noqa: E402
import pipeline_duckdb  # noqa: E402
import pipeline_schedules  # noqa: E402
import health_checks  # noqa: E402
import pipeline_builds  # noqa: E402
import resource_usage  # noqa: E402
import streaming  # noqa: E402
import timeseries  # noqa: E402
import timeseries_demo  # noqa: E402,F401  (registers /api/timeseries/demo)
import ts_ontology  # noqa: E402
import ts_derived  # noqa: E402
import ts_alerting  # noqa: E402
import ontology_model  # noqa: E402
import ontology_branches  # noqa: E402
import ontology_explorer  # noqa: E402
import ontology_actions  # noqa: E402
import functions_registry  # noqa: E402
import ontology_design  # noqa: E402
import ontology_datasources  # noqa: E402
import ontology_semantic  # noqa: E402
import ontology_search  # noqa: E402
import ontology_scenarios  # noqa: E402
import ontology_security  # noqa: E402
import ontology_edits  # noqa: E402
import ontology_indexing  # noqa: E402
import vertex  # noqa: E402
import machinery  # noqa: E402
import foundry_rules  # noqa: E402
import dynamic_scheduling  # noqa: E402
import object_views  # noqa: E402
import ontology_manage  # noqa: E402
import object_monitors  # noqa: E402
import vulcan  # noqa: E402
import ontology_link_datasets  # noqa: E402
import ontology_attachments  # noqa: E402
import platform_sdk  # noqa: E402
import fusion  # noqa: E402
import forms  # noqa: E402
import reports  # noqa: E402
import contour  # noqa: E402
import quiver_tables  # noqa: E402
import code_workbook  # noqa: E402
import sql_bi  # noqa: E402
import presence  # noqa: E402
import ontology_mdo  # noqa: E402
import geospatial  # noqa: E402
import dataset_preview  # noqa: E402
import iceberg_catalog  # noqa: E402
import iceberg_rest  # noqa: E402
import iceberg_maintenance  # noqa: E402
import iceberg_tables  # noqa: E402
import datasources  # noqa: E402
import secretbox  # noqa: E402
import knowledge  # noqa: E402
import ontology  # noqa: E402
import agents  # noqa: E402
import modeling_objectives  # noqa: E402
import workshop  # noqa: E402
import notepad  # noqa: E402
import code_repos  # noqa: E402
import code_r_tools  # noqa: E402
import sql_studio  # noqa: E402
import sql_writes  # noqa: E402
import sql_functions  # noqa: E402
import resource_queues  # noqa: E402
import logic_flows  # noqa: E402
import demo_jkn  # noqa: E402
import demo_jkn_ontology  # noqa: E402
import demo_nelayan  # noqa: E402
import tts  # noqa: E402
import demo_jkn_map  # noqa: E402
import demo_jkn_e2e  # noqa: E402
import demo_jkn_workbench  # noqa: E402
import virtual_tables  # noqa: E402
import code_git  # noqa: E402
import cipher  # noqa: E402
import audit3  # noqa: E402
import audit_monitor  # noqa: E402
import checkpoints  # noqa: E402
import approvals  # noqa: E402
import sds  # noqa: E402
import data_lifetime  # noqa: E402
import code_scanning  # noqa: E402
import compass  # noqa: E402
import security_posture  # noqa: E402
import dc_agents  # noqa: E402
import transforms_common  # noqa: E402
import container_registry  # noqa: E402
import model_assets  # noqa: E402
import model_deployments  # noqa: E402
import model_evaluation  # noqa: E402
import model_studio  # noqa: E402
import model_overview  # noqa: E402
import demo_jkn_models  # noqa: E402
import code_workspaces  # noqa: E402
import slate  # noqa: E402
import custom_widgets  # noqa: E402
import developer_console  # noqa: E402
import agentic_apps  # noqa: E402
import orbis  # noqa: E402
import governance_center  # noqa: E402
import demo_jkn_governance  # noqa: E402
import demo_jkn_arsitektur  # noqa: E402
import osdk_api  # noqa: E402
import pilot  # noqa: E402
import carbon  # noqa: E402
import autopilot  # noqa: E402
import solution_designer  # noqa: E402
import workflow_lineage  # noqa: E402
import workflow_builder  # noqa: E402
import use_cases  # noqa: E402
import automate  # noqa: E402
import artifact_repos  # noqa: E402
import linter  # noqa: E402
import preparation  # noqa: E402
import project_references  # noqa: E402
import recipes  # noqa: E402
import peering  # noqa: E402
import media_sets  # noqa: E402
import lineage  # noqa: E402
import exports  # noqa: E402
import hyperauto  # noqa: E402
import sddi  # noqa: E402
import listeners  # noqa: E402
import views  # noqa: E402
import webhooks  # noqa: E402
import network  # noqa: E402
import language  # noqa: E402
import chunking  # noqa: E402
import storage  # noqa: E402
import unstructured_cloud  # noqa: E402
import vectors  # noqa: E402
import vision_parser  # noqa: E402
import unstructured.partition.pdf_image.bluesandai_structuring as bs  # noqa: E402
from unstructured.partition.common.lang import detect_languages  # noqa: E402
from unstructured.partition.image import partition_image  # noqa: E402
from unstructured.partition.pdf import partition_pdf  # noqa: E402
from unstructured.staging.base import elements_from_dicts, elements_to_dicts, elements_to_md  # noqa: E402

# -- Tiers. "public" is all the client ever sees; "engine" is internal. price_per_page_usd is
# -- what the customer is charged; our own cost is computed from token usage and kept server-side.
TIERS: dict[str, dict[str, Any]] = {
    "fast": {
        "public": {
            "label": "Fast",
            "best_for": "Basic PDF & General Documents",
            "description": "Semantic chunking + table and image recognition from the PDF's native text layer",
            "price_per_page_usd": 0.001,
        },
        "engine": {"strategy": "fast"},
    },
    "cost_effective": {
        "public": {
            "label": "Cost-Effective",
            "best_for": "General Documents, Business Reports",
            "description": "Semantic chunking + vision-based table and image recognition",
            # set by BLUESANDAI_PRICE_COST_EFFECTIVE in .env.local
            "price_per_page_usd": None,
        },
        # the Fast pipeline, with tables and figures located per page by a small vision model
        # (vision_parser.detect_regions) instead of the text-layout heuristic alone
        "engine": {"strategy": "fast", "layout_model": vision_parser.LAYOUT_MODEL},
    },
    "precision": {
        "public": {
            "label": "MinerU Scientific Parsing",
            "best_for": "Scientific Documents, Academic Papers",
            "description": "Formula, table, multi-column layout recognition + OCR in reading order",
            "price_per_page_usd": 0.005,
        },
        # MinerU (standard tier) on the Cloud Run L4 worker; available once MINERU_WORKER_URL is set
        "engine": {"strategy": "mineru"},
    },
    "layout": {
        "public": {
            "label": "IBM Docling",
            "best_for": "Complex Documents, Reports, RAG Pipelines",
            "description": "Layout-aware parsing + reading order + structured tables + OCR + document hierarchy",
            # shown as 280 per page (× PRICE_SCALE)
            "price_per_page_usd": 0.014,
        },
        # Docling on the Cloud Run GPU/CPU workers; available once DOCLING_WORKER_URL is set
        "engine": {"strategy": "docling"},
    },
    "paddleocr": {
        "public": {
            "label": "PaddleOCR-VL",
            "best_for": "Scanned Documents, Books",
            "description": "OCR + table, formula, and chart recognition in reading order",
            "price_per_page_usd": 0.005,
        },
        # PaddleOCR-VL 1.6 on Runpod; available once PADDLEOCR_RUNPOD_ENDPOINT_ID is set
        "engine": {"strategy": "paddleocr"},
    },
    "glmocr": {
        "public": {
            "label": "GLM-OCR",
            "best_for": "Scanned Documents, Papers, Forms",
            "description": "OCR + table and formula recognition + document layout in reading order",
            "price_per_page_usd": 0.005,
        },
        # GLM-OCR (0.9B, vLLM) on Runpod; available once GLMOCR_RUNPOD_ENDPOINT_ID is set
        "engine": {"strategy": "glmocr"},
    },
    "unstructured": {
        "public": {
            "label": "Unstructured",
            "best_for": "General Documents, Forms, Letters",
            "description": "Title, list, table, and document-element recognition + OCR",
            # override: BLUESANDAI_PRICE_UNSTRUCTURED in .env.local
            "price_per_page_usd": 0.01,
        },
        # Unstructured Transform API; available once UNSTRUCTURED_API_KEY is set (see unstructured_cloud.py)
        "engine": {"strategy": "unstructured_api"},
    },
    "agentic": {
        "public": {
            "label": "Agentic",
            "best_for": "Books, Manuals, Illustrated Documents",
            "description": "AI-powered page reading + image and diagram description",
            "price_per_page_usd": 0.01,
        },
        "engine": {"strategy": "bluesandai_structuring_lite", "model": "gemini-3.5-flash-lite"},
    },
    "agentic_plus": {
        "public": {
            "label": "Agentic Plus",
            "best_for": "Complex Books, Manuscripts",
            "description": "Highest-accuracy AI page reading for complex layouts",
            "price_per_page_usd": 0.05,
        },
        "engine": {"strategy": "bluesandai_structuring", "model": "gemini-3.5-flash"},
    },
}
LEGACY_TIERS = {"lite": "agentic", "standard": "agentic_plus", "open": "agentic"}
# USD per 1M tokens (input, output) for Gemini models; OpenRouter reports its own cost.
GEMINI_PRICES = {"gemini-3.5-flash-lite": (0.30, 2.50), "gemini-3.5-flash": (1.50, 9.00)}
# OpenRouter model for pages the primary model refuses. Never a local OCR engine.
FALLBACK_MODEL = os.environ.get("BLUESANDAI_FALLBACK_MODEL", "deepseek/deepseek-v4.1-flash")
CHUNK_PAGES = 10
# Fast tier pdfminer layout: keeps justified / 1.5-spaced paragraphs whole instead of one
# element per line or word. Keep in sync with fast-worker/main.py.
PDFMINER_LAYOUT = {"pdfminer_char_margin": 10.0, "pdfminer_line_margin": 1.0}
# concurrent chunk requests per Fast job to the Cloud Run worker (FAST_WORKER_URL in .env.local)
FAST_WORKER_PARALLEL = 8
# a Fast job's elements go to the worker's /chunk gzipped, under Cloud Run's 32 MiB request limit
FAST_WORKER_MAX_CHUNK_REQUEST = 30 * 1024 * 1024
# Layout tier (docling-worker/, deploy-docling-worker.ps1) runs on two copies of one worker: a GPU
# service (DOCLING_WORKER_URL, one L4 instance converting one chunk at a time with one queued, so a
# job sends 2 chunks at once) and a CPU service (DOCLING_CPU_WORKER_URL, one chunk per instance, many
# instances). Same models and settings, so the same output. A GPU instance is billed until it scales
# down (~6 min idle measured), a CPU instance only while it converts: small work goes to CPU unless
# the GPU is already warm. The deploy script sets the *_PARALLEL values.
DOCLING_WORKER_PARALLEL = 2
DOCLING_CPU_WORKER_PARALLEL = 20
DOCLING_WORKER_TIMEOUT = 900
# Measured: CPU is ~5x slower than the L4 on text pages, and OCR (scans, figures) is ~8x slower
# (38 s/page, more than the Layout price per page), so OCR-heavy work always goes to the GPU
# (DOCLING_GPU_OCR_SHARE: share of sampled pages with a large image). Other work goes to the GPU
# from DOCLING_GPU_MIN_PAGES pages (this job plus queued Layout jobs), where the GPU's ~$0.20 idle
# time is cheaper than CPU's slower pages.
DOCLING_GPU_MIN_PAGES = 400
DOCLING_GPU_OCR_SHARE = 0.2
# CPU requests carry 2 pages: figure-heavy pages can take minutes each on CPU (Cloud Run's request
# timeout is 15 min), and many small requests spread over many instances
DOCLING_CPU_CHUNK_PAGES = 2
# a GPU used this recently is still up and already paid for until it scales down: use it for any
# size (override: DOCLING_GPU_WARM_SECONDS)
DOCLING_GPU_WARM_SECONDS = 300
# Approximate Cloud Run cost per busy second, USD, internal tracking only: L4 instance (1 GPU,
# 8 vCPU, 32 GiB) and request-billed CPU instance (8 vCPU, 16 GiB)
# (override: DOCLING_COST_PER_SECOND_USD, DOCLING_CPU_COST_PER_SECOND_USD)
DOCLING_COST_PER_SECOND = 0.00045
DOCLING_CPU_COST_PER_SECOND = 0.00023
# Runpod Serverless Docling endpoint (docling-worker/Dockerfile.runpod, built by Runpod from GitHub):
# used for every IBM Docling job when DOCLING_RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are set.
# Chunks in flight per job: 2 per worker (one running, one queued), for 3 workers.
DOCLING_RUNPOD_PARALLEL = 6
# Runpod Serverless 24 GB tier (L4 / A5000 / 3090), flex worker: $0.69/hour
DOCLING_RUNPOD_COST_PER_SECOND = 0.69 / 3600
# Precision tier (mineru-worker/, deploy-mineru-worker.ps1): one chunk per GPU instance at a time,
# so a job sends MINERU_WORKER_PARALLEL chunks at once (the deploy script sets it to max-instances).
# A cold instance loads its models before taking a request, so the timeout covers that too.
MINERU_WORKER_PARALLEL = 1
MINERU_WORKER_TIMEOUT = 3600
# Cloud Run request limit is 32 MiB; Precision needs a page's images, so big chunks go page by page
MINERU_MAX_CHUNK_BYTES = 30 * 1024 * 1024
# Cloud Run list price of one L4 instance in asia-southeast1, instance-based billing, USD per second:
# GPU without zonal redundancy 0.00022404 + 8 vCPU x 0.0000216 + 32 GiB x 0.0000024 (= $1.705/hour).
# Internal cost tracking only (override: MINERU_COST_PER_SECOND_USD)
MINERU_COST_PER_SECOND = 0.00047364
# Precision jobs under this many pages go to the CPU build of the worker (Dockerfile.cpu,
# MINERU_CPU_WORKER_URL): slower per page, but billed only while parsing, so small jobs don't pay a
# GPU instance's start-up and idle time. Larger jobs, or no CPU worker configured, use the GPU.
# Measured break-even with a cold GPU job (start-up + 15 min idle): ~70 pages (CPU ~$0.0071/page,
# GPU ~$0.00048/page + ~$0.49 per job).
MINERU_CPU_MAX_PAGES = 70
MINERU_CPU_WORKER_PARALLEL = 10
# Cloud Run list price of one 8 vCPU / 16 GiB instance in asia-southeast2 (tier 2, request-based
# billing), USD per second: 8 x 0.0000336 + 16 x 0.0000035 (override: MINERU_CPU_COST_PER_SECOND_USD)
MINERU_CPU_COST_PER_SECOND = 0.0003248
# Runpod Serverless MinerU endpoint (mineru-worker/Dockerfile.runpod, built by Runpod from GitHub):
# used instead of Cloud Run's L4 when MINERU_RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are set.
MINERU_RUNPOD_PARALLEL = 3
# Runpod Serverless 24 GB tier (L4 / A5000 / 3090), flex worker: $0.69/hour
MINERU_RUNPOD_COST_PER_SECOND = 0.69 / 3600
# PaddleOCR-VL tier (paddleocr-worker/, github.com/mfadilhuseiny1/bluesandai-paddleocr-worker):
# Runpod Serverless only, one chunk per worker at a time (PADDLEOCR_RUNPOD_PARALLEL chunks per job)
PADDLEOCR_RUNPOD_PARALLEL = 3
# Runpod Serverless 24 GB tier (L4 / A5000 / 3090), flex worker: $0.69/hour
PADDLEOCR_RUNPOD_COST_PER_SECOND = 0.69 / 3600
# GLM-OCR tier (glmocr-worker/, github.com/mfadilhuseiny1/bluesandai-glmocr-worker): same as PaddleOCR-VL
GLMOCR_RUNPOD_PARALLEL = 3
GLMOCR_RUNPOD_COST_PER_SECOND = 0.69 / 3600
# /run accepts 10 MB; base64 adds a third, so bigger chunks go as an S3 presigned URL
RUNPOD_MAX_INLINE_BYTES = 7 * 1024 * 1024
RUNPOD_JOB_TIMEOUT = 3600
# Unstructured tier: concurrent chunk jobs per job (override: UNSTRUCTURED_PARALLEL), our cost per
# page for internal tracking (override: UNSTRUCTURED_COST_PER_PAGE_USD), and the image types its API
# accepts (others are sent as PNG)
UNSTRUCTURED_PARALLEL = 4
UNSTRUCTURED_COST_PER_PAGE = 0.0
UNSTRUCTURED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"}
MAX_UPLOAD_MB = 50
# Clients see prices as USD × this factor, without a unit (override: BLUESANDAI_PRICE_SCALE).
PRICE_SCALE = 20000.0
# element metadata that would reveal how a page was produced (or server paths)
INTERNAL_METADATA = {"detection_origin", "bluesandai_fallback", "file_directory", "detection_class_prob"}
PUBLIC_ERROR = "Parsing failed. Please try again; if it keeps failing, contact support."

app = FastAPI(title="BluesandAI Parse API")
auth.configure(DATA)
app.include_router(auth.router)
import governance_model  # noqa: E402  (spaces, Project constraints and templates, portfolios)

governance_model.configure()
app.include_router(governance_model.router)
import restricted_views  # noqa: E402

restricted_views.configure(DATA)
app.include_router(restricted_views.router)
import backups  # noqa: E402  (encrypted, scheduled, verified backups)
import scim  # noqa: E402  (SCIM 2.0 provisioning at /scim/v2)
import marketplace  # noqa: E402  (the Marketplace store)

marketplace.configure(DATA)
app.include_router(marketplace.router)

app.include_router(scim.router)
app.include_router(scim.admin)

backups.configure(DATA)
app.include_router(backups.router)
drive.configure(DATA)
dataset_versions.configure(DATA)
app.include_router(drive.router)
app.include_router(drive_import.router)
app.include_router(pipeline_datasets.router)
app.include_router(pipeline_ai.router)
from aip import vertex as aip_vertex  # noqa: E402  (open models on Vertex AI: GET /api/aip/models, /api/aip/spend)
app.include_router(aip_vertex.router)
from aip import gateway as aip_gateway, missions as aip_missions, runs as aip_runs  # noqa: E402  (AIP agents on ADK: gateway, runs, missions)
app.include_router(aip_gateway.router)
app.include_router(aip_runs.router)
app.include_router(aip_missions.router)
from aip import voice as aip_voice  # noqa: E402  (AIP voice: speech to text and text to speech on OpenAI)
app.include_router(aip_voice.router)
from aip import ml as aip_ml  # noqa: E402  (AIP machine learning: supervised claim-risk models, benchmark, explainers)
app.include_router(aip_ml.router)
from aip import control as aip_control  # noqa: E402  (AIP evaluation & production-control plane: golden evals, run ledger, gates)
app.include_router(aip_control.router)
from aip import evaluasi_swarm as aip_evaluasi_swarm  # noqa: E402  (AIP Evaluasi Swarm: each AI Agent Swarm engagement scored from its trail)
app.include_router(aip_evaluasi_swarm.router)
from aip import indikasi as aip_indikasi, karantina as aip_karantina, konsultan as aip_konsultan  # noqa: E402  (AIP fraud consultancy: semantic layer, tags, quarantine box, the agents' firm)
app.include_router(aip_indikasi.router)
app.include_router(aip_karantina.router)
app.include_router(aip_konsultan.router)
from aip import konfigurasi_agen as aip_konfigurasi_agen  # noqa: E402  (AIP AI Agent Swarm: each agent's algorithm, tools, prompt and settings)
app.include_router(aip_konfigurasi_agen.router)
from aip import layanan as aip_layanan, medis as aip_medis, produksi as aip_produksi  # noqa: E402  (AIP fraud production pipeline, online inference, clinical review)
app.include_router(aip_produksi.router)
app.include_router(aip_layanan.router)
app.include_router(aip_medis.router)
from aip import telaah as aip_telaah  # noqa: E402  (Blu 1.1: the clinical review of every screened claim before the swarm)
app.include_router(aip_telaah.router)
from aip import jaringan as aip_jaringan, skills as aip_skills  # noqa: E402  (AIP: the network of every agent; agent skills and their lessons)
app.include_router(aip_jaringan.router)
app.include_router(aip_skills.router)
from aip import realtime as aip_realtime  # noqa: E402  (AIP Realtime Fraud: streamed claims, entity resolution, graph, live scoring, cases)
app.include_router(aip_realtime.router)


@app.on_event("startup")
def _realtime_fraud() -> None:
    # the realtime fraud engine resumes when it was on (as the admin who switched it on)
    try:
        from aip.realtime import mesin as aip_realtime_mesin

        aip_realtime_mesin.startup()
    except Exception:
        log.exception("realtime fraud engine unavailable")
app.include_router(pipeline_parse.router)
app.include_router(pipeline_runtime.router)
# the DuckDB local engine: builds of pipelines with compute "duckdb" (also under /api/pipeline)
app.include_router(pipeline_duckdb.router)
# schedules: triggers, run history and retries (also under /api/pipeline)
app.include_router(pipeline_schedules.router, prefix="/api/pipeline")
app.include_router(health_checks.router)
# build debugging (search, compare, logs, rerun, explain) and Resource Management
app.include_router(pipeline_builds.router, prefix="/api/pipeline")
app.include_router(resource_usage.router)
app.include_router(datasources.router)
app.include_router(vectors.router)
app.include_router(knowledge.router)
app.include_router(ontology.router)
app.include_router(agents.router)
app.include_router(modeling_objectives.router)
app.include_router(workshop.router)
app.include_router(notepad.router)
# the R transforms app's runtime / packages / renv routes, ahead of /{repo_id}
app.include_router(code_r_tools.router)
# SQL in Foundry: SQL Studio, the SQL console and worksheets
sql_studio.configure(DATA)
app.include_router(sql_studio.router)
sql_writes.configure(DATA)
app.include_router(sql_writes.router)
app.include_router(sql_functions.router)
resource_queues.configure(DATA)
app.include_router(resource_queues.router)
app.include_router(logic_flows.router)
app.include_router(demo_jkn.router)
app.include_router(demo_jkn_ontology.router)
app.include_router(demo_nelayan.router)
app.include_router(tts.router)
app.include_router(demo_jkn_map.router)
app.include_router(demo_jkn_e2e.router)
app.include_router(demo_jkn_workbench.router)
app.include_router(virtual_tables.router)
app.include_router(code_git.router)
app.include_router(cipher.router)
cipher.configure(DATA)
# Security & Governance: audit.3 logs (Security auditing)
app.include_router(audit3.router)
app.include_router(audit3.siem)
app.include_router(audit_monitor.router)
app.include_router(checkpoints.router)
app.include_router(checkpoints.exports_router)
checkpoints.configure(DATA)
app.include_router(approvals.router)
approvals.configure(DATA)
app.include_router(sds.router)
sds.configure(DATA)
app.include_router(data_lifetime.router)
data_lifetime.configure(DATA)
app.include_router(code_scanning.router)
code_scanning.configure(DATA)
app.include_router(compass.router)
compass.configure(DATA)
app.include_router(security_posture.router)
security_posture.configure(DATA)
audit3.configure(DATA)
demo_jkn.configure(DATA)
demo_jkn_e2e.configure(DATA)
app.include_router(dc_agents.router)
# Transforms common: local preview tasks, environments and debug jobs, multi-output advice
transforms_common.configure(DATA)
app.include_router(transforms_common.router)
# Containers: Docker Artifacts repositories, the registry API at /v2 and the sidecar runtime
container_registry.configure(DATA)
app.include_router(container_registry.router)
app.include_router(container_registry.registry)
# Container-backed models: model resources owning a Docker Artifacts repository, versions with an adapter
model_assets.configure(DATA)
app.include_router(model_assets.router)
# Model deployments that run (live endpoints, model functions, batch deployments) and automatic evaluation
model_deployments.configure(DATA)
app.include_router(model_deployments.router)
app.include_router(model_deployments.live_router)
app.include_router(model_evaluation.router)
model_studio.configure(DATA)
app.include_router(model_studio.router)
import code_provenance  # noqa: E402  (the training code of every model version, kept for its audit)
import ml_studio  # noqa: E402  (AIP JKN · ML Studio: models, training runs and the audit of their code)

code_provenance.configure(DATA)
app.include_router(ml_studio.router)
model_overview.configure(DATA)
app.include_router(model_overview.router)
demo_jkn_models.configure(DATA)
app.include_router(demo_jkn_models.router)
code_workspaces.configure(DATA, lambda k: _env(k))
app.include_router(code_workspaces.router)
app.include_router(code_workspaces.pod_router)
import code_workspace_lab  # noqa: E402
app.include_router(code_workspace_lab.router)
import code_workspace_versions  # noqa: E402
app.include_router(code_workspace_versions.router)
import code_workspace_env  # noqa: E402
app.include_router(code_workspace_env.router)
import code_workspace_terminals  # noqa: E402
app.include_router(code_workspace_terminals.router)
import code_workspace_vscode  # noqa: E402
app.include_router(code_workspace_vscode.router)
import code_workspace_assist  # noqa: E402
app.include_router(code_workspace_assist.router)
import nodered_platform  # noqa: E402
app.include_router(nodered_platform.router)
import mqtt_broker  # noqa: E402
app.include_router(mqtt_broker.router)
# Slate: low-code applications (versions, queries, public applications, secure upload)
slate.configure(DATA)
app.include_router(slate.router)
# Custom widgets: widget sets, releases, signed widget assets and the host's Ontology calls
custom_widgets.configure(DATA)
app.include_router(custom_widgets.router)
app.include_router(custom_widgets.assets)
# Developer Console: applications (OAuth2 clients, scopes, SDKs, website hosting) and the OSDK REST API (/api/v2)
developer_console.configure(DATA)
app.include_router(developer_console.router)
app.include_router(developer_console.oauth)
app.include_router(developer_console.hosting)
agentic_apps.configure(DATA)
app.include_router(agentic_apps.router)
orbis.configure(DATA)
app.include_router(orbis.router)
app.include_router(governance_center.router)
app.include_router(demo_jkn_governance.router)
import demo_jkn_akses  # noqa: E402  (demo: access per account)

demo_jkn_akses.configure(DATA)
app.include_router(demo_jkn_akses.router)
app.include_router(demo_jkn_arsitektur.router)
import demo_jkn_fraud  # noqa: E402  (demo: fraud intelligence — 6 pain points)

demo_jkn_fraud.configure(DATA)
app.include_router(demo_jkn_fraud.router)
import demo_jkn_mobile  # noqa: E402  (demo: JKN mobile PWAs - petugas, rumah sakit, peserta)
demo_jkn_mobile.configure(DATA)
app.include_router(demo_jkn_mobile.router)
import jkn_agent  # noqa: E402  (demo: AIP agent JKN with platform tools)
app.include_router(jkn_agent.router)
import demo_grid_e2e  # noqa: E402  (demo: grid management, technical and non-technical losses)

demo_grid_e2e.configure(DATA)
app.include_router(demo_grid_e2e.router)
import demo_grid_akses  # noqa: E402  (demo: grid access per account)
app.include_router(demo_grid_akses.router)
import orbis_grid  # noqa: E402  (demo: Bluesand Orbis on the grid demo)
orbis_grid.configure(DATA)
app.include_router(orbis_grid.router)
import demo_grid_arsitektur  # noqa: E402  (demo: grid architecture page)
app.include_router(demo_grid_arsitektur.router)
import demo_grid_ami  # noqa: E402  (demo: grid AMI streaming, phase 5)
app.include_router(demo_grid_ami.router)
import demo_grid_ntl_stream  # noqa: E402  (demo: grid hourly NTL scoring & bypass detection, phase 5)
app.include_router(demo_grid_ntl_stream.router)
import demo_grid_sensor_gardu  # noqa: E402  (demo: grid DT sensors, TL & overload risk, phase 5)
app.include_router(demo_grid_sensor_gardu.router)
import demo_grid_feedback  # noqa: E402  (demo: grid P2TL feedback loop & hit-rate, phase 5)
app.include_router(demo_grid_feedback.router)
import pln_cockpit  # noqa: E402  (PLN Grid Monitoring Cockpit: transmission operations intelligence)
pln_cockpit.configure(DATA)
app.include_router(pln_cockpit.router)
import grid_nexus  # noqa: E402  (Grid Intelligence Nexus: semantic knowledge graph inside Vertex)
grid_nexus.configure(DATA)
app.include_router(grid_nexus.router)
import jkn_nexus  # noqa: E402  (JKN Intelligence Nexus: the same semantic knowledge graph for the JKN audit demo)
app.include_router(jkn_nexus.router)
app.include_router(osdk_api.router)
# Pilot: applications and custom widgets built from prompts (agents, seed-data previews, deploys)
pilot.configure(DATA)
app.include_router(pilot.router)
# Carbon: curated workspaces (menu, home page, modules in tabs, access, What's New, YAML, versions)
carbon.configure(DATA)
app.include_router(carbon.router)
# Autopilot: Automate workflows as states, a dependency graph, automation events and object timelines
autopilot.configure(DATA)
app.include_router(autopilot.router)
# Solution Designer: architecture diagrams, reference library, AIP Architect and AIP Critic
solution_designer.configure(DATA)
app.include_router(solution_designer.router)
# Workflow Lineage: the graph of resources behind applications, color modes, permissions, bulk changes
workflow_lineage.configure(DATA)
app.include_router(workflow_lineage.router)
# Workflow Builder: Ontology workflows as graphs of nodes, sandboxed previews, deployed triggers
workflow_builder.configure(DATA)
app.include_router(workflow_builder.router)
# Use Cases [Sunset]: a builder's view of a workflow Project (applications, Ontology, backing data, metadata)
use_cases.configure(DATA)
app.include_router(use_cases.router)
# Automate: the automation engine (conditions, effects with retries and fallbacks, history, manual runs)
app.include_router(automate.router)
artifact_repos.configure(DATA)
app.include_router(artifact_repos.router)
app.include_router(artifact_repos.clients)
# Linter: rules, sweep schedules, recommendations and impact tracking
app.include_router(linter.router)
# Preparation [Sunset] and Project references
app.include_router(preparation.router)
app.include_router(project_references.router)
# Recipes [Sunset]
app.include_router(recipes.router)
# Peer Manager: network connections, peer connections, ontology peering, jobs, profiles
app.include_router(peering.router)
app.include_router(peering.remote)
app.include_router(code_repos.router)
app.include_router(code_repos.artifacts_router)
app.include_router(media_sets.router)
app.include_router(lineage.router)
app.include_router(exports.router)
app.include_router(webhooks.sources_router)
app.include_router(webhooks.router)
app.include_router(listeners.router)
app.include_router(listeners.inbound)
app.include_router(views.router)
app.include_router(hyperauto.router)
app.include_router(sddi.router)
app.include_router(network.router)
app.include_router(streaming.router)
# streaming datasets in Dataset Preview: archives, the Stream and Metrics tabs
import stream_datasets  # noqa: E402

app.include_router(stream_datasets.router)
app.include_router(timeseries.router)
app.include_router(ts_ontology.router)
app.include_router(ts_derived.router)
app.include_router(ts_alerting.router)
app.include_router(ontology_model.router)
app.include_router(ontology_branches.router)
app.include_router(ontology_explorer.router)
app.include_router(ontology_actions.router)
app.include_router(ontology_actions.notes_router)
app.include_router(functions_registry.router)
import function_integration  # noqa: E402  (business logic templates, AIP-written functions, where functions are used)
app.include_router(function_integration.router)
app.include_router(ontology_design.router)
app.include_router(ontology_datasources.router)
app.include_router(ontology_semantic.router)
app.include_router(ontology_search.router)
app.include_router(ontology_scenarios.router)
app.include_router(ontology_security.router)
app.include_router(ontology_edits.router)
app.include_router(ontology_indexing.router)
app.include_router(vertex.router)
app.include_router(machinery.router)
app.include_router(foundry_rules.router)
app.include_router(dynamic_scheduling.router)
app.include_router(object_views.router)
app.include_router(ontology_manage.router)
app.include_router(object_monitors.router)
app.include_router(vulcan.router)
app.include_router(ontology_link_datasets.router)
app.include_router(geospatial.router)
app.include_router(dataset_preview.router)
app.include_router(iceberg_rest.router)
app.include_router(iceberg_tables.router)
app.include_router(ontology_attachments.router)
app.include_router(platform_sdk.router)
app.include_router(fusion.router)
app.include_router(forms.router)
app.include_router(reports.router)
app.include_router(contour.router)
app.include_router(quiver_tables.router)
app.include_router(code_workbook.router)
app.include_router(sql_bi.router)
app.include_router(presence.router)
app.include_router(ontology_mdo.router)
app.include_router(iceberg_maintenance.router)
from aip import akses as aip_akses  # noqa: E402  (AIP JKN tab "Keamanan & Akses": the access scheme per role, GET /api/aip/akses)
app.include_router(aip_akses.router)


# sign-in: every /api request needs a signed-in user (auth.py); runs inside the ingress check
# staged-writes transactions of Python functions (header x-bluesandai-scenario): added before auth, so it runs inside it
app.middleware("http")(ontology_scenarios.middleware)
# checkpoints (checkpoints.py): sensitive interactions ask for a justification first; innermost, inside auth and audit
app.middleware("http")(checkpoints.middleware)
# audit.3 lines for user requests (audit3.py): added before auth, so it runs inside it and knows the user
app.middleware("http")(audit3.middleware)
app.middleware("http")(auth.middleware)


@app.middleware("http")
async def _ingress(request, call_next):  # noqa: ANN001
    """Ingress allowlists (network.py): refuse clients outside them when enforcement is on."""
    why = network.ingress_allowed(request)
    if why:
        return JSONResponse({"detail": f"Forbidden by the network ingress policy: {why}"}, status_code=403)
    return await call_next(request)


@app.middleware("http")
async def _security_headers(request, call_next):  # noqa: ANN001
    """No MIME sniffing of served files and no full URLs (tokens in paths) leaking as referrers; responses that set
    their own policy (hosted websites, widget files) keep it."""
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if response.headers.get("content-type", "").startswith("text/html"):
        response.headers.setdefault("Content-Security-Policy", "object-src 'none'; base-uri 'self'")
    return response


# outermost, so refusals (401, 403) carry CORS headers too; credentials: the session cookie.
# The web may be opened by its LAN address (Next's "Network:" URL, another device on the same network):
# those origins are private-network requests to this API, which browsers refuse unless the API allows
# both the origin and the private network — hence the LAN origin pattern and allow_private_network
# (an explicit BLUESANDAI_WEB_ORIGINS replaces both).
_env_origins = os.environ.get("BLUESANDAI_WEB_ORIGINS")
_origins = [o.strip() for o in (_env_origins or "http://localhost:8888,http://127.0.0.1:8888").split(",") if o.strip()]
_LAN_WEB = r"http://(localhost|127\.0\.0\.1|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}):8888"
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_origin_regex=None if _env_origins else _LAN_WEB,
                   allow_credentials=True, allow_private_network=True, allow_methods=["*"], allow_headers=["*"])
import path_slashes  # noqa: E402  (primary keys with a slash, e.g. OSM way/123, in {pk} routes)
app.add_middleware(path_slashes.EncodedSlashes)
# Developer Console applications' registered origins may call the OSDK API and the token endpoint (outermost)
app.middleware("http")(developer_console.cors)


def _db(fn: Any, *args: Any) -> None:
    """Mirror a write into PostgreSQL; a database problem is logged, never fails the request/job."""
    if not db.enabled():
        return
    try:
        fn(*args)
    except Exception:
        log.exception("database write failed: %s", getattr(fn, "__name__", fn))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _env(key: str) -> str:
    return (os.environ.get(key) or bs._read_env_local().get(key) or "").strip()


def _price_scale() -> float:
    """Prices are kept in USD internally; clients see them multiplied by this (unitless) factor."""
    try:
        return float(_env("BLUESANDAI_PRICE_SCALE") or PRICE_SCALE)
    except ValueError:
        return PRICE_SCALE


def _shown(usd: Optional[float]) -> Optional[float]:
    return None if usd is None else round(usd * _price_scale(), 4)


def _price(tier_id: str) -> Optional[float]:
    """Selling price per page in USD; .env.local is re-read so edits apply without a restart."""
    if tier_id == "cost_effective":
        try:
            return float(_env("BLUESANDAI_PRICE_COST_EFFECTIVE"))
        except ValueError:
            return None
    if tier_id == "unstructured" and _env("BLUESANDAI_PRICE_UNSTRUCTURED"):
        try:
            return float(_env("BLUESANDAI_PRICE_UNSTRUCTURED"))
        except ValueError:
            pass
    return TIERS[tier_id]["public"]["price_per_page_usd"]


def _tier_available(tier_id: str, kind: str = "pdf") -> tuple[bool, Optional[str]]:
    if tier_id == "cost_effective" and (not vision_parser.enabled(_env) or _price(tier_id) is None):
        return False, "Coming soon"
    if tier_id == "precision" and not (
        (_env("MINERU_WORKER_URL") and _env("MINERU_WORKER_TOKEN"))
        or (_env("MINERU_RUNPOD_ENDPOINT_ID") and _env("RUNPOD_API_KEY"))
    ):
        return False, "Coming soon"
    if tier_id == "layout" and not (
        (_env("DOCLING_WORKER_URL") and _env("DOCLING_WORKER_TOKEN"))
        or (_env("DOCLING_RUNPOD_ENDPOINT_ID") and _env("RUNPOD_API_KEY"))
    ):
        return False, "Coming soon"
    if tier_id == "paddleocr" and not (_env("PADDLEOCR_RUNPOD_ENDPOINT_ID") and _env("RUNPOD_API_KEY")):
        return False, "Coming soon"
    if tier_id == "glmocr" and not (_env("GLMOCR_RUNPOD_ENDPOINT_ID") and _env("RUNPOD_API_KEY")):
        return False, "Coming soon"
    if tier_id == "unstructured" and not unstructured_cloud.is_configured(unstructured_cloud.settings(_env)):
        return False, "Coming soon"
    if tier_id in ("fast", "cost_effective") and kind != "pdf":
        return False, "PDF only"
    return True, None


def _public_tier(tier_id: str) -> dict:
    available, reason = _tier_available(tier_id)
    public = TIERS[tier_id]["public"]
    # prices go out as plain numbers: no currency in field names or values
    return {
        "id": tier_id,
        "label": public["label"],
        "best_for": public["best_for"],
        "description": public["description"],
        "price_per_page": _shown(_price(tier_id)),
        "available": available,
        "unavailable_reason": reason,
    }


# ------------------------------------------------------------------------------------------------
# files
# ------------------------------------------------------------------------------------------------


def _file_dir(file_id: str) -> Path:
    d = FILES_DIR / file_id
    if not (d / "meta.json").is_file():
        raise HTTPException(404, "file not found")
    return d


@app.post("/api/files")
async def upload_file(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix != ".pdf" and suffix not in IMAGE_SUFFIXES:
        raise HTTPException(400, "only PDF and image files are supported")
    file_id = uuid.uuid4().hex[:12]
    d = FILES_DIR / file_id
    d.mkdir(parents=True)
    stored = d / f"source{suffix}"
    size = 0
    with open(stored, "wb") as f:
        while block := file.file.read(1024 * 1024):
            size += len(block)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                break
            f.write(block)
    if size > MAX_UPLOAD_MB * 1024 * 1024:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(413, f"file is larger than {MAX_UPLOAD_MB} MB")
    public = _register_file(d, stored, file.filename or stored.name)
    # a copy goes to My Project / Document, in the background like the S3 upload
    threading.Thread(target=_save_upload_to_files, args=(d,), daemon=True).start()
    return public


def _save_upload_to_files(d: Path) -> None:
    """Copy an uploaded file into the default Document folder and remember the copy, so that
    choosing it from Files later reuses this upload."""
    meta = _read_json(d / "meta.json")
    content_type = "application/pdf" if meta["kind"] == "pdf" else (
        mimetypes.guess_type(meta["name"])[0] or "application/octet-stream"
    )
    item = drive.save_to_default("documents", meta["name"], d / meta["stored_name"], content_type)
    if item:
        _write_json(d / "meta.json", {**_read_json(d / "meta.json"), "drive_item_id": item["id"]})


class DriveFileRequest(BaseModel):
    item_id: str


@app.post("/api/files/from-drive")
def file_from_drive(req: DriveFileRequest) -> dict:
    """Use a file from the Files tab for parsing: it is copied in and registered like an upload.
    Picking the same drive file again reuses the earlier copy (drive files never change)."""
    item = drive.get_file(req.item_id)
    suffix = Path(item["name"]).suffix.lower()
    if suffix != ".pdf" and suffix not in IMAGE_SUFFIXES:
        raise HTTPException(400, "only PDF and image files can be parsed")
    if item["size_bytes"] > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"file is larger than {MAX_UPLOAD_MB} MB")
    for meta_path in FILES_DIR.glob("*/meta.json"):
        meta = _read_json(meta_path)
        if meta.get("drive_item_id") == item["id"] and (meta_path.parent / meta["stored_name"]).is_file():
            return _public_file(meta)
    file_id = uuid.uuid4().hex[:12]
    d = FILES_DIR / file_id
    d.mkdir(parents=True)
    stored = d / f"source{suffix}"
    try:
        drive.copy_content(item, stored)
    except Exception as e:
        shutil.rmtree(d, ignore_errors=True)
        log.exception("could not copy drive file %s", item["id"])
        raise HTTPException(502, "could not read this file from Files") from e
    return _register_file(d, stored, item["name"], drive_item_id=item["id"])


def _register_file(d: Path, stored: Path, name: str, **extra: Any) -> dict:
    """Count pages, write meta.json, mirror to PostgreSQL and S3; returns the public file."""
    suffix = stored.suffix
    try:
        if suffix == ".pdf":
            pages = len(pdfium.PdfDocument(str(stored)))
        else:
            with Image.open(stored) as img:
                pages = sum(1 for _ in ImageSequence.Iterator(img))
    except Exception as e:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, "could not read this file") from e
    meta = {
        "id": d.name,
        "name": name,
        "stored_name": stored.name,
        "kind": "pdf" if suffix == ".pdf" else "image",
        "pages": pages,
        "size": stored.stat().st_size,
        "uploaded_at": _now(),
        **extra,
    }
    _write_json(d / "meta.json", meta)
    _db(db.upsert_file, meta, str(stored))
    if storage.enabled():
        # upload in the background: the user shouldn't wait on a 50 MB transfer to S3
        threading.Thread(target=_upload_source, args=(meta, stored), daemon=True).start()
    return _public_file(meta)


def _upload_source(meta: dict, path: Path) -> None:
    content_type = "application/pdf" if meta["kind"] == "pdf" else "application/octet-stream"
    try:
        storage.put_file(f"files/{meta['id']}/{path.name}", str(path), content_type)
    except Exception:
        log.exception("S3 upload of file %s failed", meta["id"])


def _public_file(meta: dict) -> dict:
    return {k: meta[k] for k in ("id", "name", "kind", "pages", "size", "uploaded_at")}


@app.get("/api/files/{file_id}")
def get_file(file_id: str) -> dict:
    return _public_file(_read_json(_file_dir(file_id) / "meta.json"))


@app.get("/api/files/{file_id}/pages/{page}")
def page_image(file_id: str, page: int, width: int = 1100) -> Response:
    """A page rendered to PNG for the viewer (cached on disk)."""
    d = _file_dir(file_id)
    meta = _read_json(d / "meta.json")
    if not 1 <= page <= meta["pages"]:
        raise HTTPException(404, "page out of range")
    width = max(200, min(width, 2400))
    cache = d / "pages" / f"{page}-{width}.png"
    if not cache.is_file():
        cache.parent.mkdir(exist_ok=True)
        src = d / meta["stored_name"]
        if meta["kind"] == "pdf":
            pdf_page = pdfium.PdfDocument(str(src))[page - 1]
            img = pdf_page.render(scale=width / pdf_page.get_width()).to_pil()
        else:
            with Image.open(src) as im:
                frame = next(f for i, f in enumerate(ImageSequence.Iterator(im)) if i == page - 1)
                img = frame.convert("RGB")
                img = img.resize((width, round(img.height * width / img.width)))
        img.save(cache, format="PNG")
    return FileResponse(cache, media_type="image/png", headers={"Cache-Control": "max-age=86400"})


@app.get("/api/files/{file_id}/download")
def download_source(file_id: str) -> FileResponse:
    meta = _read_json(_file_dir(file_id) / "meta.json")
    return FileResponse(FILES_DIR / file_id / meta["stored_name"], filename=meta["name"])


# ------------------------------------------------------------------------------------------------
# jobs
# ------------------------------------------------------------------------------------------------


class JobRequest(BaseModel):
    file_id: str
    tier: str = "agentic"
    page_from: Optional[int] = None
    page_to: Optional[int] = None
    languages: list[str] = Field(default_factory=lambda: ["ind", "ara"])
    instructions: Optional[str] = None


def _job_path(job_id: str) -> Path:
    p = JOBS_DIR / job_id / "job.json"
    if not p.is_file():
        raise HTTPException(404, "job not found")
    return p


_jobs_lock = threading.Lock()
_queue: "queue.Queue[str]" = queue.Queue()
# Jobs run JOB_WORKERS at a time (override: BLUESANDAI_JOB_WORKERS), so a small job doesn't wait
# behind a long one. Agentic jobs run in this process and measure their cost from the shared token
# counters in bluesandai_structuring, so they still run one at a time (_agentic_lock).
JOB_WORKERS = 10
_agentic_lock = threading.Lock()


def _update_job(job_id: str, **changes: Any) -> dict:
    with _jobs_lock:
        p = JOBS_DIR / job_id / "job.json"
        job = _read_json(p)
        job.update(changes)
        _write_json(p, job)
    _db(db.upsert_job, job, job.get("price_per_page_usd"))
    return job


def _public_job(job: dict) -> dict:
    """The customer-facing view of a job: no engine, model, provider or internal cost."""
    tier_id = LEGACY_TIERS.get(job["tier"], job["tier"])
    # the price is fixed when the job is created, so later price changes don't rewrite history
    price = job.get("price_per_page_usd", _price(tier_id)) or 0.0
    return {
        "id": job["id"],
        "file_id": job["file_id"],
        "file_name": job["file_name"],
        "tier": tier_id,
        "tier_label": TIERS[tier_id]["public"]["label"],
        "languages": job["languages"],
        "instructions": job["instructions"],
        "page_from": job["page_from"],
        "page_to": job["page_to"],
        "pages_total": job["pages_total"],
        "pages_done": job["pages_done"],
        "status": job["status"],
        "batch_id": job.get("batch_id"),
        # while a running job winds down after Pause or Stop: "pause" | "stop"
        "halt": job.get("halt") if job["status"] in ("queued", "running") else None,
        # completed from the pages parsed before Stop (the rest are in pages_not_parsed)
        "partial": bool(job.get("partial")),
        "error": PUBLIC_ERROR if job["status"] == "failed" else None,
        "created_at": job["created_at"],
        "started_at": job["started_at"],
        "finished_at": job["finished_at"],
        "price_per_page": _shown(price),
        "estimated_price": _shown(job["pages_total"] * price),
        "price": _shown(job["pages_done"] * price),
        "elements": job["elements"],
        "pages_not_parsed": job.get("engines", {}).get("skipped", []),
        # pages that produced elements (null for jobs from before this was recorded)
        "content_pages": job.get("content_pages"),
        "chunks": job.get("chunks"),
        # "semantic" or "heading" (null for jobs from before this was recorded)
        "chunking": job.get("chunking"),
    }


@app.get("/api/config")
def config() -> dict:
    return {"tiers": [_public_tier(t) for t in TIERS]}


@app.post("/api/jobs")
def create_job(req: JobRequest) -> dict:
    return _public_job(_new_job(req))


def _check_job(req: JobRequest) -> tuple[dict, int, int]:
    """The file's meta and the page range, or 400 if the tier can't parse this file."""
    meta = _read_json(_file_dir(req.file_id) / "meta.json")
    if req.tier not in TIERS:
        raise HTTPException(400, "unknown tier")
    available, reason = _tier_available(req.tier, meta["kind"])
    if not available:
        raise HTTPException(400, f"{TIERS[req.tier]['public']['label']} is not available for {meta['name']}: {reason}")
    first = max(1, req.page_from or 1)
    last = min(meta["pages"], req.page_to or meta["pages"])
    if first > last:
        raise HTTPException(400, f"empty page range for {meta['name']}")
    return meta, first, last


def _new_job(req: JobRequest, batch_id: Optional[str] = None) -> dict:
    meta, first, last = _check_job(req)
    engine = TIERS[req.tier]["engine"]
    job_id = "job-" + uuid.uuid4().hex[:12]
    (JOBS_DIR / job_id).mkdir(parents=True)
    job = {
        "id": job_id,
        "file_id": req.file_id,
        "file_name": meta["name"],
        "tier": req.tier,
        # -- internal (never sent to the client) --
        "strategy": engine["strategy"],
        "model": engine.get("model"),
        "fallback_model": FALLBACK_MODEL if engine.get("model") else None,
        # Fast pipeline: the model that locates tables and figures on each page first, if any
        "layout_model": (_env("BLUESANDAI_LAYOUT_MODEL") or engine["layout_model"]) if engine.get("layout_model") else None,
        "cost": {"primary_usd": 0.0, "fallback_usd": 0.0, "total_usd": 0.0},
        "tokens": {"input": 0, "output": 0, "requests": 0},
        "engines": {"primary": [], "fallback": [], "skipped": []},
        "error_internal": None,
        # -- public --
        "price_per_page_usd": _price(req.tier),
        "languages": req.languages,
        "instructions": req.instructions,
        "page_from": first,
        "page_to": last,
        "pages_total": last - first + 1,
        "pages_done": 0,
        "status": "queued",
        "created_at": _now(),
        "started_at": None,
        "finished_at": None,
        "elements": 0,
        "batch_id": batch_id,
    }
    _write_json(JOBS_DIR / job_id / "job.json", job)
    _db(db.upsert_job, job, job["price_per_page_usd"])
    _queue.put(job_id)
    return job


# Batches: many files parsed with the same tier and settings, one job each (whole documents),
# followed together on one page. A batch is data/batches/<id>.json; its jobs carry batch_id.

BATCHES_DIR = DATA / "batches"


class BatchRequest(BaseModel):
    file_ids: list[str] = Field(min_length=1, max_length=500)
    tier: str = "agentic"
    languages: list[str] = Field(default_factory=lambda: ["ind", "ara"])
    instructions: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=120)


def _batch_path(batch_id: str) -> Path:
    p = BATCHES_DIR / f"{batch_id}.json"
    if not re.fullmatch(r"batch-[0-9a-f]{12}", batch_id) or not p.is_file():
        raise HTTPException(404, "batch not found")
    return p


def _batch_view(batch: dict) -> dict:
    jobs = []
    for job_id in batch["job_ids"]:
        try:
            jobs.append(_public_job(_read_json(JOBS_DIR / job_id / "job.json")))
        except FileNotFoundError:
            pass  # deleted since
    count = lambda *st: sum(1 for j in jobs if j["status"] in st)  # noqa: E731
    return {
        **batch,
        "tier_label": TIERS[batch["tier"]]["public"]["label"] if batch["tier"] in TIERS else batch["tier"],
        "jobs": jobs,
        "totals": {
            "files": len(jobs),
            "completed": count("completed"),
            "active": count("queued", "running"),
            "paused": count("paused", "stopped"),
            "failed": count("failed"),
            "pages_done": sum(j["pages_done"] for j in jobs),
            "pages_total": sum(j["pages_total"] for j in jobs),
            "price": round(sum(j["price"] for j in jobs), 4),
            "estimated_price": round(sum(j["estimated_price"] for j in jobs), 4),
        },
    }


@app.post("/api/batches")
def create_batch(req: BatchRequest) -> dict:
    """Parse many files with one tier: every file is checked first, so a batch starts whole or not at all."""
    reqs = [
        JobRequest(file_id=f, tier=req.tier, languages=req.languages, instructions=req.instructions)
        for f in dict.fromkeys(req.file_ids)
    ]
    problems = []
    for r in reqs:
        try:
            _check_job(r)
        except HTTPException as e:
            problems.append(f"{r.file_id}: {e.detail}" if e.status_code == 404 else str(e.detail))
        except FileNotFoundError:
            problems.append(f"file {r.file_id} not found")
    if problems:
        raise HTTPException(400, f"{len(problems)} of {len(reqs)} files can't be parsed: " + "; ".join(problems[:5]))
    batch_id = "batch-" + uuid.uuid4().hex[:12]
    jobs = [_new_job(r, batch_id) for r in reqs]
    batch = {
        "id": batch_id,
        "name": (req.name or "").strip() or f"{len(jobs)} files · {TIERS[req.tier]['public']['label']}",
        "tier": req.tier,
        "created_at": _now(),
        "job_ids": [j["id"] for j in jobs],
    }
    BATCHES_DIR.mkdir(parents=True, exist_ok=True)
    _write_json(BATCHES_DIR / f"{batch_id}.json", batch)
    return _batch_view(batch)


@app.get("/api/batches")
def list_batches() -> list[dict]:
    if not BATCHES_DIR.is_dir():
        return []
    batches = [_batch_view(_read_json(p)) for p in BATCHES_DIR.glob("batch-*.json")]
    return sorted(batches, key=lambda b: b["created_at"], reverse=True)


@app.get("/api/batches/{batch_id}")
def get_batch(batch_id: str) -> dict:
    return _batch_view(_read_json(_batch_path(batch_id)))


@app.post("/api/batches/{batch_id}/{action}")
def batch_action(batch_id: str, action: Literal["pause", "resume", "finish"]) -> dict:
    """Pause, resume or finish (keep what is parsed) every job of the batch it applies to."""
    batch = _read_json(_batch_path(batch_id))
    for job_id in batch["job_ids"]:
        try:
            if action == "pause":
                pause_job(job_id)
            elif action == "resume":
                resume_job(job_id)
            else:
                stop_job(job_id, StopRequest(keep_partial=True))
        except HTTPException:
            pass  # not applicable to this job's state (e.g. already completed)
    return _batch_view(batch)


def _all_jobs() -> list[dict]:
    jobs = [_read_json(p) for p in JOBS_DIR.glob("*/job.json")]
    return sorted(jobs, key=lambda j: j["created_at"], reverse=True)


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    return [_public_job(j) for j in _all_jobs()]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    return _public_job(_read_json(_job_path(job_id)))


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    job = _read_json(_job_path(job_id))
    if job["status"] in ("queued", "running"):
        raise HTTPException(409, "job is still running")
    if job.get("storage") == "s3" and storage.enabled():
        storage.delete_prefix(f"jobs/{job_id}/")
    vectors.forget_job(job_id)
    shutil.rmtree(JOBS_DIR / job_id)
    _db(db.delete_job, job_id)
    return {"deleted": job_id}


# Pause and Stop. A running job halts between chunks: chunks already sent to an engine finish and
# go to the buffer (_ChunkBuffer), so nothing paid for is lost, and Resume parses only the rest.
# Stop can also turn the pages parsed so far into the job's (partial) result. The buffer is kept
# either way, so starting the same parse again also resumes from it.


@app.post("/api/jobs/{job_id}/pause")
def pause_job(job_id: str) -> dict:
    job = _read_json(_job_path(job_id))
    if job["status"] not in ("queued", "running") or job.get("halt"):
        raise HTTPException(409, f"a {job.get('halt') and 'stopping' or job['status']} job can't be paused")
    with _halts_lock:
        _halts[job_id] = "pause"  # also catches a worker that is just picking the job up
    if job["status"] == "queued":
        return _public_job(_update_job(job_id, status="paused", halted_at=_now()))
    return _public_job(_update_job(job_id, halt="pause"))


@app.post("/api/jobs/{job_id}/resume")
def resume_job(job_id: str) -> dict:
    job = _read_json(_job_path(job_id))
    if job["status"] not in ("paused", "stopped"):
        raise HTTPException(409, f"a {job['status']} job can't be resumed")
    with _halts_lock:
        _halts.pop(job_id, None)
    job = _update_job(job_id, status="queued", halt=None, keep_partial=False, finished_at=None)
    _queue.put(job_id)
    return _public_job(job)


class StopRequest(BaseModel):
    # make the pages parsed so far the job's result (completed, with the rest listed as not parsed)
    keep_partial: bool = False


@app.post("/api/jobs/{job_id}/stop")
def stop_job(job_id: str, req: StopRequest) -> dict:
    job = _read_json(_job_path(job_id))
    status = job["status"]
    if status == "running" and job.get("halt") != "stop":
        with _halts_lock:
            _halts[job_id] = "stop"
        return _public_job(_update_job(job_id, halt="stop", keep_partial=req.keep_partial))
    if status in ("queued", "paused") or (status == "stopped" and req.keep_partial):
        with _halts_lock:
            _halts[job_id] = "stop"
        if not req.keep_partial:
            return _public_job(_update_job(job_id, status="stopped", halt=None, halted_at=_now()))
        # writing the result takes a while (chunking, storage): shown as stopping meanwhile
        job = _update_job(job_id, status="running", halt="stop", keep_partial=True)
        threading.Thread(target=_finish_halt, args=(job_id, "stop"), daemon=True).start()
        return _public_job(job)
    raise HTTPException(409, f"a {status} job can't be stopped")


# Results are served through the API (never as direct storage URLs, which would expose the
# provider and bucket). S3 objects are immutable once a job completes, so reads are cached.
LOCAL_RESULT_FILES = {"json": "result.json", "md": "result.md", "txt": "result.txt", "chunks": "result.chunks.json"}
S3_RESULT_KEYS = {"json": "result.json.gz", "md": "result.md", "txt": "result.txt", "chunks": "chunks.json.gz"}


def _completed_job(job_id: str) -> dict:
    job = _read_json(_job_path(job_id))
    if job["status"] != "completed":
        raise HTTPException(404, "no result yet")
    return job


@functools.lru_cache(maxsize=512)
def _s3_json(key: str) -> Any:
    return storage.get_json(key)


@functools.lru_cache(maxsize=32)
def _s3_text(key: str) -> str:
    return storage.get_text(key)


def _result_json(job: dict, fmt: str) -> Any:
    if job.get("storage") == "s3":
        return _s3_json(f"jobs/{job['id']}/{S3_RESULT_KEYS[fmt]}")
    return _read_json(JOBS_DIR / job["id"] / LOCAL_RESULT_FILES[fmt])


def _result_text(job: dict, fmt: str) -> str:
    if job.get("storage") == "s3":
        return _s3_text(f"jobs/{job['id']}/{S3_RESULT_KEYS[fmt]}")
    return (JOBS_DIR / job["id"] / LOCAL_RESULT_FILES[fmt]).read_text(encoding="utf-8")


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str) -> Response:
    """All elements of a job (the viewer uses /pages/{page} instead; this is for "All pages")."""
    data = _result_json(_completed_job(job_id), "json")
    return Response(json.dumps(data, ensure_ascii=False), media_type="application/json")


@app.get("/api/jobs/{job_id}/pages/{page}")
def job_page(job_id: str, page: int) -> list:
    """Elements of one page: a ~10-20 KB read, so the viewer stays fast for any document size."""
    job = _completed_job(job_id)
    if page not in job.get("content_pages", [page]):
        return []
    if job.get("storage") == "s3":
        try:
            return _s3_json(f"jobs/{job_id}/pages/{page:05d}.json.gz")
        except Exception:
            return []
    return [e for e in _read_json(JOBS_DIR / job_id / "result.json") if e["metadata"].get("page_number") == page]


vectors.configure(_env, _completed_job, lambda job: _result_json(job, "chunks"), lambda job: _result_json(job, "json"), DATA)


@app.get("/api/jobs/{job_id}/chunks")
def job_chunks(job_id: str, page: Optional[int] = None) -> list:
    """The job's RAG chunks (all, or those containing `page`), for showing where text is split."""
    chunks = _result_json(_completed_job(job_id), "chunks")
    out = []
    for c in chunks:
        pages = c["metadata"].get("page_numbers") or []
        if page is not None and page not in pages:
            continue
        out.append(
            {
                "index": c["index"],
                "text": c["text"],
                "markdown": c.get("markdown") or c["text"],
                "page_numbers": pages,
                "languages": c["metadata"].get("languages") or [],
                "element_types": c["metadata"].get("element_types") or [],
                # links the chunk to its elements' boxes, drawn on the page preview
                "element_ids": c["metadata"].get("element_ids") or [],
            }
        )
    return out


def _result_file(job: dict, fmt: str) -> tuple[bytes, str, str]:
    """A completed job's result as a file: (body, media type, file name)."""
    if fmt not in LOCAL_RESULT_FILES:
        raise HTTPException(404, "unknown format")
    stem = Path(job["file_name"]).stem
    if fmt in ("json", "chunks"):
        body = json.dumps(_result_json(job, fmt), ensure_ascii=False, indent=2)
        media, filename = "application/json", f"{stem}.chunks.json" if fmt == "chunks" else f"{stem}.json"
    else:
        body = _result_text(job, fmt)
        media, filename = ("text/markdown" if fmt == "md" else "text/plain"), f"{stem}.{fmt}"
    return body.encode("utf-8"), media, filename


@app.get("/api/jobs/{job_id}/download/{fmt}")
def download_result(job_id: str, fmt: str) -> Response:
    body, media, filename = _result_file(_completed_job(job_id), fmt)
    return Response(
        body,
        media_type=f"{media}; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


class SaveToFilesRequest(BaseModel):
    formats: list[Literal["json", "md", "txt", "chunks"]] = Field(min_length=1)
    # a Files folder id; None is the top level
    parent_id: Optional[str] = None


@app.post("/api/jobs/{job_id}/save-to-files")
def save_result_to_files(job_id: str, req: SaveToFilesRequest) -> list[dict]:
    """Copy a completed job's results into a Files folder (the job keeps its own copy)."""
    job = _completed_job(job_id)
    saved = []
    for fmt in dict.fromkeys(req.formats):
        body, media, filename = _result_file(job, fmt)
        saved.append(drive.save_bytes(req.parent_id, filename, body, f"{media}; charset=utf-8"))
    return saved


def _kg_job_name(job_id: str) -> str:
    if not re.fullmatch(r"job-[0-9a-f]{12}", job_id) or not _job_path(job_id).is_file():
        raise HTTPException(404, "job not found")
    return _completed_job(job_id)["file_name"]


def _kg_job_source(job_id: str) -> tuple[str, list[dict]]:
    """A parse job's file name and public elements, for the Extraction tab (knowledge.py turns
    them into Markdown, page by page, the way result.md is made)."""
    job = _completed_job(job_id)
    return job["file_name"], _result_json(job, "json")


knowledge.configure(DATA, _env, _kg_job_name, _kg_job_source)
pipeline_ai.configure(DATA, _env)
ontology.configure(DATA, _env)
ontology_model.configure()
ontology_actions.configure()
ontology_design.configure()
ontology_scenarios.configure()
ontology_security.configure()
ontology_edits.configure()
ontology_indexing.configure()
vertex.configure()
machinery.configure()
foundry_rules.configure()
dynamic_scheduling.configure()
object_views.configure()
ontology_manage.configure()
object_monitors.configure()
ontology_link_datasets.configure()
ontology_datasources.start_watcher()
workshop.configure(DATA)
code_repos.configure(DATA)
functions_registry.configure(DATA)
ontology_mdo.configure()
media_sets.configure(DATA)
pipeline_runtime.configure(DATA, _env)
streaming.configure(DATA)
stream_datasets.configure()
timeseries.configure(DATA)
ts_derived.configure(DATA)
geospatial.configure(DATA)
dataset_preview.configure(DATA)
iceberg_catalog.configure(DATA)
iceberg_maintenance.configure(DATA)
linter.configure(DATA)
project_references.configure(DATA)
recipes.configure(DATA)
peering.configure(DATA)
fusion.configure(DATA)
forms.configure(DATA)


@app.get("/api/jobs/{job_id}/markdown")
def job_markdown(job_id: str) -> PlainTextResponse:
    return PlainTextResponse(_result_text(_completed_job(job_id), "md"))


@app.get("/api/usage")
def usage() -> dict:
    jobs = list_jobs()
    done = [j for j in jobs if j["status"] == "completed"]
    days: dict[str, dict] = {}
    for j in jobs:
        d = days.setdefault(j["created_at"][:10], {"day": j["created_at"][:10], "pages": 0, "price": 0.0})
        d["pages"] += j["pages_done"]
        d["price"] = round(d["price"] + j["price"], 4)
    return {
        "jobs": len(jobs),
        "completed": len(done),
        "pages": sum(j["pages_done"] for j in done),
        "price": round(sum(j["price"] for j in jobs), 4),
        "by_day": sorted(days.values(), key=lambda d: d["day"]),
    }


# ------------------------------------------------------------------------------------------------
# pipeline builder AI helpers
# ------------------------------------------------------------------------------------------------

PIPELINE_AI_URL = "https://openrouter.ai/api/v1/chat/completions"

DATETIME_FORMAT_PROMPT = """You write Java DateTimeFormatter patterns (as used by Spark and Pipeline Builder).
Return patterns that each parse the WHOLE sample string. Letters: y year, M month (MM number, MMM short name,
MMMM full name), d day, E weekday name, H hour 0-23, h hour 1-12 with a (AM/PM), m minute, s second,
S fraction, Z or XXX offset like +0100 / +01:00 / Z, z or zzzz zone name text. Quote literal text in single
quotes, e.g. 'T' or 'GMT'. Put the pattern that fits most samples first; add another only for samples it
cannot parse (at most 3). If the samples carry no offset and the zone is obvious from the text, give its IANA
name as timezone, otherwise null.
Reply with JSON only: {"formats": ["..."], "timezone": null}"""


class DatetimeFormatRequest(BaseModel):
    samples: list[str] = Field(max_length=50)
    type: Literal["Date", "Timestamp"] = "Timestamp"


@app.post("/api/pipeline/datetime-formats")
def suggest_datetime_formats(req: DatetimeFormatRequest) -> dict:
    """AI suggestion of date formats for a Cast step, from sample values of the column."""
    key = _env("OPENROUTER_API_KEY")
    if not key:
        raise HTTPException(503, "AI suggestions need OPENROUTER_API_KEY in .env.local")
    samples = [s.strip()[:200] for s in req.samples if s and s.strip()][:20]
    if not samples:
        raise HTTPException(400, "no sample values to look at")
    model = _env("BLUESANDAI_PIPELINE_AI_MODEL") or FALLBACK_MODEL
    try:
        resp = requests.post(
            PIPELINE_AI_URL,
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": DATETIME_FORMAT_PROMPT},
                    {"role": "user", "content": f"Target type: {req.type}\nSamples:\n" + "\n".join(samples)},
                ],
            },
            timeout=60,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        found = re.search(r"\{.*\}", content, re.S)
        data = json.loads(found.group(0) if found else content)
    except (requests.RequestException, ValueError, KeyError, IndexError) as e:
        log.warning("datetime format suggestion failed: %s", e)
        raise HTTPException(502, "the AI model did not return a usable answer") from e
    formats = [f for f in data.get("formats") or [] if isinstance(f, str) and f.strip()][:3]
    tz = data.get("timezone")
    return {"formats": formats, "timezone": tz if isinstance(tz, str) and tz else None}


# ------------------------------------------------------------------------------------------------
# worker
# ------------------------------------------------------------------------------------------------


def _usage_snapshot() -> tuple[dict, dict, int]:
    return dict(bs.USAGE), dict(bs.OPENROUTER_USAGE), len(bs.BLOCKED_PAGES)


def _public_elements(elements: list[dict]) -> list[dict]:
    out = []
    for e in elements:
        e = {**e, "metadata": {k: v for k, v in e["metadata"].items() if k not in INTERNAL_METADATA}}
        out.append(e)
    return out


_halts: dict[str, str] = {}  # job id -> "pause" | "stop", asked for while it runs
_halts_lock = threading.Lock()


class _Halted(Exception):
    """Raised inside a run when Pause or Stop was asked for; the worker records it."""

    def __init__(self, kind: str) -> None:
        super().__init__(f"halted: {kind}")
        self.kind = kind


def _halt_requested(job_id: str) -> Optional[str]:
    with _halts_lock:
        return _halts.get(job_id)


def _finish_halt(job_id: str, kind: str) -> None:
    """Record a halted run: paused, stopped, or (Stop with keep_partial) completed from the buffer."""
    with _halts_lock:
        _halts.pop(job_id, None)
    job = _read_json(_job_path(job_id))
    if kind == "stop" and job.get("keep_partial"):
        try:
            if _finish_partial(job):
                return
        except Exception as e:
            log.exception("could not make a partial result for %s", job_id)
            _update_job(job_id, error_internal=f"partial result: {type(e).__name__}: {e}"[:4000])
    _update_job(job_id, status="paused" if kind == "pause" else "stopped", halt=None, halted_at=_now())


def _finish_partial(job: dict) -> bool:
    """Complete a stopped job with the chunks in its buffer: their pages are the result, the
    pages not reached are listed as not parsed. The buffer is kept, so running the same parse
    again still resumes from it. False when nothing was parsed yet."""
    saved = _ChunkBuffer(job).load()
    pages = range(job["page_from"], job["page_to"] + 1)
    done = {p for first, last in saved for p in range(first, last + 1)} & set(pages)
    if not done:
        return False
    elements = [e for key in sorted(saved) for e in saved[key]]
    _update_job(job["id"], pages_done=len(done), partial=True, halt=None, keep_partial=False)
    _finish_job(
        job["id"], elements,
        {"primary": sorted(done), "fallback": [], "skipped": [p for p in pages if p not in done]},
    )
    return True


def _run_job(job_id: str) -> None:
    job = _update_job(job_id, status="running", started_at=_now(), pages_done=0)
    meta = _read_json(FILES_DIR / job["file_id"] / "meta.json")
    src = FILES_DIR / job["file_id"] / meta["stored_name"]
    agentic = job["strategy"].startswith("bluesandai")
    g0, o0, b0 = _usage_snapshot()
    elements: list[dict] = []
    kwargs: dict[str, Any] = {
        "strategy": job["strategy"],
        "languages": job["languages"] or None,
        "metadata_filename": meta["name"],
    }
    if agentic:
        kwargs.update(
            bluesandai_model=job["model"],
            bluesandai_fallback_strategy=f"openrouter:{job['fallback_model']}",
            bluesandai_instructions=job["instructions"] or None,
        )
    else:
        # the text layer carries no language labels: detect per element so Arabic renders RTL
        # (an explicit language list would be copied onto every element instead of detected)
        kwargs.update(languages=["auto"], detect_language_per_element=True, **PDFMINER_LAYOUT)

    if job["strategy"] == "mineru":
        _run_mineru_job(job, meta, src)
        return
    if job["strategy"] == "docling":
        _run_docling_job(job, meta, src)
        return
    if job["strategy"] == "paddleocr":
        _run_runpod_ocr_job(
            job, meta, src, "PADDLEOCR", "paddleocr-vl-runpod", PADDLEOCR_RUNPOD_PARALLEL, PADDLEOCR_RUNPOD_COST_PER_SECOND
        )
        return
    if job["strategy"] == "glmocr":
        _run_runpod_ocr_job(
            job, meta, src, "GLMOCR", "glm-ocr-runpod", GLMOCR_RUNPOD_PARALLEL, GLMOCR_RUNPOD_COST_PER_SECOND
        )
        return
    if job["strategy"] == "unstructured_api":
        _run_unstructured_job(job, meta, src)
        return
    if job["strategy"] == "fast" and _env("FAST_WORKER_URL") and _env("FAST_WORKER_TOKEN"):
        _run_fast_remote_job(job, meta, src)
        return

    def record_progress(pages_done: int) -> None:
        g, o, _ = _usage_snapshot()
        price_in, price_out = GEMINI_PRICES.get(job["model"] or "", (0.0, 0.0))
        primary = (g["input_tokens"] - g0["input_tokens"]) / 1e6 * price_in + (
            g["output_tokens"] - g0["output_tokens"]
        ) / 1e6 * price_out
        fallback = o["cost_usd"] - o0["cost_usd"]
        _update_job(
            job_id,
            pages_done=pages_done,
            elements=len(elements),
            cost={
                "primary_usd": round(primary, 5),
                "fallback_usd": round(fallback, 5),
                "total_usd": round(primary + fallback, 5),
            },
            tokens={
                "input": g["input_tokens"] - g0["input_tokens"] + o["input_tokens"] - o0["input_tokens"],
                "output": g["output_tokens"] - g0["output_tokens"] + o["output_tokens"] - o0["output_tokens"],
                "requests": g["requests"] - g0["requests"] + o["requests"] - o0["requests"],
            },
        )

    if meta["kind"] == "image":
        elements.extend(elements_to_dicts(partition_image(filename=str(src), **kwargs)))
        record_progress(job["pages_total"])
    else:
        # each chunk goes to the buffer, so Pause, Stop, a failure or a restart lose nothing
        first = job["page_from"]
        buffer = _ChunkBuffer(job)
        saved = buffer.load()
        for start, end, data in _pdf_chunks(src, first, job["page_to"]):
            if (start, end) in saved:
                elements.extend(saved[(start, end)])
                record_progress(end - first + 1)
                continue
            kind = _halt_requested(job_id)
            if kind:
                raise _Halted(kind)
            with tempfile.TemporaryDirectory() as tmp:
                chunk = Path(tmp) / "chunk.pdf"
                chunk.write_bytes(data)
                els = partition_pdf(filename=str(chunk), starting_page_number=start, **kwargs)
            new = elements_to_dicts(els)
            elements.extend(new)
            buffer.save(start, end, new)
            record_progress(end - first + 1)

    # -- which engine handled each page (internal report) --
    blocked = {p for p, _, _ in bs.BLOCKED_PAGES[b0:]} if agentic else set()
    by_page: dict[int, set] = {}
    for e in elements:
        by_page.setdefault(e["metadata"]["page_number"], set()).add(
            "fallback" if e["metadata"].get("bluesandai_fallback") else "primary"
        )
    pages = range(job["page_from"], job["page_to"] + 1)
    engines = {
        "primary": [p for p in pages if by_page.get(p) == {"primary"} and p not in blocked],
        "fallback": [p for p in pages if "fallback" in by_page.get(p, set())],
        # only pages a model was asked about and refused/failed; blank pages are not "not parsed"
        "skipped": sorted(p for p in blocked if p not in by_page),
    }

    if job["strategy"] == "fast" and meta["kind"] == "pdf":
        elements = _fast_vision(job, src, elements)
    _finish_job(job_id, elements, engines, semantic_split=job.get("strategy") == "fast")
    if meta["kind"] != "image":
        buffer.clear()


_BLANK_IMAGE = zlib.compress(b"\xff")


def _strip_images(pdf: pikepdf.Pdf) -> None:
    """Replace every image XObject (including ones nested in form XObjects) with a 1x1 pixel,
    keeping all references valid. For text-layer extraction the images are dead weight."""
    seen: set[tuple[int, int]] = set()

    def walk(resources: Any) -> None:
        xobjects = resources.get("/XObject") if resources is not None else None
        if xobjects is None:
            return
        for name in list(xobjects.keys()):
            x = xobjects[name]
            key = x.objgen
            if key in seen and key != (0, 0):
                continue
            seen.add(key)
            subtype = x.get("/Subtype")
            if subtype == "/Image":
                xobjects[name] = pikepdf.Stream(
                    pdf,
                    _BLANK_IMAGE,
                    Type=pikepdf.Name.XObject,
                    Subtype=pikepdf.Name.Image,
                    Width=1,
                    Height=1,
                    ColorSpace=pikepdf.Name.DeviceGray,
                    BitsPerComponent=8,
                    Filter=pikepdf.Name.FlateDecode,
                )
            elif subtype == "/Form":
                walk(x.get("/Resources"))

    for page in pdf.pages:
        walk(page.obj.get("/Resources"))


def _pdf_chunks(
    src: Path, first: int, last: int, strip_images: bool = False, pages_per_chunk: int = CHUNK_PAGES
) -> list[tuple[int, int, bytes]]:
    """Split pages first..last into pages_per_chunk-page PDFs. Uses qpdf (pikepdf): fast, and robust on
    the damaged PDFs real users upload (pypdf took ~1 s/page or hung on such files)."""
    chunks = []
    with pikepdf.open(src) as pdf:
        for start in range(first, last + 1, pages_per_chunk):
            end = min(start + pages_per_chunk - 1, last)
            out = pikepdf.new()
            out.pages.extend(pdf.pages[start - 1 : end])
            if strip_images:
                _strip_images(out)
            buf = io.BytesIO()
            out.save(buf)
            chunks.append((start, end, buf.getvalue()))
    return chunks


class _ChunkBuffer:
    """Where a parse run keeps each finished chunk until the job completes: Files, under
    My Project / Parsed Document / Buffer / <file · tier · pages · settings>, or data/buffer/ when
    Files (PostgreSQL) is unavailable. A job that fails, or is re-queued by an API restart, resumes
    from it; so does a new job for the same file, tier, pages and settings. Buffer problems are
    logged and never fail a job."""

    def __init__(self, job: dict) -> None:
        settings = [job["file_id"], job["tier"], job.get("strategy"), job["page_from"], job["page_to"],
                    job.get("languages"), job.get("instructions")]
        key = hashlib.sha1(json.dumps(settings, ensure_ascii=False).encode()).hexdigest()[:8]
        self.name = f"{Path(job['file_name']).stem[:80]} · {job['tier']} · pages {job['page_from']}-{job['page_to']} · {key}"
        self.folder_id: Optional[str] = None
        self.local = DATA / "buffer" / f"{job['file_id']}-{key}"
        if db.enabled():
            try:
                self.folder_id = drive.find_buffer_run_folder(self.name)
            except Exception:
                log.exception("buffer for %s unavailable in Files; using %s", job["id"], self.local)

    def load(self) -> dict[tuple[int, int], list[dict]]:
        """Chunks already parsed, by (first page, last page)."""
        out: dict[tuple[int, int], list[dict]] = {}
        try:
            if self.folder_id:
                files = [(i["name"], lambda i=i: drive.read_bytes(i)) for i in drive.list_files(self.folder_id)]
            else:
                files = [(f.name, f.read_bytes) for f in self.local.glob("pages *.json")] if self.local.is_dir() else []
            for name, read in files:
                m = re.match(r"pages (\d+)-(\d+)", name)
                if m:
                    out[(int(m.group(1)), int(m.group(2)))] = json.loads(read())["elements"]
        except Exception:
            log.exception("could not read the buffer %s", self.name)
        return out

    def save(self, start: int, end: int, elements: list[dict]) -> None:
        name = f"pages {start:05d}-{end:05d}.json"
        body = json.dumps({"first_page": start, "last_page": end, "elements": _public_elements(elements)},
                          ensure_ascii=False).encode("utf-8")
        try:
            if db.enabled():
                if not self.folder_id:
                    self.folder_id = drive.buffer_run_folder(self.name)
                drive.save_bytes(self.folder_id, name, body, "application/json")
                return
        except Exception:
            log.exception("could not save %s to the Files buffer; keeping it on disk", name)
        try:
            self.local.mkdir(parents=True, exist_ok=True)
            (self.local / name).write_bytes(body)
        except Exception:
            log.exception("could not buffer %s on disk", name)

    def clear(self) -> None:
        """Drop the buffer once the job's results are stored (they are in Parsed Document then)."""
        try:
            if self.folder_id:
                drive.delete_tree(self.folder_id)
            shutil.rmtree(self.local, ignore_errors=True)
        except Exception:
            log.exception("could not clear the buffer %s", self.name)


def _run_parts(
    job: dict,
    parts: list[tuple],
    post: Any,
    parallel: int,
    cost: Optional[Any] = None,
) -> tuple[list[dict], "_ChunkBuffer"]:
    """Send a job's chunks (tuples starting with first page, last page) through `post`,
    `parallel` at a time, saving each finished chunk to the buffer and skipping chunks already
    there. `post(part)` returns elements, or (elements, billed seconds); `cost(seconds, pages)` is
    our cost in USD of the chunks parsed in this run. If chunks fail, the others still finish and
    are buffered before the job fails. Returns all elements in page order, and the buffer."""
    buffer = _ChunkBuffer(job)
    saved = buffer.load()
    results = {p[0]: saved[(p[0], p[1])] for p in parts if (p[0], p[1]) in saved}
    todo = [p for p in parts if p[0] not in results]
    state = {"pages": sum(p[1] - p[0] + 1 for p in parts if p[0] in results), "new_pages": 0, "seconds": 0.0}

    def progress() -> None:
        changes: dict[str, Any] = {
            "pages_done": min(state["pages"], job["pages_total"]),
            "elements": sum(len(v) for v in results.values()),
        }
        if cost:
            usd = round(cost(state["seconds"], state["new_pages"]), 5)
            changes["cost"] = {"primary_usd": usd, "fallback_usd": 0.0, "total_usd": usd}
        _update_job(job["id"], **changes)

    if results:
        log.warning("job %s resumes: %d of %d chunks are in the buffer", job["id"], len(results), len(parts))
        _update_job(job["id"], resumed_chunks=len(results))  # internal
        progress()
    errors: list[Exception] = []

    def guarded(part: tuple) -> Any:
        # after Pause or Stop, chunks not yet sent aren't; those already sent finish and are buffered
        kind = _halt_requested(job["id"])
        if kind:
            raise _Halted(kind)
        return post(part)

    with ThreadPoolExecutor(max_workers=max(1, int(parallel))) as pool:
        futures = {pool.submit(guarded, p): p for p in todo}
        for future in as_completed(futures):
            start, end = futures[future][0], futures[future][1]
            try:
                value = future.result()
            except _Halted:
                continue
            except Exception as e:
                errors.append(e)
                continue
            elements, seconds = value if isinstance(value, tuple) else (value, 0.0)
            results[start] = elements
            buffer.save(start, end, elements)
            state["pages"] += end - start + 1
            state["new_pages"] += end - start + 1
            state["seconds"] += seconds
            progress()
    kind = _halt_requested(job["id"])
    if kind and len(results) < len(parts):
        raise _Halted(kind)
    if errors:
        raise RuntimeError(
            f"{len(errors)} of {len(todo)} chunks failed ({len(results)} of {len(parts)} are kept in the buffer, "
            f"so a retry only parses the rest): {errors[0]}"
        ) from errors[0]
    return [e for start in sorted(results) for e in results[start]], buffer


def _run_fast_remote_job(job: dict, meta: dict, src: Path) -> None:
    """Fast tier on the Cloud Run worker: each 10-page chunk is its own request, sent in
    parallel, so Cloud Run scales instances with load instead of this process doing the work."""
    url, token = _env("FAST_WORKER_URL").rstrip("/") + "/parse", _env("FAST_WORKER_TOKEN")
    # Fast reads only the text layer: dropping images keeps chunks far below Cloud Run's 32 MiB
    # request limit (image-heavy PDFs can be several MB per page) and speeds up the upload
    chunks = _pdf_chunks(src, job["page_from"], job["page_to"], strip_images=True)

    def post(chunk: tuple[int, int, bytes]) -> list[dict]:
        start, _, data = chunk
        error = ""
        for attempt in range(3):
            try:
                resp = requests.post(
                    url,
                    headers={"X-Worker-Token": token},
                    files={"file": ("chunk.pdf", data, "application/pdf")},
                    data={"first_page": str(start), "filename": meta["name"]},
                    timeout=300,
                )
                if resp.status_code == 200:
                    return resp.json()["elements"]
                error = f"HTTP {resp.status_code}: {resp.text[:300]}"
                if resp.status_code not in (429, 500, 502, 503, 504):
                    break
            except requests.RequestException as e:
                error = repr(e)
            time.sleep(2 ** attempt)
        raise RuntimeError(f"fast worker failed on pages starting {start}: {error}")

    parsed, buffer = _run_parts(job, chunks, post, FAST_WORKER_PARALLEL)
    elements = _fast_vision(job, src, parsed)
    pages = list(range(job["page_from"], job["page_to"] + 1))
    _finish_job(job["id"], elements, {"primary": pages, "fallback": [], "skipped": []}, semantic_split=True)
    buffer.clear()


def _fast_vision(job: dict, src: Path, elements: list[dict]) -> list[dict]:
    """Fast and Cost Effective tiers: tables and images through a small vision model
    (vision_parser.py), located on each page first when the job has a layout_model, with the text
    layer's other elements left as they are. Any failure keeps the text-only result."""
    if not vision_parser.enabled(_env):
        return elements
    key, model = _env("OPENROUTER_API_KEY"), _env("BLUESANDAI_VISION_MODEL") or vision_parser.DEFAULT_MODEL
    detect = job.get("layout_model") or ""
    try:
        if _env("FAST_WORKER_URL") and _env("FAST_WORKER_TOKEN"):
            elements, stats = _fast_vision_remote(job, src, elements, key, model, detect)
        else:
            elements, stats = vision_parser.enrich(src, elements, key, model, detect_model=detect)
    except Exception:
        log.exception("vision for job %s failed: keeping the text-only result", job["id"])
        return elements
    cost = dict(_read_json(_job_path(job["id"])).get("cost") or {"primary_usd": 0.0, "fallback_usd": 0.0})
    cost["vision_usd"] = stats["cost_usd"]
    cost["total_usd"] = round(cost.get("primary_usd", 0.0) + cost.get("fallback_usd", 0.0) + stats["cost_usd"], 6)
    _update_job(job["id"], vision=stats, cost=cost)
    return elements


def _fast_vision_remote(
    job: dict, src: Path, elements: list[dict], key: str, model: str, detect: str
) -> tuple[list[dict], dict]:
    """The vision step on the Fast worker's /vision: one request per 10-page chunk (images kept,
    page by page when a chunk is over Cloud Run's request limit), FAST_WORKER_PARALLEL at a time, so
    Cloud Run adds instances with load. A chunk the worker fails is done here instead."""
    url, token = _env("FAST_WORKER_URL").rstrip("/") + "/vision", _env("FAST_WORKER_TOKEN")
    # image descriptions are written in the whole document's language, not a chunk's
    language_name = vision_parser._main_language(elements)
    parts = [(start, end, data) for start, end, data, _ in _sized_pdf_chunks(src, job["page_from"], job["page_to"])]

    def run(part: tuple[int, int, bytes]) -> tuple[list[dict], dict]:
        start, end, data = part
        els = [e for e in elements if start <= (e["metadata"].get("page_number") or 0) <= end]
        if not els:
            return els, {}
        error = ""
        for attempt in range(3):
            try:
                resp = requests.post(
                    url,
                    headers={"X-Worker-Token": token, "X-OpenRouter-Key": key},
                    files={"file": ("chunk.pdf", data, "application/pdf")},
                    data={"elements": json.dumps(els, ensure_ascii=False), "first_page": str(start),
                          "model": model, "detect_model": detect, "language": language_name},
                    timeout=900,
                )
                if resp.status_code == 200:
                    body = resp.json()
                    return body["elements"], body["stats"]
                error = f"HTTP {resp.status_code}: {resp.text[:300]}"
                if resp.status_code not in (429, 500, 502, 503, 504):
                    break
            except requests.RequestException as e:
                error = repr(e)
            time.sleep(2**attempt)
        log.warning("fast worker /vision failed on pages %s-%s (%s): running them here", start, end, error)
        with tempfile.TemporaryDirectory() as tmp:
            chunk = Path(tmp) / "chunk.pdf"
            chunk.write_bytes(data)
            return vision_parser.enrich(chunk, els, key, model, detect_model=detect, first_page=start, language=language_name)

    with ThreadPoolExecutor(max_workers=FAST_WORKER_PARALLEL) as pool:
        results = list(pool.map(run, parts))
    stats: dict[str, Any] = {}
    for _, s in results:
        for k, v in s.items():
            stats[k] = stats.get(k, 0) + v
    stats["cost_usd"] = round(stats.get("cost_usd", 0.0), 6)
    return [e for els, _ in results for e in els], stats


def _sized_pdf_chunks(src: Path, first: int, last: int, limit: int = 30 * 1024 * 1024) -> list[tuple[int, int, bytes, str]]:
    """10-page PDF chunks with their images, a chunk over Cloud Run's request limit page by page."""
    parts = []
    for start, end, data in _pdf_chunks(src, first, last):
        if len(data) <= limit or start == end:
            parts.append((start, end, data, ".pdf"))
        else:
            parts.extend((p, p, d, ".pdf") for p, _, d in _pdf_chunks(src, start, end, pages_per_chunk=1))
    return parts


def _run_unstructured_job(job: dict, meta: dict, src: Path) -> None:
    """Unstructured tier: the Unstructured Transform API, one async job per 10-page chunk (or the
    image), UNSTRUCTURED_PARALLEL at a time."""
    s = unstructured_cloud.settings(_env)
    cost_per_page = float(_env("UNSTRUCTURED_COST_PER_PAGE_USD") or UNSTRUCTURED_COST_PER_PAGE)
    if meta["kind"] == "image":
        data, suffix = src.read_bytes(), src.suffix.lower()
        if suffix not in UNSTRUCTURED_IMAGE_SUFFIXES:  # e.g. .webp: not accepted by the service
            buf = io.BytesIO()
            with Image.open(src) as im:
                im.convert("RGB").save(buf, format="PNG")
            data, suffix = buf.getvalue(), ".png"
        parts = [(1, meta["pages"], data, suffix)]
    else:
        parts = [(a, b, d, ".pdf") for a, b, d in _pdf_chunks(src, job["page_from"], job["page_to"])]

    def post(part: tuple[int, int, bytes, str]) -> list[dict]:
        start, _, data, suffix = part
        return unstructured_cloud.process(s, data, suffix, start, meta["name"])

    elements, buffer = _run_parts(
        job, parts, post, int(_env("UNSTRUCTURED_PARALLEL") or UNSTRUCTURED_PARALLEL),
        cost=lambda seconds, pages: min(pages, job["pages_total"]) * cost_per_page,
    )
    _label_languages(elements)
    pages = list(range(job["page_from"], job["page_to"] + 1))
    _finish_job(job["id"], elements, {"primary": pages, "fallback": [], "skipped": []})
    buffer.clear()


def _mineru_parts(src: Path, meta: dict, first: int, last: int) -> list[tuple[int, int, bytes, str]]:
    """What to send to the MinerU worker: 10-page PDF chunks, a chunk over Cloud Run's request
    limit page by page (scans keep their images, unlike Fast), or an image file as is."""
    if meta["kind"] == "image":
        return [(1, meta["pages"], src.read_bytes(), src.suffix.lower())]
    parts = _sized_pdf_chunks(src, first, last, MINERU_MAX_CHUNK_BYTES)
    for start, _, data, _ in parts:
        if len(data) > MINERU_MAX_CHUNK_BYTES:
            raise RuntimeError(f"page {start} is {len(data) // 2**20} MB, over the worker's request limit")
    return parts


def _mineru_worker(pages: int) -> dict:
    """Which MinerU worker a Precision job of `pages` pages runs on: the Cloud Run CPU worker for
    small jobs (when configured), else the Runpod endpoint (when configured), else Cloud Run's L4."""
    if pages < MINERU_CPU_MAX_PAGES and _env("MINERU_CPU_WORKER_URL"):
        return {
            "device": "cpu",
            "url": _env("MINERU_CPU_WORKER_URL"),
            "parallel": int(_env("MINERU_CPU_WORKER_PARALLEL") or MINERU_CPU_WORKER_PARALLEL),
            "cost_per_second": float(_env("MINERU_CPU_COST_PER_SECOND_USD") or MINERU_CPU_COST_PER_SECOND),
        }
    if _env("MINERU_RUNPOD_ENDPOINT_ID") and _env("RUNPOD_API_KEY"):
        return {
            "device": "runpod",
            "endpoint_id": _env("MINERU_RUNPOD_ENDPOINT_ID"),
            "parallel": int(_env("MINERU_RUNPOD_PARALLEL") or MINERU_RUNPOD_PARALLEL),
            "cost_per_second": float(_env("MINERU_RUNPOD_COST_PER_SECOND_USD") or MINERU_RUNPOD_COST_PER_SECOND),
        }
    return {
        "device": "gpu",
        "url": _env("MINERU_WORKER_URL"),
        "parallel": int(_env("MINERU_WORKER_PARALLEL") or MINERU_WORKER_PARALLEL),
        "cost_per_second": float(_env("MINERU_COST_PER_SECOND_USD") or MINERU_COST_PER_SECOND),
    }


def _run_mineru_job(job: dict, meta: dict, src: Path) -> None:
    """Precision tier: MinerU on Cloud Run, on the CPU worker for small jobs and the L4 worker
    otherwise (_mineru_worker). Each chunk is its own request, `parallel` at a time; Cloud Run
    starts an instance per concurrent chunk."""
    worker = _mineru_worker(job["pages_total"])
    _update_job(job["id"], model=f"mineru-{worker['device']}")  # internal: which worker ran it
    url, token = (worker.get("url") or "").rstrip("/") + "/parse", _env("MINERU_WORKER_TOKEN")
    parallel, cost_per_second = worker["parallel"], worker["cost_per_second"]
    parts = _mineru_parts(src, meta, job["page_from"], job["page_to"])

    def post(part: tuple[int, int, bytes, str]) -> tuple[list[dict], float]:
        start, _, data, suffix = part
        if worker["device"] == "runpod":
            return _runpod_parse(worker["endpoint_id"], job["id"], start, data, suffix, meta["name"])
        error = ""
        for attempt in range(4):
            try:
                resp = requests.post(
                    url,
                    headers={"X-Worker-Token": token},
                    files={"file": (f"chunk{suffix}", data, "application/octet-stream")},
                    data={"first_page": str(start), "filename": meta["name"], "suffix": suffix},
                    timeout=MINERU_WORKER_TIMEOUT,
                )
                if resp.status_code == 200:
                    body = resp.json()
                    return body["elements"], body.get("seconds", 0.0)
                error = f"HTTP {resp.status_code}: {resp.text[:300]}"
                # 429: every instance is busy or the GPU quota is used up; wait for one to free up
                if resp.status_code not in (429, 500, 502, 503, 504):
                    break
            except requests.RequestException as e:
                error = repr(e)
            time.sleep(min(60, 5 * 2**attempt))
        raise RuntimeError(f"MinerU worker failed on pages starting {start}: {error}")

    # parse time only: cold starts and idle time before scale-down are billed on top
    elements, buffer = _run_parts(job, parts, post, parallel, cost=lambda seconds, pages: seconds * cost_per_second)
    _label_languages(elements)
    pages = list(range(job["page_from"], job["page_to"] + 1))
    _finish_job(job["id"], elements, {"primary": pages, "fallback": [], "skipped": []})
    buffer.clear()


def _run_runpod_ocr_job(
    job: dict, meta: dict, src: Path, prefix: str, model: str, parallel: int, cost_per_second: float
) -> None:
    """PaddleOCR-VL and GLM-OCR tiers: the worker on its Runpod endpoint, one chunk per Runpod job,
    `parallel` at a time. Same chunks as Precision (10-page PDF chunks, or the image as is).
    `prefix` names the .env.local settings (<prefix>_RUNPOD_ENDPOINT_ID, and _RUNPOD_PARALLEL and
    _RUNPOD_COST_PER_SECOND_USD to override `parallel` and `cost_per_second`)."""
    endpoint_id = _env(f"{prefix}_RUNPOD_ENDPOINT_ID")
    parallel = int(_env(f"{prefix}_RUNPOD_PARALLEL") or parallel)
    cost_per_second = float(_env(f"{prefix}_RUNPOD_COST_PER_SECOND_USD") or cost_per_second)
    _update_job(job["id"], model=model)  # internal: which worker ran it
    parts = _mineru_parts(src, meta, job["page_from"], job["page_to"])

    def post(part: tuple[int, int, bytes, str]) -> tuple[list[dict], float]:
        start, _, data, suffix = part
        return _runpod_parse(endpoint_id, job["id"], start, data, suffix, meta["name"])

    # Runpod's billed execution time; cold starts and the idle timeout are billed on top
    elements, buffer = _run_parts(job, parts, post, parallel, cost=lambda seconds, pages: seconds * cost_per_second)
    _label_languages(elements)
    pages = list(range(job["page_from"], job["page_to"] + 1))
    _finish_job(job["id"], elements, {"primary": pages, "fallback": [], "skipped": []})
    buffer.clear()


def _runpod_parse(
    endpoint_id: str,
    job_id: str,
    start: int,
    data: bytes,
    suffix: str,
    filename: str,
    extra: Optional[dict] = None,
) -> tuple[list[dict], float]:
    """One chunk on a Runpod endpoint (mineru-, docling-, paddleocr- or glmocr-worker/runpod_handler.py):
    queue it with /run and poll /status. `extra` adds worker-specific input (Docling: languages). Returns the
    elements and the seconds Runpod billed for running it."""
    import base64

    base = f"https://api.runpod.ai/v2/{endpoint_id}"
    headers = {"Authorization": f"Bearer {_env('RUNPOD_API_KEY')}"}
    payload: dict[str, Any] = {"first_page": start, "filename": filename, "suffix": suffix, **(extra or {})}
    s3_key = None
    if len(data) <= RUNPOD_MAX_INLINE_BYTES:
        payload["file_b64"] = base64.b64encode(data).decode()
    elif storage.enabled():
        # over Runpod's 10 MB request limit once base64-encoded: hand the worker a temporary link
        s3_key = f"tmp/runpod/{job_id}/{start:05d}{suffix}"
        storage.put_fileobj(s3_key, io.BytesIO(data), "application/octet-stream")
        payload["file_url"] = storage.presigned_url(s3_key, f"chunk{suffix}", expires=RUNPOD_JOB_TIMEOUT)
    else:
        raise RuntimeError(f"pages starting {start}: {len(data) // 2**20} MB chunk needs S3 to reach Runpod")

    def call(method: str, path: str, **kwargs: Any) -> dict:
        for attempt in range(5):
            try:
                resp = requests.request(method, base + path, headers=headers, timeout=60, **kwargs)
                if resp.status_code == 200:
                    return resp.json()
                if resp.status_code not in (429, 500, 502, 503, 504):
                    raise RuntimeError(f"Runpod {path} HTTP {resp.status_code}: {resp.text[:300]}")
            except requests.RequestException:
                pass
            time.sleep(min(30, 2 * 2**attempt))
        raise RuntimeError(f"Runpod {path} kept failing")

    try:
        # executionTimeout: a chunk that runs away (e.g. a looping VLM) is stopped and not billed on
        run = call("POST", "/run", json={"input": payload, "policy": {"executionTimeout": RUNPOD_JOB_TIMEOUT * 1000}})
        deadline = time.monotonic() + RUNPOD_JOB_TIMEOUT + 1800  # plus time waiting in the queue
        status = run
        while status.get("status") not in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
            if time.monotonic() > deadline:
                call("POST", f"/cancel/{run['id']}")
                raise RuntimeError(f"Runpod job for pages starting {start} did not finish in time")
            time.sleep(3)
            status = call("GET", f"/status/{run['id']}")
    finally:
        if s3_key:
            try:
                storage.delete_keys([s3_key])
            except Exception:
                log.exception("could not delete %s", s3_key)
    output = status.get("output") or {}
    if status["status"] != "COMPLETED" or "elements" not in output:
        detail = output.get("error") if isinstance(output, dict) else None
        raise RuntimeError(f"Runpod job for pages starting {start} {status['status']}: {detail or status.get('error')}")
    return output["elements"], (status.get("executionTime") or 0) / 1000


_docling_gpu_last_used = 0.0  # time.monotonic() of the last GPU chunk


def _ocr_share(src: Path, meta: dict, first: int, last: int) -> float:
    """Share of pages Docling will OCR, from up to 40 sampled pages: those with an image covering
    ≥5% of the page (Docling's bitmap threshold). A text layer doesn't matter: scans often carry a
    hidden OCR layer and are OCR'd anyway, and so are figures in digital PDFs."""
    if meta["kind"] != "pdf":
        return 1.0
    pages = list(range(first, last + 1))
    sample = pages[:: max(1, len(pages) // 40)]
    doc = pdfium.PdfDocument(str(src))
    try:
        ocr = 0
        for p in sample:
            page = doc[p - 1]
            area = page.get_width() * page.get_height() or 1.0
            for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE], max_depth=3):
                left, bottom, right, top = obj.get_bounds()
                if (right - left) * (top - bottom) >= 0.05 * area:
                    ocr += 1
                    break
    finally:
        doc.close()
    return ocr / len(sample)


def _docling_use_gpu(job: dict, meta: dict, src: Path) -> bool:
    """GPU for scans, for big work (this job plus the Layout jobs queued behind it, which run back
    to back and share one scale-down) and while the GPU is still warm; otherwise the CPU worker."""
    if not _env("DOCLING_CPU_WORKER_URL"):
        return True
    if time.monotonic() - _docling_gpu_last_used < float(_env("DOCLING_GPU_WARM_SECONDS") or DOCLING_GPU_WARM_SECONDS):
        return True
    ocr = _ocr_share(src, meta, job["page_from"], job["page_to"])
    if ocr >= float(_env("DOCLING_GPU_OCR_SHARE") or DOCLING_GPU_OCR_SHARE):
        return True
    queued = sum(
        j["pages_total"] for j in _all_jobs() if j["status"] == "queued" and j.get("strategy") == "docling"
    )
    return job["pages_total"] + queued >= int(_env("DOCLING_GPU_MIN_PAGES") or DOCLING_GPU_MIN_PAGES)


def _run_docling_job(job: dict, meta: dict, src: Path) -> None:
    """Layout tier: Docling on the GPU or CPU worker (_docling_use_gpu), chunks sent in parallel.
    The worker reads text layers directly and OCRs only scanned pages and images."""
    global _docling_gpu_last_used
    # Runpod bills only while a chunk runs (plus a 30 s idle timeout), so with an endpoint
    # configured every job goes there and the Cloud Run GPU/CPU split below isn't needed
    runpod_endpoint = _env("DOCLING_RUNPOD_ENDPOINT_ID") if _env("RUNPOD_API_KEY") else ""
    gpu = bool(runpod_endpoint) or _docling_use_gpu(job, meta, src)
    if runpod_endpoint:
        url, parallel = "", _env("DOCLING_RUNPOD_PARALLEL") or DOCLING_RUNPOD_PARALLEL
        cost_per_second = float(_env("DOCLING_RUNPOD_COST_PER_SECOND_USD") or DOCLING_RUNPOD_COST_PER_SECOND)
    elif gpu:
        url, parallel = _env("DOCLING_WORKER_URL"), _env("DOCLING_WORKER_PARALLEL") or DOCLING_WORKER_PARALLEL
        cost_per_second = float(_env("DOCLING_COST_PER_SECOND_USD") or DOCLING_COST_PER_SECOND)
    else:
        url, parallel = _env("DOCLING_CPU_WORKER_URL"), _env("DOCLING_CPU_WORKER_PARALLEL") or DOCLING_CPU_WORKER_PARALLEL
        cost_per_second = float(_env("DOCLING_CPU_COST_PER_SECOND_USD") or DOCLING_CPU_COST_PER_SECOND)
    url, token = url.rstrip("/") + "/parse", _env("DOCLING_WORKER_TOKEN")
    _update_job(job["id"], worker="runpod" if runpod_endpoint else "gpu" if gpu else "cpu")  # internal
    if gpu or meta["kind"] != "pdf":
        parts = _mineru_parts(src, meta, job["page_from"], job["page_to"])
    else:
        parts = [
            (s, e, d, ".pdf")
            for s, e, d in _pdf_chunks(src, job["page_from"], job["page_to"], pages_per_chunk=DOCLING_CPU_CHUNK_PAGES)
        ]

    def post(part: tuple[int, int, bytes, str]) -> tuple[list[dict], float]:
        start, _, data, suffix = part
        if runpod_endpoint:
            return _runpod_parse(
                runpod_endpoint, job["id"], start, data, suffix, meta["name"],
                extra={"languages": ",".join(job["languages"])},
            )
        error = ""
        for attempt in range(4):
            try:
                resp = requests.post(
                    url,
                    headers={"X-Worker-Token": token},
                    files={"file": (f"chunk{suffix}", data, "application/octet-stream")},
                    # the languages choose the OCR model (Arabic or Latin script)
                    data={"first_page": str(start), "filename": meta["name"], "languages": ",".join(job["languages"])},
                    timeout=DOCLING_WORKER_TIMEOUT,
                )
                if resp.status_code == 200:
                    body = resp.json()
                    return body["elements"], body.get("seconds", 0.0)
                error = f"HTTP {resp.status_code}: {resp.text[:300]}"
                # 429: every instance is busy or the GPU quota is used up; wait for one to free up
                if resp.status_code not in (429, 500, 502, 503, 504):
                    break
            except requests.RequestException as e:
                error = repr(e)
            time.sleep(min(60, 5 * 2**attempt))
        raise RuntimeError(f"Docling worker failed on pages starting {start}: {error}")

    def timed_post(part: tuple[int, int, bytes, str]) -> tuple[list[dict], float]:
        global _docling_gpu_last_used
        result = post(part)
        if gpu:
            _docling_gpu_last_used = time.monotonic()
        return result

    # conversion time only: on GPU, cold starts and idle time before scale-down are billed on top
    elements, buffer = _run_parts(
        job, parts, timed_post, int(parallel), cost=lambda seconds, pages: seconds * cost_per_second
    )
    _label_languages(elements)
    pages = list(range(job["page_from"], job["page_to"] + 1))
    _finish_job(job["id"], elements, {"primary": pages, "fallback": [], "skipped": []})
    buffer.clear()


def _label_languages(elements: list[dict]) -> None:
    """MinerU doesn't label languages; detect them per element (as Fast does) so Arabic renders
    right-to-left. _fix_languages then sets the final labels."""
    for e in elements:
        if e["text"] and e["type"] not in ("Formula", "CodeSnippet"):
            if langs := detect_languages(e["text"]):
                e["metadata"]["languages"] = langs


def _rag_chunks(public: list[dict], semantic_split: bool = False) -> tuple[list[dict], str]:
    """A job's RAG chunks and how they were split, "semantic" or "heading" (chunking.py). Semantic
    chunking runs on the Fast worker on Cloud Run, which holds the embedding model, so it scales
    with load and its compute is on the Google bill; without the worker, chunks split at headings."""
    if semantic_split and _env("FAST_WORKER_URL") and _env("FAST_WORKER_TOKEN"):
        try:
            return _rag_chunks_remote(public)
        except Exception:
            log.exception("fast worker could not chunk: using heading-based chunks")
    return chunking.rag_chunks(public)


def _rag_chunks_remote(public: list[dict]) -> tuple[list[dict], str]:
    body = gzip.compress(json.dumps({"elements": public}, ensure_ascii=False).encode("utf-8"))
    if len(body) > FAST_WORKER_MAX_CHUNK_REQUEST:
        raise RuntimeError(f"elements are {len(body)} bytes gzipped, over the worker's request limit")
    error = ""
    for attempt in range(3):
        try:
            resp = requests.post(
                _env("FAST_WORKER_URL").rstrip("/") + "/chunk",
                headers={
                    "X-Worker-Token": _env("FAST_WORKER_TOKEN"),
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                },
                data=body,
                timeout=900,
            )
            if resp.status_code == 200:
                result = resp.json()
                return result["chunks"], result.get("method", "semantic")
            error = f"HTTP {resp.status_code}: {resp.text[:300]}"
            if resp.status_code not in (429, 500, 502, 503, 504):
                break
        except requests.RequestException as e:
            error = repr(e)
        time.sleep(2**attempt)
    raise RuntimeError(f"fast worker /chunk failed: {error}")


_DOT_LEADER = re.compile(r"\s*(?:[.·…_]\s*){4,}")
_TOC_ENTRY = re.compile(r"(?:[.·…_]\s*){4,}\s*[\divxlcIVXLC]+\s*$")
_WORD_CHAR = re.compile(r"\w")
_FURNITURE = ("Header", "Footer", "PageNumber")


def _clean_for_rag(elements: list[dict]) -> list[dict]:
    """Normalize every tier's output the same way before it is stored and chunked."""
    out = []
    for e in elements:
        text = e.get("text") or ""
        # table-of-contents lines: dot leaders are noise for embeddings
        if _TOC_ENTRY.search(text) and e["type"] not in _FURNITURE:
            e["type"] = "ListItem"
        text = _DOT_LEADER.sub(" — ", text).strip()
        # fragments with no letters or digits ("." or "|") carry nothing retrievable
        if not _WORD_CHAR.search(text) and e["type"] not in ("Image", "Table"):
            continue
        e["text"] = text
        out.append(e)
    _fix_languages(out)
    return out


def _fix_languages(elements: list[dict]) -> None:
    """Every element is labeled Indonesian, English or Arabic (language.py): langdetect's labels
    (Afrikaans for Indonesian prose, German or Tagalog for headings) are replaced."""
    language.label(elements)


def _finish_job(job_id: str, elements: list[dict], engines: dict, semantic_split: bool = False) -> None:
    """Store a job's results: in S3 when configured (local files only as a fallback). Results are
    embedded only into indexes whose owner turned auto-embed on (vectors.job_completed); otherwise
    vector indexing is a separate, explicit step. `semantic_split` splits chunks by topic (Fast tier)
    rather than at headings."""
    elements = _clean_for_rag(elements)
    public = _public_elements(elements)
    els = elements_from_dicts(public)
    markdown = elements_to_md(els, exclude_binary_image_data=True, rtl_aware=True)
    text = "\n\n".join(e.text for e in els if e.text)
    chunks, chunk_method = _rag_chunks(public, semantic_split=semantic_split)
    d = JOBS_DIR / job_id
    if storage.enabled():
        storage.save_job_results(job_id, elements, public, markdown, text, chunks)
        where = "s3"
    else:
        _write_json(d / "result.internal.json", elements)
        _write_json(d / "result.json", public)
        (d / "result.md").write_text(markdown, encoding="utf-8")
        (d / "result.txt").write_text(text, encoding="utf-8")
        _write_json(d / "result.chunks.json", chunks)
        where = "local"
    _update_job(
        job_id,
        status="completed",
        # a Pause or Stop that came after the last chunk was already sent has nothing left to halt
        halt=None,
        finished_at=_now(),
        engines=engines,
        elements=len(elements),
        chunks=len(chunks),
        # "heading" on a Fast job means semantic chunking failed (see the log) and fell back
        chunking=chunk_method,
        content_pages=sorted({e["metadata"]["page_number"] for e in public if e["metadata"].get("page_number")}),
        storage=where,
    )
    threading.Thread(target=_save_results_to_files, args=(job_id,), daemon=True).start()
    threading.Thread(target=vectors.job_completed, args=(job_id,), daemon=True).start()


def _save_results_to_files(job_id: str) -> None:
    """Copy a finished job's results (JSON, Markdown, text) into My Project / Parsed Document."""
    try:
        job = _completed_job(job_id)
        for fmt in ("json", "md", "txt"):
            body, media, filename = _result_file(job, fmt)
            drive.save_to_default("parsed", filename, body, f"{media}; charset=utf-8")
    except Exception:
        log.exception("could not copy the results of %s to Files", job_id)


def _worker() -> None:
    while True:
        job_id = _queue.get()
        try:
            # deleted, paused or stopped while waiting (or queued twice by a quick Resume)
            if not (JOBS_DIR / job_id / "job.json").is_file():
                continue
            queued = _read_json(JOBS_DIR / job_id / "job.json")
            if queued.get("status") != "queued":
                continue
            strategy = queued.get("strategy") or ""
            try:
                if strategy.startswith("bluesandai"):
                    with _agentic_lock:
                        _run_job(job_id)
                else:
                    _run_job(job_id)
            finally:
                with _halts_lock:
                    _halts.pop(job_id, None)
        except _Halted as h:
            _finish_halt(job_id, h.kind)
        except Exception as e:  # a failed job must not stop the queue
            log.exception("job %s failed", job_id)
            _update_job(
                job_id,
                status="failed",
                halt=None,
                error_internal=f"{type(e).__name__}: {e}"[:4000],
                finished_at=_now(),
            )
        finally:
            _queue.task_done()


def _init_database() -> None:
    """Connect to PostgreSQL (creating the database and schema if needed) and copy in the files
    and jobs already on disk. PostgreSQL holds accounts, files and jobs; results live in S3."""
    url = _env("BLUESANDAI_DATABASE_URL")
    if not url:
        log.warning("BLUESANDAI_DATABASE_URL not set: files and jobs are stored on disk only")
        return
    try:
        db.init(url)
    except Exception:
        log.exception("PostgreSQL unavailable: files and jobs are stored on disk only")
        return
    for meta_path in FILES_DIR.glob("*/meta.json"):
        meta = _read_json(meta_path)
        _db(db.upsert_file, meta, str(meta_path.parent / meta["stored_name"]))
    for job in _all_jobs():
        tier = LEGACY_TIERS.get(job["tier"], job["tier"])
        _db(db.upsert_job, job, job.get("price_per_page_usd", _price(tier)))
    _db(drive.ensure_defaults)


def _init_storage() -> None:
    try:
        if storage.init(_env):
            log.warning("S3 storage enabled")
        else:
            log.warning("AWS S3 not configured: results are stored on disk")
    except Exception:
        log.exception("S3 unavailable: results are stored on disk")


def _migrate_local_results() -> None:
    """Move results of jobs finished before S3 was configured into S3, then drop the local
    copies so results are stored once. Runs in the background after startup."""
    for job in _all_jobs():
        d = JOBS_DIR / job["id"]
        if job["status"] != "completed" or job.get("storage") == "s3" or not (d / "result.json").is_file():
            continue
        try:
            public = _read_json(d / "result.json")
            internal = _read_json(d / "result.internal.json") if (d / "result.internal.json").is_file() else public
            chunks = (
                _read_json(d / "result.chunks.json")
                if (d / "result.chunks.json").is_file()
                else _rag_chunks(public, semantic_split=job.get("strategy") == "fast")[0]
            )
            markdown = (d / "result.md").read_text(encoding="utf-8") if (d / "result.md").is_file() else ""
            text = (d / "result.txt").read_text(encoding="utf-8") if (d / "result.txt").is_file() else ""
            storage.save_job_results(job["id"], internal, public, markdown, text, chunks)
            _update_job(
                job["id"],
                storage="s3",
                chunks=len(chunks),
                content_pages=sorted({e["metadata"]["page_number"] for e in public if e["metadata"].get("page_number")}),
            )
            for name in ("result.json", "result.internal.json", "result.chunks.json", "result.md", "result.txt"):
                (d / name).unlink(missing_ok=True)
            log.warning("moved results of %s to S3", job["id"])
        except Exception:
            log.exception("could not move results of %s to S3", job["id"])


@app.on_event("startup")
async def _thread_pool() -> None:
    # the sync endpoints share one pool (AnyIO's default: 40 threads); Blu 1.1's 42 clinical examiners each hold a gateway
    # thread for ~30 s a call (aip/telaah.py WORKERS), so at 40 the verdicts' saves and the pages queued behind them
    import anyio.to_thread

    anyio.to_thread.current_default_thread_limiter().total_tokens = int(os.environ.get("BLUESANDAI_API_THREADS") or 128)


@app.on_event("startup")
def _start_worker() -> None:
    # http://localhost:<port> answered only after an IPv6 attempt failed (~0.3 s per new browser connection): the API on [::1] too
    try:
        import loopback6

        loopback6.startup()
    except Exception:
        log.exception("IPv6 loopback relay unavailable")
    _init_storage()
    _init_database()
    secretbox.configure(_env)
    try:
        datasources.startup()
    except Exception:
        log.exception("data sources unavailable")
    # Data Connection capabilities beyond syncs: exports, webhooks, listeners, HyperAuto
    for module in (network, exports, webhooks, listeners, hyperauto, sddi, audit3, sds, data_lifetime, backups):
        try:
            module.startup()
        except Exception:
            log.exception("%s unavailable", module.__name__)
    vectors.startup()
    code_workspace_vscode.startup()
    mqtt_broker.startup()
    try:
        pipeline_runtime.startup()
    except Exception:
        log.exception("pipeline builds and schedules unavailable")
    try:
        lineage.startup()
    except Exception:
        log.exception("lineage warm-up unavailable")
    try:
        streaming.startup()
    except Exception:
        log.exception("streaming syncs and stream monitoring unavailable")
    # SQL & BI: the PostgreSQL wire-protocol endpoint for BI tools (BLUESANDAI_SQL_PORT, default 5433)
    try:
        sql_bi.startup()
    except Exception:
        log.exception("SQL endpoint unavailable")
    # Contour: scheduled builds of saved datasets
    try:
        contour.startup()
    except Exception:
        log.exception("Contour schedules unavailable")
    # the Map demo's AIS feed lives in this process: resume it
    timeseries_demo.startup()
    try:
        # catalog syncs rebuilt when their dataset updates; time series alerting evaluation jobs
        timeseries.startup()
        ts_alerting.startup()
    except Exception:
        log.exception("time series syncs and alerting unavailable")
    try:
        # dataset health rules, checked every couple of minutes (alerts: monitoring views)
        health_checks.startup()
    except Exception:
        log.exception("dataset health checks unavailable")
    try:
        # media set retention policies
        media_sets.startup()
    except Exception:
        log.exception("media set retention unavailable")
    try:
        # dataset retention policies and projection rebuilds, at startup and then hourly
        dataset_retention.startup()
    except Exception:
        log.exception("dataset retention unavailable")
    try:
        # Iceberg maintenance task schedules and the daily orphan file removal
        iceberg_maintenance.start()
    except Exception:
        log.exception("Iceberg maintenance schedules unavailable")
    # user schedules (SQL writes, Logic flows, recipes, peering relay, linter sweeps) run only in the served API,
    # never in a process that merely imports this module (tests, scripts)
    for name, start in (("SQL write schedules", sql_writes.start), ("Logic flow schedules", logic_flows.start),
                        ("recipes", recipes.start), ("peering relay", peering.start), ("linter sweeps", linter.start)):
        try:
            start()
        except Exception:
            log.exception("%s unavailable", name)
    # -- results written before internal metadata was split out: split them now --
    for d in JOBS_DIR.iterdir():
        if (d / "result.json").is_file() and not (d / "result.internal.json").is_file():
            elements = _read_json(d / "result.json")
            _write_json(d / "result.internal.json", elements)
            _write_json(d / "result.json", _public_elements(elements))
    # -- jobs interrupted by a restart are re-queued --
    for job in _all_jobs()[::-1]:
        if job["status"] in ("queued", "running") and job.get("halt"):
            # it was pausing or stopping: keep it halted (its buffer holds what was parsed)
            _update_job(job["id"], status="paused" if job["halt"] == "pause" else "stopped", halt=None, halted_at=_now())
        elif job["status"] in ("queued", "running"):
            _update_job(job["id"], status="queued", pages_done=0)
            _queue.put(job["id"])
    try:
        workers = max(1, int(_env("BLUESANDAI_JOB_WORKERS") or JOB_WORKERS))
    except ValueError:
        workers = JOB_WORKERS
    for _ in range(workers):
        threading.Thread(target=_worker, daemon=True).start()
    knowledge.resume()
    ontology.startup()
    ontology_model.startup()
    ontology_scenarios.startup()
    ontology_edits.startup()
    foundry_rules.startup()
    object_monitors.startup()
    ontology_link_datasets.startup()
    ontology_attachments.startup()
    code_repos.startup()
    if storage.enabled():
        threading.Thread(target=_migrate_local_results, daemon=True).start()
    ontology_mdo.startup()
