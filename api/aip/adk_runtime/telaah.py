"""Blu 1.1's clinical review at work (aip/telaah.py keeps its facts, its prompt and every verdict): plain code sends the
claims to the two models through the gateway — so every call is booked on the run and its cost limit — ten at a time,
and guards the money (the user, 2026-10-30: "if it fail it cost a lot"):

- the ceiling is checked before every call, with the calls in flight counted at their worst case, and the run's own
  earlier spend on the review counted (a run continued after a cut does not start from zero);
- a refused budget, a run the gateway no longer serves, or half of the last calls failing stops the review at once;
- an answer from a model of another family than the seat's (the gateway fails over when a model stalls) is not used:
  the re-check would otherwise be its own judge, and the screen would no longer be the model the calibration measured;
- every verdict is kept as soon as it is paid for (POST /api/aip/telaah/simpan), so whatever stops the review, nothing
  is paid for twice;
- the calibration (the set's first 300 claims, both models) decides whether the full review runs at all.

A review that stops returns why; the engagement goes on as Blu 1.0 with what was reviewed (adk_runtime/firm.py).

Blu 1.3 (the user, 2026-10-30): OpenAI Decisions alone (aip/telaah.py DECISION_QUESTIONS), one claim a request through
the gateway's /openai/v1/decisions under the same guards; it answers a probability per conclusion and no text. No re-check
and no tags ("we have agent for this later"): its calibration compares it with Blu 1.1's screen from verdicts already kept
(never called), and it leaves the set ranked for the agents.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections import deque
from typing import Any, Callable, Optional

import httpx

from aip import models as aip_models
from aip import telaah as TL
from aip.adk_runtime.platform import Platform, emit

PAGE = 500  # claims fetched per page of the full screen
MAX_TOKENS = 4000  # an answer for ten claims is ~900 tokens; the cap also sets the gateway's wait (aip/models.py attempt_timeout:
# ~114 s at 4.000 against ~86 s at 3.000 — the first full review's DeepSeek calls took 22 s median, 64 s p90, up to 176 s)
# batches in flight per seat: one per examiner of the clinical examination's tree (aip/telaah.py WORKERS)
TRIES = 3  # attempts per call (the gateway itself already waits out 429s and fails over once)
DECISIONS_WAIT = 30  # seconds for a Decisions batch through the gateway, plus 15 a claim (answers take ~0.3 s; the gateway waits 60 s a claim)
PAUSE = 20  # seconds after a quota refusal before the seat's next call
WINDOW, BREAK_MIN, BREAK_SHARE = 40, 20, 0.5  # the circuit: half of the last 40 calls failing (after 20) stops the review
PROGRESS_S = 20  # seconds between progress events
PART = 500  # Blu 1.3: rows a result keeps (adk_runtime/tools.py ROWS_KEPT): every claim not wajar in parts of this many


class Halt(Exception):
    """The review stops (its reason is in Review.halted)."""


def _family(model: str) -> str:
    return aip_models.family(model) if model else ""


class _Pool:
    """One seat's examiners and their shared queue (the clinical examination's tree, aip/telaah.py team): rows come in all
    at once (the calibration) or while they work (the screen page by page, the re-check from the screen's verdicts); each
    examiner takes ten at a time until the queue is closed and empty, or the review halts. Kept verdicts are not asked."""

    def __init__(self, review: "Review", seat: str, on_verdict: Optional[Callable[[dict, dict], None]] = None):
        self.r, self.seat, self.on_verdict = review, seat, on_verdict
        self.rows: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.out: dict[str, dict] = {}
        self.closed = False

    def add(self, rows: list[dict]) -> None:
        kept: dict[str, dict] = {}
        for row in rows:
            if row["klaim_id"] in self.by_id:
                continue
            self.by_id[row["klaim_id"]] = row
            v = (row.get("tersimpan") or {}).get(self.seat)
            if v:
                kept[row["klaim_id"]] = v
            else:
                self.rows.append(row)
        self.r.total[self.seat] = max(self.r.total[self.seat], len(self.by_id))
        if kept:
            self.done(kept)

    def done(self, got: dict[str, dict]) -> None:
        self.out.update(got)
        self.r.done[self.seat] += len(got)
        for k, v in got.items():
            self.r.counts[v["kesimpulan"]] += self.seat == "saring"
            if self.on_verdict:
                self.on_verdict(self.by_id[k], v)

    async def examiner(self, k: int) -> None:
        key = TL.examiner_key(self.seat, self.r.models[self.seat], k)
        t0, calls, started = time.time(), 0, False
        while not self.r.halted:
            if len(self.rows) >= TL.BATCH or (self.closed and self.rows):
                batch = self.rows[:TL.BATCH]
                del self.rows[:TL.BATCH]
            elif self.closed:
                break
            else:
                await asyncio.sleep(0.5)
                continue
            if not started:
                started = True
                emit({"type": "agent_status", "agent": key, "status": "bekerja", "model": self.r.models[self.seat]})
            t1 = time.time()
            got = await self.r.batch(self.seat, batch, self.by_id)
            self.done(got)
            calls += 1
            per = {c: sum(v["kesimpulan"] == c for v in got.values()) for c in TL.CONCLUSIONS}
            emit({"type": "tool", "agent": key, "tool": "telaah_klinis", "ok": bool(got), "ms": int((time.time() - t1) * 1000), "rows": len(got),
                  "summary": f"{len(got)}/{len(batch)} klaim · wajar {per['wajar']} · perlu diperiksa {per['perlu_diperiksa']} · mencurigakan {per['mencurigakan']}"})
            self.r.progress(self.seat)
        if started:
            emit({"type": "agent_status", "agent": key, "status": "selesai", "ms": int((time.time() - t0) * 1000), "calls": calls, "tags": 0})

    async def run(self) -> None:
        await asyncio.gather(*(self.examiner(k) for k in range(1, TL.workers(self.r.models[self.seat]) + 1)))


class Review:
    def __init__(self, inp: dict, p: Platform, result: Callable[[str, list[dict], dict], str]):
        self.p, self.result = p, result
        self.api, self.token, self.run_id = inp["api"].rstrip("/"), inp.get("token", ""), inp["run_id"]
        self.versi = inp.get("versi") if inp.get("versi") in TL.REVIEWED else "1.1"
        self.label = f"Blu {self.versi}"  # in the results' titles and the tags' evidence
        # Blu 1.3: the other seat is a reference (its verdicts already kept), never asked; nothing is re-checked or tagged
        self.reference = self.versi == "1.3"
        seats = inp.get("kursi") or {}
        self.models = {"saring": seats.get("telaah_saring") or aip_models.DEEPSEEK, "periksa": seats.get("telaah_periksa") or aip_models.GLM}
        if _family(self.models["saring"]) == _family(self.models["periksa"]):
            raise ValueError(f"model periksa ({self.models['periksa']}) harus dari keluarga lain dari model saring ({self.models['saring']})")
        self.limit = float(inp.get("telaah_batas_usd") or TL.ceiling())
        # what the full review may spend, for the calibration's projection (a calibration-only run caps its own spend lower)
        self.plan_limit = float(inp.get("telaah_batas_rencana_usd") or self.limit)
        self.spent = 0.0
        self.calls = {"saring": 0, "periksa": 0}
        self.cost = {"saring": [], "periksa": []}  # USD per answered call, for the worst case of the next
        self.failed: list[str] = []
        self.refused_family = 0
        self.recent: deque[bool] = deque(maxlen=WINDOW)
        self.halted = ""
        self.inflight = 0
        self.cool_until = {"saring": 0.0, "periksa": 0.0}
        self.fmt: dict[str, str] = {}  # model -> the response format its endpoint takes: schema, object or none
        self.sems = {seat: asyncio.Semaphore(TL.workers(m)) for seat, m in self.models.items()}
        self.done = {"saring": 0, "periksa": 0}
        self.total = {"saring": 0, "periksa": 0}
        self.counts = {c: 0 for c in TL.CONCLUSIONS}
        self.last_progress = {"saring": 0.0, "periksa": 0.0}
        self.client: Optional[httpx.AsyncClient] = None

    # ---------------------------------------------------------------------------------------- the money

    def halt(self, why: str) -> None:
        if not self.halted:
            self.halted = why
            emit({"type": "telaah", "tahap": "berhenti", "alasan": why, "usd": round(self.spent, 4), "batas_usd": self.limit})

    def worst(self, seat: str) -> float:
        """A call's worst cost: the dearest answered so far with room, or the price of a full prompt and output."""
        seen = self.cost[seat]
        if len(seen) >= 5:
            return max(seen) * 1.5
        p = (aip_models.MODELS.get(self.models[seat]) or {}).get("price") or {"input": 2.0, "output": 8.0}
        return (7000 * p["input"] + MAX_TOKENS * p["output"]) / 1e6

    def guard(self, seat: str, n: int = 1) -> None:
        """Before a call of `n` claims' requests (a Decisions batch): the ceiling, with what is in flight at its worst."""
        if self.halted:
            raise Halt
        if self.spent + (self.inflight + n) * self.worst(seat) > self.limit:
            self.halt(f"batas biaya telaah ${self.limit:.2f} tercapai (terpakai ${self.spent:.2f})")
            raise Halt

    def outcome(self, ok: bool) -> None:
        self.recent.append(ok)
        bad = self.recent.count(False)
        if len(self.recent) >= BREAK_MIN and bad / len(self.recent) >= BREAK_SHARE:
            self.halt(f"{bad} dari {len(self.recent)} panggilan terakhir gagal: layanan model bermasalah, telaah dihentikan agar biaya tidak terbuang")

    async def earlier_spend(self) -> None:
        """What this run already spent on the review (before a cut): the ceiling is the run's, not this process's."""
        try:
            run = (await asyncio.to_thread(self.p.get, f"/api/aip/runs/{self.run_id}", after=10 ** 9)).get("run") or {}
            usage = run.get("agents_usage") or {}
            self.spent = sum(float(v.get("usd") or 0) for k, v in usage.items() if k.startswith("telaah_"))
        except Exception:  # noqa: BLE001 - unknown: counted from zero, the gateway's run budget still holds
            self.spent = 0.0

    async def sync_spend(self) -> None:
        """The run's own booking (the gateway's ledger) every half minute: a call this process gave up on (a timeout) may
        still have been answered and paid for upstream, so the ceiling follows the larger of the two."""
        if time.time() - getattr(self, "_synced", 0.0) < 30:
            return
        self._synced = time.time()
        try:
            run = (await asyncio.to_thread(self.p.get, f"/api/aip/runs/{self.run_id}", after=10 ** 9)).get("run") or {}
            booked = sum(float(v.get("usd") or 0) for k, v in (run.get("agents_usage") or {}).items() if k.startswith("telaah_"))
            self.spent = max(self.spent, booked)
        except Exception:  # noqa: BLE001 - the local count holds until the next
            pass
        if self.spent >= self.limit:
            self.halt(f"batas biaya telaah ${self.limit:.2f} tercapai (terpakai ${self.spent:.2f})")

    async def cooldown(self, seat: str) -> None:
        wait = self.cool_until[seat] - time.time()
        if wait > 0:
            await asyncio.sleep(wait)

    # ---------------------------------------------------------------------------------------- one call

    def _body(self, seat: str, batch: list[tuple[str, dict]]) -> dict:
        model = self.models[seat]
        body: dict[str, Any] = {"model": model, "temperature": 0.1, "max_tokens": MAX_TOKENS,
                                "messages": [{"role": "system", "content": TL.SYSTEM}, {"role": "user", "content": TL.user_text(batch)}]}
        fmt = self.fmt.get(model, "schema")
        if fmt == "schema":
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "telaah_klinis", "strict": False, "schema": TL.SCHEMA}}
        elif fmt == "object":
            body["response_format"] = {"type": "json_object"}
        fam = _family(model)
        if fam == "zai-org":
            body["chat_template_kwargs"] = {"enable_thinking": False}  # an answer, not a monologue (adk_runtime/agents.py)
        elif fam == "openai":
            body["reasoning_effort"] = "medium"
        return body

    def refusal(self, r: httpx.Response) -> str:
        """What a refused call says; a refused budget, or a run the gateway no longer serves, halts the review (Halt)."""
        try:
            err = r.json()
        except ValueError:
            err = {}
        e = err.get("error") if isinstance(err.get("error"), dict) else {}
        code, msg = str(e.get("code") or ""), str(e.get("message") or err.get("detail") or r.text)[:300]
        if code in ("run_budget_exceeded", "budget_exceeded"):
            self.halt(f"anggaran ditolak: {msg}")
            raise Halt
        if r.status_code in (401, 403):
            self.halt(f"run tidak lagi dilayani gateway ({r.status_code}): {msg[:120]}")
            raise Halt
        return msg

    def pause_for(self, seat: str, retry_after: Any, attempt: int) -> None:
        """A 429 from OpenAI (the key's tokens a minute): the seat waits what OpenAI says, at least 2 s a try."""
        try:
            wait = float(retry_after or 0)
        except (TypeError, ValueError):
            wait = 0.0
        self.cool_until[seat] = max(self.cool_until[seat], time.time() + max(wait, 2.0 * max(1, attempt)))

    async def ask_decisions(self, seat: str, rows: list[dict]) -> tuple[dict[str, dict], str]:
        """Blu 1.3's screen: OpenAI Decisions on the rows in one gateway call (it asks OpenAI claim by claim over one
        connection and books the batch once; typed answers, no text). The claims a 429 or an outage left unasked are asked
        again after the seat's pause; a halt, or tries that bring nothing, end the batch with what was answered (paid for:
        the caller keeps it)."""
        model = self.models[seat]
        headers = {"X-AIP-Run": self.run_id, "X-AIP-Agent": f"telaah_{seat}", "Authorization": f"Bearer {self.token}"}
        out: dict[str, dict] = {}
        why, last, attempt, left = "", "", 0, list(rows)
        try:
            while left and attempt < TRIES:
                await self.cooldown(seat)
                self.guard(seat, len(left))
                body = {"model": model, "items": [{"input": TL.decision_input(x["fakta"]), "questions": TL.DECISION_QUESTIONS} for x in left]}
                self.inflight += len(left)
                try:
                    r = await self.client.post(f"{self.api}/api/aip/openai/v1/decisions", json=body, headers=headers, timeout=DECISIONS_WAIT + 15 * len(left))
                except httpx.HTTPError as e:
                    last = f"{type(e).__name__}: {str(e)[:120]}"
                    attempt += 1
                    await asyncio.sleep(2 * attempt)
                    continue
                finally:
                    self.inflight -= len(left)
                if r.status_code != 200:  # the batch refused whole: a budget or a run the gateway no longer serves halts
                    last = f"HTTP {r.status_code}: {self.refusal(r)[:200]}"
                    attempt += 1
                    if r.status_code == 429:
                        self.pause_for(seat, r.headers.get("retry-after"), attempt)
                    elif r.status_code < 500:
                        why = last
                        break
                    else:
                        await asyncio.sleep(2 * attempt)
                    continue
                used = r.headers.get("x-aip-model") or model
                done, paused = 0, False
                for row, item in zip(left, r.json().get("results") or [], strict=False):  # in order; shorter when the batch stopped
                    if item.get("status") != 200:
                        last = f"HTTP {item.get('status')}: {str((item.get('error') or {}).get('message') or '')[:200]}"
                        if item.get("status") == 429:
                            self.pause_for(seat, item.get("retry_after"), attempt + 1)
                            paused = True
                        break
                    self.calls[seat] += 1
                    cost = aip_models.cost(model, item.get("usage"))
                    self.spent += cost
                    self.cost[seat].append(cost)
                    v, bad = TL.parse_decision(item)
                    if v:
                        out[row["klaim_id"]] = {**v, "model_jawab": used, "usd": round(cost, 8), "ms": int(item.get("ms") or 0), "gerbang": []}
                    why = bad or why
                    done += 1
                left = left[done:]
                attempt = 0 if done else attempt + 1  # tries count only while nothing comes back
                if left and not done and not paused:
                    await asyncio.sleep(2 * attempt)
            if left:
                why = last or why or "tidak ada jawaban"
        except Halt:
            pass
        return out, why

    async def ask(self, seat: str, rows: list[dict]) -> tuple[dict[str, dict], str]:
        """{klaim_id: verdict} for the rows one call answered in form, and what was wrong ("")."""
        model = self.models[seat]
        if aip_models.is_decisions(model):
            return await self.ask_decisions(seat, rows)
        ids = [f"k{i + 1}" for i in range(len(rows))]
        batch = list(zip(ids, [r["fakta"] for r in rows], strict=True))
        # no failover (aip/gateway.py): a quota refusal comes back as a 429 and pauses the seat, not paid for in another family
        headers = {"X-AIP-Run": self.run_id, "X-AIP-Agent": f"telaah_{seat}", "Authorization": f"Bearer {self.token}", "X-AIP-Failover": "off"}
        last, downgrades = "", 0
        attempt = 0
        while attempt < TRIES:
            await self.cooldown(seat)
            self.guard(seat)
            t0 = time.time()
            self.inflight += 1
            try:
                r = await self.client.post(f"{self.api}/api/aip/openai/v1/chat/completions", json=self._body(seat, batch), headers=headers,
                                           timeout=aip_models.client_timeout(MAX_TOKENS))
            except httpx.HTTPError as e:
                last = f"{type(e).__name__}: {str(e)[:120]}"
                attempt += 1
                await asyncio.sleep(5 * attempt)
                continue
            finally:
                self.inflight -= 1
            self.calls[seat] += 1
            if r.status_code == 200:
                payload = r.json()
                used = r.headers.get("x-aip-model") or model
                cost = aip_models.cost(used, payload.get("usage"))
                self.spent += cost
                if _family(used) != _family(model):
                    # the gateway failed over: not the seat's model (and the re-check must never be the screen's family)
                    self.refused_family += 1
                    last = f"dijawab {used}, bukan keluarga {model}: jawaban tidak dipakai"
                    # this worker waits a little; the others go on (a seat-wide pause here stalled the first full review ~35
                    # minutes in 2¼ hours: the model was slow, not out of quota — a 429 still pauses the whole seat)
                    attempt += 1
                    await asyncio.sleep(5)
                    continue
                self.cost[seat].append(cost)
                text = ((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                got, why = TL.parse(text, ids)
                ms = int((time.time() - t0) * 1000)
                out = {}
                for i, row in zip(ids, rows, strict=True):
                    if i in got:
                        v = got[i]
                        out[row["klaim_id"]] = {**v, "model_jawab": used, "usd": round(cost / len(rows), 8), "ms": ms,
                                                "gerbang": TL.unverified(v["alasan"], row["fakta"])[:10]}
                return out, why
            msg = self.refusal(r)
            if r.status_code == 400 and self.fmt.get(model, "schema") != "none" and downgrades < 2:
                # the endpoint may not take the response format: the next simpler one (the parser reads plain JSON too)
                self.fmt[model] = "object" if self.fmt.get(model, "schema") == "schema" else "none"
                downgrades += 1
                last = f"HTTP 400 dengan format jawaban, dicoba {self.fmt[model]}: {msg[:120]}"
                continue
            last = f"HTTP {r.status_code}: {msg[:200]}"
            attempt += 1
            if r.status_code == 429:
                self.cool_until[seat] = max(self.cool_until[seat], time.time() + PAUSE * attempt)
            elif r.status_code < 500:
                break
            else:
                await asyncio.sleep(5 * attempt)
        raise RuntimeError(last or "tidak ada jawaban")

    # ---------------------------------------------------------------------------------------- many claims

    def progress(self, seat: str, force: bool = False) -> None:
        if force or time.time() - self.last_progress[seat] >= PROGRESS_S:
            self.last_progress[seat] = time.time()
            emit({"type": "telaah", "tahap": seat, "selesai": self.done[seat], "total": self.total[seat], "usd": round(self.spent, 4),
                  "batas_usd": self.limit, "kesimpulan": dict(self.counts), "panggilan": dict(self.calls), "gagal": len(self.failed),
                  "ditolak_keluarga": self.refused_family})

    async def save(self, seat: str, verdicts: dict[str, dict], rows: dict[str, dict]) -> None:
        body = {"run_id": self.run_id, "model": self.models[seat], "peran": seat,
                "hasil": [{"klaim_id": k, "hash": rows[k]["hash"], **{f: v.get(f) for f in ("kesimpulan", "tag", "alasan", "keyakinan", "model_jawab", "gerbang", "usd", "ms")},
                           **{f: v[f] for f in ("peluang", "skor", "tanpa_alasan") if v.get(f) is not None}}
                          for k, v in verdicts.items()]}
        for attempt in range(3):  # paid for: kept, or said
            try:
                await asyncio.to_thread(self.p.post, "/api/aip/telaah/simpan", body)
                return
            except Exception as e:  # noqa: BLE001 - the API busy a moment
                if attempt == 2:
                    emit({"type": "error", "agent": "telaah_klinis", "message": f"vonis {len(verdicts)} klaim tidak tersimpan: {str(e)[:200]}"})
                await asyncio.sleep(2 * (attempt + 1))

    async def batch(self, seat: str, batch: list[dict], by_id: dict[str, dict]) -> dict[str, dict]:
        """One call of the seat's model on up to ten claims (the ones its answer missed asked once more on their own), its
        verdicts kept at once. Empty when it failed or the review halted."""
        got: dict[str, dict] = {}
        try:
            got, _why = await self.ask(seat, batch)
            missing = [r for r in batch if r["klaim_id"] not in got]
            if missing and not self.halted:
                try:
                    more, _ = await self.ask(seat, missing)
                    got.update(more)
                except (RuntimeError, Halt) as e:  # the first answer is paid for: it is kept below whatever happens here
                    if isinstance(e, RuntimeError):
                        self.failed.append(f"{seat}: {e}"[:200])
            self.outcome(bool(got))
        except Halt:
            return got
        except Exception as e:  # noqa: BLE001 - one batch failing is counted; the circuit decides when to stop
            self.failed.append(f"{seat}: {type(e).__name__}: {e}"[:200])
            self.outcome(False)
        await self.sync_spend()
        if got:
            await self.save(seat, got, by_id)
        return got

    async def review(self, seat: str, rows: list[dict]) -> dict[str, dict]:
        """Every row's verdict from the seat's team: kept ones as they are, the rest by its examiners (the calibration)."""
        pool = _Pool(self, seat)
        pool.add(rows)
        pool.closed = True
        await pool.run()
        return pool.out

    # ---------------------------------------------------------------------------------------- the review

    def _get(self, path: str, **params: Any) -> Any:
        return self.p.get(path, **params)

    def _post(self, path: str, body: dict) -> Any:
        return self.p.post(path, body)

    async def run(self, mode: str = "penuh", n: int = TL.SAMPLE_N) -> dict:
        """mode "kalibrasi": the calibration alone (n claims); "penuh": the calibration, then — when it passes — every claim,
        the re-check, the tags. Returns the review's summary; its status says how it ended."""
        self.client = httpx.AsyncClient()
        # bound to the loop that runs the review (a semaphore made outside it fails on first contention)
        self.sems = {seat: asyncio.Semaphore(TL.workers(m)) for seat, m in self.models.items()}
        try:
            return await self._run(mode, n)
        finally:
            await self.client.aclose()

    async def feed(self, screen: _Pool, total: int) -> None:
        """The set into the screen's queue page by page, a few pages ahead of its examiners (not the whole set at once)."""
        s, c = self.models["saring"], self.models["periksa"]
        offset = 0
        while offset < total and not self.halted:
            while len(screen.rows) > 3 * PAGE and not self.halted:
                await asyncio.sleep(1)
            page = (await asyncio.to_thread(self._post, "/api/aip/telaah/klaim", {"offset": offset, "limit": PAGE, "saring": s, "periksa": c}))["baris"]
            if not page:
                break
            screen.add(page)
            offset += len(page)
        screen.closed = True

    async def ranked(self, total: int, summary: dict) -> dict:
        """Blu 1.3 after its calibration: every claim of the set through the Decisions examiners from one queue; no re-check
        and no tags (the agents after it read the claims and tag with their own evidence). It leaves every verdict kept
        (the agents' tool telaah_klinis_klaim) and, for the plan, every claim that is not wajar — mencurigakan and perlu
        diperiksa, by score, in results of PART rows — with the counts per province and per facility (the user, 2026-10-30:
        "why 500 … not all mencurigakan & perlu_diperiksa")."""
        screened: dict[str, dict] = {}
        self.total["saring"], self.done["saring"] = total, 0
        self.counts = {k: 0 for k in TL.CONCLUSIONS}

        def keep(row: dict, v: dict) -> None:
            screened[row["klaim_id"]] = {"klaim_id": row["klaim_id"], "v": v, "faskes_profil_id": row.get("faskes_profil_id"), "provinsi": row.get("provinsi"),
                                         "inacbg_kode": row.get("inacbg_kode")}
            row.pop("fakta", None)  # read and done: its facts need not stay in memory

        screen = _Pool(self, "saring", keep)
        await asyncio.gather(self.feed(screen, total), screen.run())
        self.progress("saring", force=True)
        per = {k: sum(1 for x in screened.values() if x["v"]["kesimpulan"] == k) for k in TL.CONCLUSIONS}
        flagged = sorted(((k, x) for k, x in screened.items() if x["v"]["kesimpulan"] != "wajar"), key=lambda kv: TL.handed_rank(kv[0], kv[1]["v"]))
        handed = flagged[:TL.HANDED]  # what the swarm analyses: every mencurigakan, then perlu diperiksa by score
        top = {k for k, _x in handed}
        rids = []
        for i in range(0, len(handed), PART):
            part = [{"klaim_id": k, "faskes_profil_id": x["faskes_profil_id"], "provinsi": x["provinsi"], "inacbg_kode": x["inacbg_kode"],
                     "kesimpulan": x["v"]["kesimpulan"], "skor": x["v"].get("skor"),
                     **{f"peluang_{c}": (x["v"].get("peluang") or {}).get(c) for c in TL.CONCLUSIONS}, "tag_usulan": x["v"].get("tag") or ""}
                    for k, x in handed[i:i + PART]]
            rids.append(self.result(f"Telaah klinis {self.label}: {len(handed)} klaim teratas OpenAI Decisions untuk agen, mencurigakan dulu lalu skor "
                                    f"({i + 1}–{i + len(part)})", part, {"kind": "telaah_peringkat", "metric": "skor", "label": "klaim_id"}))

        def counts(key: str) -> list[dict]:
            """The verdicts per province or per facility: its claims not wajar first, mencurigakan before perlu diperiksa."""
            g: dict[Any, dict] = {}
            for x in screened.values():
                k = x[key] or "-"
                r = g.setdefault(k, {key: k, **({"provinsi": x["provinsi"]} if key != "provinsi" else {}), "teratas": 0, "mencurigakan": 0, "perlu_diperiksa": 0,
                                     "wajar": 0, "ditelaah": 0, "skor_sum": 0.0})
                r[x["v"]["kesimpulan"]] += 1
                r["teratas"] += x["klaim_id"] in top
                r["ditelaah"] += 1
                r["skor_sum"] += float(x["v"].get("skor") or 0)
            out_ = [{**{f: v for f, v in r.items() if f != "skor_sum"}, "skor_rata": round(r["skor_sum"] / r["ditelaah"], 3)} for r in g.values()]
            return sorted(out_, key=lambda r: (-r["teratas"], -r["mencurigakan"], -r["perlu_diperiksa"], str(r[key])))

        prov = counts("provinsi")
        fas = [r for r in counts("faskes_profil_id") if r["teratas"]]  # every facility with a claim handed to the swarm
        rid_prov = self.result(f"Telaah klinis {self.label}: kesimpulan OpenAI Decisions per provinsi", prov, {"kind": "telaah_provinsi", "metric": "mencurigakan", "label": "provinsi"})
        rid_fas = [self.result(f"Telaah klinis {self.label}: faskes dengan klaim teratas OpenAI Decisions ({i + 1}–{i + len(fas[i:i + PART])} dari {len(fas)})",
                               fas[i:i + PART], {"kind": "telaah_faskes", "metric": "mencurigakan", "label": "faskes_profil_id"}) for i in range(0, len(fas), PART)]
        out = {**summary, "status": "berhenti" if self.halted else "selesai", "alasan": [self.halted] if self.halted else [],
               "ditelaah": len(screened), "kesimpulan_saring": per, "bukan_wajar_saring": len(flagged), "diperiksa_ulang": 0,
               "diserahkan": len(handed), "diserahkan_mencurigakan": sum(1 for _k, x in handed if x["v"]["kesimpulan"] == TL.FLAG),
               "layak_tag": 0, "tanpa_alasan_sah": 0, "tag": 0, "tag_ditolak": 0, "rid_diserahkan": rids, "rid_provinsi": rid_prov, "rid_faskes": rid_fas,
               "per_provinsi": [{k: r[k] for k in ("provinsi", "teratas", "mencurigakan", "perlu_diperiksa")} for r in prov],
               "faskes_teratas": [{k: r[k] for k in ("faskes_profil_id", "provinsi", "teratas", "mencurigakan")} for r in fas[:10]],
               "usd": round(self.spent, 4), "panggilan": dict(self.calls), "gagal": len(self.failed), "contoh_gagal": self.failed[:5], "ditolak_keluarga": self.refused_family}
        table = [{"ukuran": k, "nilai": v if not isinstance(v, (dict, list)) else str(v)} for k, v in out.items()
                 if k in ("status", "ditelaah", "kesimpulan_saring", "bukan_wajar_saring", "diserahkan", "diserahkan_mencurigakan", "rid_diserahkan", "rid_provinsi",
                          "rid_faskes", "usd", "panggilan", "gagal", "alasan")]
        table.append({"ukuran": "tag", "nilai": f"tidak ada: agen memeriksa {len(handed)} klaim teratas dan menandai dengan buktinya sendiri"})
        out["rid"] = self.result(f"Telaah klinis {self.label}: ringkasan", table, {"kind": "telaah_ringkasan"})
        out["rid_tag"] = []
        emit({"type": "telaah", "tahap": "selesai", **{k: v for k, v in out.items() if k != "kalibrasi"}})
        return out

    async def _run(self, mode: str, n: int) -> dict:
        s, c = self.models["saring"], self.models["periksa"]
        await self.earlier_spend()
        info = await asyncio.to_thread(self._get, "/api/aip/telaah/ringkasan", saring=s, periksa=c, versi=self.versi)
        total = int(info["klaim"])
        emit({"type": "telaah", "tahap": "mulai", "versi": self.versi, "mode": mode, "klaim": total, "model": dict(self.models), "batas_usd": self.limit,
              "usd": round(self.spent, 4), "tersimpan": info.get("tersimpan"), "estimasi": info.get("estimasi"), "aturan": info.get("aturan")})
        summary: dict[str, Any] = {"mode": mode, "klaim": total, "model": dict(self.models), "batas_usd": self.limit}

        # 1. the calibration: the set's first claims, both models (kept verdicts are free); Blu 1.3's second column is the
        # reference's kept verdicts, read and never paid for
        sample = (await asyncio.to_thread(self._post, "/api/aip/telaah/klaim", {"sampel": "kalibrasi", "saring": s, "periksa": c}))["baris"][:n]
        new_s = sum(1 for r in sample if not (r.get("tersimpan") or {}).get("saring"))
        self.total["saring"], self.total["periksa"] = len(sample), len(sample)
        vs = await self.review("saring", sample)
        vp = ({r["klaim_id"]: r["tersimpan"]["periksa"] for r in sample if (r.get("tersimpan") or {}).get("periksa")} if self.reference
              else await self.review("periksa", sample))
        cal = TL.calibration(sample, vs, vp)
        est = info.get("estimasi") or {}
        per_s = cal["saring"]["usd_per_klaim"] or (est.get("usd_per_klaim") or {}).get("saring") or 0.0
        per_p = cal["periksa"]["usd_per_klaim"] or (est.get("usd_per_klaim") or {}).get("periksa") or 0.0
        kept_s = int((info.get("tersimpan") or {}).get("saring") or 0) + sum(1 for r in sample if r["klaim_id"] in vs and not (r.get("tersimpan") or {}).get("saring"))
        kept_p = int((info.get("tersimpan") or {}).get("periksa") or 0) + sum(1 for r in sample if r["klaim_id"] in vp and not (r.get("tersimpan") or {}).get("periksa"))
        rate = cal["saring"]["porsi_diperiksa_ulang"]
        left_s = max(0, total - kept_s)
        left_p = 0 if self.reference else max(0, round(total * (rate + TL.AUDIT_SHARE * (1 - rate))) - kept_p)
        projected = round(left_s * per_s + left_p * per_p, 2)
        why = TL.gate(cal, projected, self.spent, self.plan_limit, reference=self.reference) if not self.halted else [self.halted]
        if len(sample) < TL.SAMPLE_N:
            why = [f"sampel uji {len(sample)} klaim (< {TL.SAMPLE_N}): hanya uji asap, bukan kalibrasi"] + why
        rows = [{"ukuran": label, "saring": cal["saring"].get(k) if not isinstance(cal["saring"].get(k), dict) else str(cal["saring"][k]),
                 "periksa": cal["periksa"].get(k) if not isinstance(cal["periksa"].get(k), dict) else str(cal["periksa"][k])}
                for k, label in (("porsi_sah", "porsi jawaban sah"), ("porsi_mencurigakan", "porsi mencurigakan"),
                                 ("porsi_diperiksa_ulang", "porsi bukan wajar (diperiksa ulang)"), ("kesimpulan", "kesimpulan"),
                                 ("dikoreksi_di_mencurigakan", "dikoreksi verifikator di antara yang mencurigakan"),
                                 ("dikoreksi_di_lainnya", "dikoreksi verifikator di antara yang lain"),
                                 ("gerbang_angka_gagal", "alasan dengan angka di luar fakta"), ("usd_per_klaim", "USD per klaim"),
                                 ("auc_skor_dikoreksi", "AUC skor peluang vs koreksi verifikator (0,5 = acak; hanya model berpeluang)"))]
        rows += [{"ukuran": "kappa berbobot (kedua model)", "saring": cal["kappa_berbobot"], "periksa": cal["kappa_berbobot"]},
                 {"ukuran": "setuju 3 kelas", "saring": cal["setuju_3_kelas"], "periksa": cal["setuju_3_kelas"]},
                 {"ukuran": "setuju wajar / bermasalah", "saring": cal["setuju_bermasalah"], "periksa": cal["setuju_bermasalah"]},
                 {"ukuran": "klaim layak tag (keduanya bermasalah, satu mencurigakan)", "saring": cal["layak_tag"], "periksa": cal["layak_tag"]},
                 {"ukuran": "proyeksi biaya telaah penuh (USD)", "saring": round(left_s * per_s, 2), "periksa": round(left_p * per_p, 2)}]
        if self.reference:
            rows.insert(0, {"ukuran": "kolom periksa", "saring": f"{s} (dipanggil)", "periksa": f"{c}: putusan tersimpan, rujukan (tidak dipanggil)"})
        rid = self.result(f"Telaah klinis {self.label}: kalibrasi {len(sample)} klaim", rows, {"kind": "telaah_kalibrasi"})
        rec = {"model": dict(self.models), "n": len(sample), "hasil": cal, "proyeksi_usd": projected, "terpakai_usd": round(self.spent, 4),
               "batas_usd": self.plan_limit, "lolos": not why, "alasan": why, "baru_saring": new_s, "rid": rid}
        try:
            await asyncio.to_thread(self._post, "/api/aip/telaah/kalibrasi/hasil", {"run_id": self.run_id, "rec": rec})
        except Exception as e:  # noqa: BLE001 - the numbers are in the trail either way
            emit({"type": "error", "agent": "telaah_klinis", "message": f"kalibrasi tidak tersimpan: {str(e)[:200]}"})
        emit({"type": "telaah", "tahap": "kalibrasi", **rec, "kappa": cal["kappa_berbobot"], "usd": round(self.spent, 4)})
        summary["kalibrasi"] = {**rec, "hasil": {k: cal[k] for k in ("kappa_berbobot", "setuju_3_kelas", "setuju_bermasalah", "layak_tag", "dikoreksi_di_sampel")},
                                "porsi_diperiksa_ulang": {"saring": rate, "periksa": cal["periksa"]["porsi_diperiksa_ulang"]}}
        if mode == "kalibrasi" or why:
            status = "kalibrasi" if mode == "kalibrasi" else "berhenti"
            return {**summary, "status": status if not self.halted else "berhenti", "alasan": why, "usd": round(self.spent, 4), "rid": rid}
        if self.reference:
            return await self.ranked(total, summary)

        # 2+3. the screen and the re-check side by side (the user, 2026-10-30: "complete it in about 60 minutes"): the screen's
        # examiners take the set from one queue fed page by page; every claim it does not find wajar, and a fixed random 5% of
        # the rest (the screen's miss rate), goes straight to the re-check's examiners, of the other family
        screened: dict[str, dict] = {}  # klaim_id -> {verdict, faskes, provinsi, inacbg}
        flagged: list[str] = []
        audit: set[str] = set()
        self.total["saring"], self.done["saring"] = total, 0
        self.total["periksa"], self.done["periksa"] = 0, 0
        self.counts = {k: 0 for k in TL.CONCLUSIONS}
        check = _Pool(self, "periksa")

        def route(row: dict, v: dict) -> None:
            k = row["klaim_id"]
            screened[k] = {"v": v, "faskes_profil_id": row.get("faskes_profil_id"), "provinsi": row.get("provinsi"), "inacbg_kode": row.get("inacbg_kode")}
            if v["kesimpulan"] in TL.RECHECK:
                flagged.append(k)
            elif int(hashlib.sha1(f"{TL.SEED}|audit|{k}".encode()).hexdigest()[:8], 16) < TL.AUDIT_SHARE * 0x100000000:
                audit.add(k)
            else:
                row.pop("fakta", None)  # read and done: its facts need not stay in memory
                return
            check.add([row])

        screen = _Pool(self, "saring", route)

        async def screening() -> None:
            await asyncio.gather(self.feed(screen, total), screen.run())
            check.closed = True

        await asyncio.gather(screening(), check.run())
        checked = check.out
        others = len(screened) - len(flagged)
        self.progress("saring", force=True)
        self.progress("periksa", force=True)

        # 4. the tags: both families see a problem, one calls it suspicious, a reason within its facts (the suspicious one's
        # first); always lemah, the review's own source
        agreed, no_reason = [], 0
        for k in flagged:
            p_ = checked.get(k)
            s_ = screened[k]["v"]
            if not p_ or not TL.tag_worthy(s_["kesimpulan"], p_["kesimpulan"]):
                continue
            order = (p_, s_) if p_["kesimpulan"] == TL.FLAG else (s_, p_)
            # a written reason within its facts: never Decisions' (it writes none, Blu 1.3)
            reason = next((x["alasan"] for x in order if not x.get("gerbang") and not x.get("tanpa_alasan")), "")
            if not reason:
                no_reason += 1
                continue
            agreed.append({"klaim_id": k, "judul": f"Klaim {k}", "faskes_profil_id": screened[k]["faskes_profil_id"], "provinsi": screened[k]["provinsi"],
                           "inacbg_kode": screened[k]["inacbg_kode"], "kesimpulan_saring": s_["kesimpulan"], "kesimpulan_periksa": p_["kesimpulan"],
                           "tag": order[0].get("tag") or order[1].get("tag") or "LAINNYA", "alasan": reason})
        tagged, refused, rids = 0, 0, []
        names = {seat: (aip_models.MODELS.get(m) or {}).get("label", m) for seat, m in self.models.items()}
        for i in range(0, len(agreed), 500):
            part = agreed[i:i + 500]
            rid_t = self.result(f"Telaah klinis {self.label}: klaim bermasalah menurut kedua model ({i + 1}–{i + len(part)})", part,
                                {"kind": "telaah_tag", "metric": "klaim_id", "label": "klaim_id"})
            rids.append(rid_t)
            body = {"run_id": self.run_id, "agen": TL.AGENT, "peran": f"Telaah klinis {self.label}", "model": self.models["periksa"], "entitas": "klaim",
                    "hasil_id": rid_t, "baris": [{"kunci": x["klaim_id"], "tag": x["tag"], "kekuatan": "lemah",
                                                  "bukti": (f"Telaah klinis {self.label}: {names['saring']} menilai {x['kesimpulan_saring']}, "
                                                            f"{names['periksa']} menilai {x['kesimpulan_periksa']}. {x['alasan']} [{rid_t}]")[:2000]} for x in part]}
            for attempt in range(3):  # the result file is written by the run's reader a moment after the event
                try:
                    r = await asyncio.to_thread(self._post, "/api/aip/indikasi/baris", body)
                    tagged += int(r.get("ditandai") or 0)
                    refused += int(r.get("ditolak_gerbang") or 0) + int(r.get("tidak_ada_di_hasil") or 0)
                    break
                except Exception as e:  # noqa: BLE001
                    if attempt == 2:
                        emit({"type": "error", "agent": "telaah_klinis", "message": f"tag telaah {rid_t} gagal ditulis: {str(e)[:200]}"})
                    await asyncio.sleep(2 * (attempt + 1))
        if tagged:
            emit({"type": "tag", "agent": TL.AGENT, "bulk": True, "tag": "telaah_klinis", "entitas": "klaim", "jumlah": tagged, "baru": tagged,
                  "kekuatan_agen": "lemah", "judul": f"{tagged} klaim bermasalah menurut kedua model", "bukti": f"telaah klinis {self.label}", "rid": rids[0] if rids else None})

        # 5. what the screen missed, on the random 5% the check read
        audited = [k for k in audit if k in checked]
        missed = sum(1 for k in audited if checked[k]["kesimpulan"] in TL.RECHECK)
        rest = others
        per = {k: sum(1 for x in screened.values() if x["v"]["kesimpulan"] == k) for k in TL.CONCLUSIONS}
        out = {**summary, "status": "berhenti" if self.halted else "selesai", "alasan": [self.halted] if self.halted else [],
               "ditelaah": len(screened), "kesimpulan_saring": per, "bukan_wajar_saring": len(flagged), "diperiksa_ulang": len(checked),
               "layak_tag": len(agreed) + no_reason, "tanpa_alasan_sah": no_reason, "tag": tagged, "tag_ditolak": refused,
               "sampel_audit": {"n": len(audited), "bermasalah_menurut_periksa": missed, "porsi": round(missed / len(audited), 4) if audited else None,
                                "ci95": TL.wilson(missed, len(audited)), "perkiraan_terlewat": round(missed / len(audited) * rest) if audited else None},
               "usd": round(self.spent, 4), "panggilan": dict(self.calls), "gagal": len(self.failed), "contoh_gagal": self.failed[:5],
               "ditolak_keluarga": self.refused_family}
        rows = [{"ukuran": k, "nilai": v if not isinstance(v, (dict, list)) else str(v)} for k, v in out.items()
                if k in ("status", "ditelaah", "kesimpulan_saring", "bukan_wajar_saring", "diperiksa_ulang", "layak_tag", "tag", "sampel_audit",
                         "usd", "panggilan", "gagal", "alasan")]
        out["rid"] = self.result(f"Telaah klinis {self.label}: ringkasan", rows, {"kind": "telaah_ringkasan"})
        out["rid_tag"] = rids
        emit({"type": "telaah", "tahap": "selesai", **{k: v for k, v in out.items() if k != "kalibrasi"}})
        return out
