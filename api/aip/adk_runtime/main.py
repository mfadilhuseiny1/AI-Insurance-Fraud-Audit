"""One run of the AIP JKN agents (started by aip/runs.py): the input as JSON on stdin, events as JSON lines on stdout.

A question ("ask") runs as: the orchestrator plans which domain agents it needs → those agents gather evidence side
by side (they only read) → the writer composes the answer → a validator on another model family re-checks its claims
against the data → one revision when a check fails → the UI composer picks the panels of the dynamic screen. A question
that needs no data (a greeting, how to use AIP JKN, a general term, outside JKN) the orchestrator answers in its plan,
without domain agents or a validator — when that answer holds no number (a code gate). Every step is an event the page
shows; the control flow here is plain code, the deterministic part.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import traceback
from typing import Any

import litellm
from google.adk.agents import LlmAgent, ParallelAgent
from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.adk.agents.run_config import RunConfig, ToolThreadPoolConfig
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from aip.adk_runtime import agents as A
from aip.adk_runtime import orkestrasi as O
from aip.adk_runtime import screens as S
from aip.adk_runtime import tools as T
from aip.adk_runtime.platform import Platform, emit

APP = "aip_jkn"
litellm.suppress_debug_info = True


# model calls one stage may make (each agent of a parallel group counts): the hard stop for an agent that keeps calling
MAX_LLM_CALLS = 14  # per agent and stage: 10 tool steps (tools.MAX_CALLS) and the answer, with room to spare
FAST_CALLS = 5  # tool steps per agent on the fast route (a read from the consultancy's box or one type)
MAX_TASKS = 16  # small agents a question may get (one per province, class, mode … it covers)
ML_AGENT = "machine_learning"  # the agent whose tool the inference pipeline is (a pasted claim is verified as its step)
AT_ONCE = 8  # small agents working at the same time (the gateway and Vertex share the load)


async def chat_stage(service: InMemorySessionService, agent: Any, text: str, calls: int = MAX_LLM_CALLS, threads: int = 0) -> dict:
    """stage() for a chat question: one agent failing (a timeout, a refused call, a broken import) is an error in the trail,
    not the end of the answer — the other agents' findings, the answer and its screen still come (three questions died
    this way on 2026-10-22/23). The consultancy keeps stage()'s raising: its recovery is built on it."""
    return await stage(service, agent, text, calls, threads, tolerant=True)


async def stage(service: InMemorySessionService, agent: Any, text: str, calls: int = MAX_LLM_CALLS, threads: int = 0, tolerant: bool = False) -> dict:
    """Run one agent (or a parallel group) to the end; its agents' final texts become events, the state comes back.
    threads: run the agents' (blocking) tools in a pool of that many threads, so many agents' stages share the loop
    (the consultancy); 0 runs them on the loop, one at a time."""
    runner = Runner(app_name=APP, agent=agent, session_service=service)
    s = await service.create_session(app_name=APP, user_id="aip")
    msg = types.Content(role="user", parts=[types.Part(text=text)])
    cfg = RunConfig(max_llm_calls=calls, tool_thread_pool_config=ToolThreadPoolConfig(max_workers=threads) if threads else None)
    try:
        async for ev in runner.run_async(user_id="aip", session_id=s.id, new_message=msg, run_config=cfg):
            if getattr(ev, "error_message", None):
                emit({"type": "error", "agent": ev.author, "message": ev.error_message})
            if ev.content and ev.content.parts and ev.is_final_response():
                txt = "".join(p.text or "" for p in ev.content.parts if getattr(p, "text", None))
                if txt.strip():
                    emit({"type": "text", "agent": ev.author, "text": txt[:6000]})
    except LlmCallsLimitExceededError:
        emit({"type": "error", "agent": getattr(agent, "name", ""), "message": f"batas {calls} panggilan model tercapai: tahap dihentikan, hasil yang ada dipakai"})
    except Exception as e:  # noqa: BLE001 - tolerant: the stage ends with what it has; otherwise the caller recovers
        if not tolerant:
            raise
        emit({"type": "error", "agent": getattr(agent, "name", ""), "message": f"{type(e).__name__}: {str(e)[:300]} — tahap dihentikan, hasil yang ada dipakai"})
    s = await service.get_session(app_name=APP, user_id="aip", session_id=s.id)
    return dict(s.state)


def _nest(box: T.Toolbox, service: InMemorySessionService, m: A.Models, roles: dict) -> None:
    """What a tool needs to form sub-agents: a nested stage on the run's session service, and the tools model."""
    box.spawn = lambda agent, text, calls: stage(service, agent, text, calls)
    box.llm = lambda name: m.llm(roles["tools"], name, 3000)


async def ask(inp: dict) -> None:
    p = Platform(inp["api"], inp.get("token", ""))
    m = A.Models(inp["api"], inp.get("token", ""), inp["run_id"])
    q, hist = inp["q"], inp.get("history") or []
    voice = bool(inp.get("voice"))  # asked in a voice conversation: the answer is read aloud
    cat = p.get("/api/aip/agents")
    roles = cat["roles"]
    box = T.Toolbox(p, cat)
    service = InMemorySessionService()
    _nest(box, service, m, roles)
    emit({"type": "run", "status": "started", "roles": roles,
          "agents": [{"key": a["key"], "name": a["name"], "object_types": [t["name"] for t in a["object_types"]]} for a in cat["agents"]]})

    # 0. a claim pasted as JSON is new: it is not in the data, and agents sent to find it fail and loop (seen 2026-10-23:
    # fifteen failed reads, an agent at its token limit, ten minutes). The inference pipeline answers it first — the
    # model, the rules, the clinical review — as evidence the plan, the writer and the validator all read; the agents
    # only add what the data knows around it (the code's and the diagnosis' peers). Detected by code, not by the model.
    pasted = _pasted_claims(q)
    verified: list[dict] = []
    if pasted:
        emit({"type": "stage", "stage": "verify", "agent": ML_AGENT, "model": "pipeline /verify (model.pkl + aturan + telaah klinis LLM)"})
        new_claim = box.wrap(ML_AGENT, "verifikasi_klaim_baru", lambda klaim: T.verify_new(box, klaim))
        for c in pasted:
            verified.append(await asyncio.to_thread(new_claim, klaim=c))
        # an agent that still asks the data for it gets the pipeline's answer, not a failed read (seen in the next run)
        box.pasted.update({str(v["klaim_id"]): v["hasil_id"] for v in verified if v.get("hasil_id")})
    q_plan = q + _pasted_note(verified) if verified else q

    # 1. the orchestrator's plan: which agents, which task each — on the rules version the plan names (tuned or the code's)
    rules = A.plan_rules(cat).get("label") or "bawaan (kode)"
    emit({"type": "stage", "stage": "plan", "agent": "orkestrator", "model": roles["planner"], "aturan": rules})
    st = await chat_stage(service, A.planner(m, cat, q_plan, hist, voice), q)
    try:
        plan = A.parse_json(st.get("rencana", ""))
    except ValueError:
        plan = {}
    direct = not verified and str(plan.get("jalur") or "").strip().lower() == "langsung" and str(plan.get("jawaban") or "").strip()
    if direct:
        # the gate is code, not the prompt: a direct answer holds no quantity (a number is a fact, and a fact needs a read)
        if not _quantities(str(plan["jawaban"])):
            _direct(plan, str(plan["jawaban"]).strip(), voice, rules)
            return
        emit({"type": "stage", "stage": "plan", "agent": "orkestrator", "model": roles["planner"], "note": "jawaban langsung memuat angka: dialihkan ke agen"})
    tasks = [t for t in plan.get("tugas") or [] if t.get("agen") in box.agents and t.get("instruksi")][:MAX_TASKS]
    # an agent that forms its own sub-agents (the ML agent: one per technique, the same folds, the corrected paired test)
    # takes its part as ONE task: split into small agents, the techniques ran apart and could not be compared (e2e,
    # 2026-10-23, once the planner stopped thinking aloud)
    for owner in {k for k, a in box.agents.items() if "bentuk_sub_agen_teknik" in (a.get("tools") or [])}:
        mine = [t for t in tasks if t["agen"] == owner]
        if len(mine) > 1:
            first = tasks.index(mine[0])
            merged = {**mine[0], "cakupan": "", "instruksi": "\n".join(f"- {t['instruksi']}" for t in mine)}
            tasks = [t for t in tasks if t["agen"] != owner]
            tasks.insert(min(first, len(tasks)), merged)
    # the audit route (the user, 2026-10-24: read the consultancy's work, do not redo it for each question): a fraud question
    # about one scope is answered from the audit pack — code cuts the consultancy's tags, box and loss rule to the scope in
    # one read, with what its analysts concluded — and at most two agent tasks for what the pack does not hold
    # (a comparison of several scopes — provinces, modes, classes — is a list: a pack per scope, side by side)
    asked = plan.get("audit") if str(plan.get("jalur") or "").strip().lower() == "audit" and not verified else None
    scopes = [x for x in (asked if isinstance(asked, list) else [asked]) if isinstance(x, dict)][:6] if asked is not None else []
    scope = scopes[0] if scopes else None
    if scope is not None:
        tasks = tasks[:2]
    if not tasks and not verified and scope is None:  # a plan that names no known agent: the claims agent takes the question as it is
        default = next((k for k in box.agents if k.startswith("klaim")), next(iter(box.agents)))
        tasks = [{"agen": default, "instruksi": q}]
    skills = cat.get("skills") or []
    for t in tasks:  # the skill the orchestrator assigned, or the one that fits the agent
        if not O.skill_of(skills, str(t.get("skill") or "")):
            t["skill"] = next((s["key"] for s in skills if s.get("alur") == "tanya_jawab" and t["agen"] in (s.get("agen") or [])), "umum")
    # a follow-up drills into the set the conversation is on: code, not the prompt, drops the national comparators it did not ask for
    pledged = plan.get("kontrak")
    if inp.get("follow"):
        tasks, pledged, dropped = O.drill(q, tasks, pledged)
        if dropped:
            emit({"type": "stage", "stage": "plan", "agent": "orkestrator", "model": roles["planner"],
                  "note": f"{dropped} tugas pembanding nasional dibuang: pertanyaan lanjutan memperdalam himpunan sebelumnya"})
    # the validation contract: written now, before any worker starts (the orchestration concept)
    contract = O.contract_of(pledged)
    ctext = O.contract_text(contract)
    # an owner with several tasks works through small agents, one per task (its tools, its permissions)
    per_owner: dict[str, int] = {}
    for t in tasks:
        per_owner[t["agen"]] = per_owner.get(t["agen"], 0) + 1
    seen: dict[str, int] = {}
    for t in tasks:
        owner = t["agen"]
        if per_owner[owner] > 1:
            seen[owner] = seen.get(owner, 0) + 1
            t["kunci"] = f"{owner}__{seen[owner]}"
            box.owner_of[t["kunci"]] = owner
        else:
            t["kunci"] = owner
        t["cakupan"] = str(t.get("cakupan") or "").strip()[:60]
    # the route (user, 2026-10-23: sort the questions that need the whole workflow from those the fraud consultancy's data
    # answers by reading): the planner says "cepat", the code holds it to at most two tasks, no pasted claim, no ML; a fast
    # answer is validated from what the agents read, in one call that still thinks
    fast = (str(plan.get("jalur") or "").strip().lower() == "cepat" and len(tasks) <= 2 and not verified
            and not any("kartu_model_ml" in (box.agents[t["agen"]].get("tools") or []) for t in tasks))
    if fast:  # a read needs a few steps; the full ten were spent every time, 53–89 s of evidence
        for t in tasks:
            box.limits[t["kunci"]] = FAST_CALLS
    # a follow-up drills into what the conversation is about (that province, that faskes): its screen leads with it
    focus = [f for f in (str(x).strip() for x in plan.get("fokus") or []) if f and not f.startswith("<")][:3] if inp.get("follow") else []
    # a follow-up's audit scope holds the code its focus names (the plan kept the LOS-extreme set and lost O-6-10-I, the code
    # the answer before had named, 2026-10-24)
    if scope is not None and not scope.get("inacbg_kode"):
        code = next((f.upper() for f in focus if re.fullmatch(r"[A-Z]-\d-\d{2}-(?:0|I{1,3})", f.strip().upper())), None)
        if code:
            scope["inacbg_kode"] = code
    emit({"type": "plan", "summary": plan.get("ringkasan") or "", "tasks": [{**t, "name": box.agents[t["agen"]]["name"]} for t in tasks],
          "kontrak": contract, "skills": sorted({t["skill"] for t in tasks}), "jalur": "audit" if scope is not None else "cepat" if fast else "agen",
          "fokus": focus, "aturan": rules, **({"audit": scopes if len(scopes) > 1 else scope} if scope is not None else {})})

    # 2a. the audit pack: one deterministic read (a pack with no claims, or one that failed, leaves the question to the claims agent)
    packs: list[dict] = []
    if scope is not None:
        owner = next((k for k, a in box.agents.items() if any(t["name"] == T.CLAIMS_TYPE for t in a["object_types"])), next(iter(box.agents)))
        emit({"type": "stage", "stage": "evidence", "agents": ["Paket audit AI Agent Swarm"], "model": "kode (deterministik)", "note": "paket audit"})
        reader = box.wrap(owner, "paket_audit", lambda **kw: T.audit_pack(box, owner, kw))
        got = await asyncio.gather(*(asyncio.to_thread(reader, **{k: v for k, v in x.items() if k in T.PACK_SCOPE}) for x in scopes))
        packs = [g for g in got if not g.get("error") and g.get("klaim")]
        if not packs:
            why = next((str(g["error"])[:160] for g in got if g.get("error")), "")
            emit({"type": "stage", "stage": "evidence", "agent": owner, "model": roles["tools"],
                  "note": f"paket audit {'gagal: ' + why if why else 'tanpa klaim yang cocok'} — agen klaim membaca"})
            if not any(t["agen"] == owner for t in tasks):
                tasks.append({"agen": owner, "instruksi": q, "kunci": owner, "cakupan": "",
                              "skill": next((s["key"] for s in skills if s.get("alur") == "tanya_jawab" and owner in (s.get("agen") or [])), "umum")})

    # 2. evidence: the small agents side by side (they only read; writes are proposals)
    subs: list[tuple[dict, LlmAgent]] = []
    for t in tasks:
        a = box.agents[t["agen"]]
        me = {**a, "key": t["kunci"], "name": a["name"] + (f" · {t['cakupan']}" if t["kunci"] != t["agen"] and t["cakupan"] else "")}
        subs.append((t, A.domain_agent(m, me, t["instruksi"], T.tools_for(box, me), roles["tools"], O.skill_block(skills, t["skill"]), ctext, O.HANDOFF_ASK)))
    for owner, n in per_owner.items():
        if n > 1:
            emit({"type": "subagents", "parent": owner, "kind": "agen_kecil",
                  "agents": [{"key": t["kunci"], "name": f"Agen kecil · {t['cakupan'] or t['kunci']}", "technique": t["cakupan"] or t["kunci"], "family": "agen kecil"}
                             for t in tasks if t["agen"] == owner]})
    emit({"type": "stage", "stage": "evidence", "agents": [ag.name for _, ag in subs], "model": roles["tools"], "agen_kecil": len(subs)})
    if not subs:  # a pasted claim the pipeline already answered, and nothing around it the plan wanted from the data
        found = {}
    elif len(subs) <= 3 and not box.owner_of:  # the few agents of a simple question: one parallel stage, as always
        # (in a pool: the reads an agent asks for in one step run side by side, not one after the other)
        st = await chat_stage(service, ParallelAgent(name="bukti", sub_agents=[ag for _, ag in subs]) if len(subs) > 1 else subs[0][1], q, MAX_LLM_CALLS * len(subs),
                              threads=8)
        found = {t["kunci"]: st.get(f"temuan_{t['kunci']}") for t, _ in subs}
    else:
        gate = asyncio.Semaphore(AT_ONCE)

        async def one(t: dict, ag: LlmAgent) -> tuple[str, Any]:
            async with gate:
                s = await chat_stage(service, ag, t["instruksi"], MAX_LLM_CALLS, threads=16)
                return t["kunci"], s.get(f"temuan_{t['kunci']}")
        found = dict(await asyncio.gather(*(one(t, ag) for t, ag in subs)))
        for owner, n in per_owner.items():
            if n > 1:
                emit({"type": "subagents_done", "parent": owner, "agents": [t["kunci"] for t in tasks if t["agen"] == owner]})
    # every worker hands off in one structure; the report goes to the writer, the handoff to the shared state
    handoffs: dict[str, dict] = {}
    findings: dict[str, str] = {}
    for t in tasks:
        raw = found.get(t["kunci"]) or ""
        report, h = O.handoff(t["kunci"], raw, box.receipts.get(t["kunci"], []), O.skill_of(skills, t["skill"]), t.get("cakupan") or t["instruksi"],
                              "" if raw.strip() else "agen berhenti sebelum menulis temuannya")
        handoffs[t["kunci"]] = h
        O.emit_handoff(h)
        name = box.agents[t["agen"]]["name"] + (f" · {t['cakupan']}" if t["kunci"] != t["agen"] and t["cakupan"] else "")
        undone = "; ".join(h["left_undone"])
        findings[name] = ((report or "(tidak ada temuan)") + (f"\nBelum dikerjakan: {undone}" if undone else ""))[:4000]
    for v in verified:  # the pipeline's answer on each pasted claim, first among the findings
        findings[f"Pipeline /verify · klaim {v.get('klaim_id') or ''}"] = _verified_text(v)
    if packs:  # the audit pack first: the figures the answer is built on (a comparison: the table, then each scope's pack, shorter)
        if len(packs) > 1:
            _, line = T.compare_packs(box, packs)
            text = line + "\n\n" + "\n\n".join(f"### {x['cakupan']}\n{x['teks'][:3500]}" for x in packs)
        else:
            text = packs[0]["teks"]
        findings = {"Paket audit AI Agent Swarm (kode, dari tag, Box Karantina dan klaim berisiko)": text[:18000], **findings}

    # 3. the answer
    emit({"type": "stage", "stage": "write", "agent": "orkestrator", "model": roles["writer"]})  # the lead that planned writes the answer
    # a follow-up builds on the answer before it (on screen above this one): the writer adds what is new, not the same briefing again
    previous = next((h["text"] for h in reversed(hist) if h.get("role") == "assistant"), "") if inp.get("follow") else ""
    st = await chat_stage(service, A.writer(m, roles["writer"], q, findings, plan.get("ringkasan") or "", voice=voice, contract=ctext, previous=previous, brief=fast,
                                                 focus=focus), q)
    raw = st.get("jawaban") or ""
    # the writer failed, echoed its prompt, or wrote a briefing no repair could read: the agents' findings as they reported them
    if not raw.strip() or A.placeholder(raw) or (raw.lstrip().startswith("{") and not voice and not A.briefing_of(raw)):
        raw = "Jawaban belum bisa disusun penulis; temuan agen apa adanya:\n\n" + "\n\n".join(f"### {k}\n{v}" for k, v in findings.items())
    # a citation of a result this run does not have is dropped by code, not sent back for a revision (a lineage answer citing
    # an [r8] that no read produced was revised for 109 s, 2026-10-24)
    answer, checked = _written(_cited_only(raw, {r["rid"] for r in box.index}), voice)

    # 4a. the scrutiny validator: plain code, before the adversarial one
    emit({"type": "stage", "stage": "scrutiny", "agent": "scrutiny", "model": "kode (deterministik)"})
    # (a follow-up may repeat the answer before it: "354 klaim O-6-10-I" was that answer's figure)
    scrut = O.scrutiny(checked, tasks, handoffs, box.index, box.rows, q, box.quoted + "\n" + previous)
    if voice:  # three spoken sentences cannot name every scope: nothing blocks a spoken answer
        for c in scrut:
            c["blok"] = False
    O.emit_scrutiny(scrut, "jawaban")
    unsourced = next((c.get("angka_tidak_ditemukan") for c in scrut if c.get("angka_tidak_ditemukan")), None)

    # the depth a question gets (the user, 2026-10-24: "is each question need same level of comprehensive analysis?"; a
    # lookup took as long as an analysis, ~2 min): a fast read whose every number the code traced to what the agents read,
    # every [rN] a result of this run and every scope named, is checked — the thinking validator is for an analysis, or
    # for a fast read the code found something in. A lookup gets no executive summary; an analysis gets it written while
    # the validator works, kept when the answer stands
    light = (fast or bool(packs)) and all(c["ok"] for c in scrut) and not unsourced
    plain_wanted = bool(not voice and not fast and roles.get("awam") and len(O.numbers(checked)) >= 2)
    plain_draft = asyncio.create_task(_plain_text(service, m, roles["awam"], q, checked)) if plain_wanted else None
    drafted = checked

    # 4. adversarial validation, on a model family other than the writer's, thinking. A chat answer is wanted in about a
    # minute (user, 2026-10-23; the validator re-reading the data took 72–320 s, 177 s for one derived sum): it judges the
    # answer against what the agents read, in one call, with the numbers the scrutiny code could not trace named for it.
    # Only when the agents read nothing does it read the data itself, three reads at most.
    read = [s for k, reads in box.seen.items() if k != "validator" for s in reads]
    reread = not read
    emit({"type": "stage", "stage": "validate", **({"agent": "scrutiny", "model": "kode (deterministik)", "note": ("paket audit" if packs else "jalur cepat") + ": angka dicek kode"} if light
                                                   else {"agent": "validator", "model": roles["validator"], **({} if reread else {"note": "dari bacaan agen"})})})
    seen: list[dict] = []
    if light:
        checks = [{"id": f"s{i}", "klaim": c["klaim"], "ok": c["ok"], "bukti": c["bukti"]} for i, c in enumerate(scrut, 1)]
        judged = [{**c, "ok": None, "bukti": ("paket audit" if packs else "jalur cepat") + ": tidak dinilai validator model; setiap angka jawaban dicek kode terhadap yang dibaca"}
                  for c in contract]
    elif reread:
        box.limits["validator"] = 3
        vtools = T.object_tools(box, "validator", any_owner=True, read_only=True)
        if any(t["agen"] == "data" for t in tasks):
            vtools += T.platform_tools(box, "validator")
        if any("kartu_model_ml" in (box.agents[t["agen"]].get("tools") or []) for t in tasks):
            vtools += T.ml_tools(box, "validator", read_only=True)  # it checks the ML numbers against the card, without re-running
        # (q_plan: with a pasted claim, the pipeline's answer it was given is part of what the validator holds the answer to)
        st = await chat_stage(service, A.validator(m, roles["validator"], q_plan, checked, vtools, list({t["agen"]: box.agents[t["agen"]] for t in tasks}.values()),
                                              ctext, ", ".join(unsourced or []), _sources(box)), q)
        try:
            verdict = A.parse_json(st.get("verdict", ""))
        except ValueError:
            verdict = {}
        checks = O.clean_checks(verdict.get("checks"))
        judged = _contract_verdict(contract, verdict.get("kontrak"))
        seen = box.seen.get("validator") or []
    else:
        st = await chat_stage(service, A.validator_verdict(m, roles["validator"], q_plan, checked, _evidence(read[-30:]), ctext, claims=bool(contract),
                                                      agents_read=True, unsourced=", ".join(unsourced or [])), q)
        try:
            verdict = A.parse_json(st.get("verdict", ""))
        except ValueError:
            verdict = {}
        checks = [c for c in O.clean_checks(verdict.get("checks")) if not str(c.get("id", "")).startswith("k")]
        judged = _contract_verdict(contract, verdict.get("kontrak") or [c for c in verdict.get("checks") or [] if str(c.get("id", "")).startswith("k")])
    if not checks and seen:
        # it read the data but its turn ended without a verdict: the verdict from what those reads returned
        evidence = _evidence(seen)
        emit({"type": "stage", "stage": "validate", "agent": "validator", "model": roles["validator"], "note": "putusan dari hasil pemeriksaan"})
        st = await chat_stage(service, A.validator_verdict(m, roles["validator"], q_plan, checked, evidence, ctext), q)
        try:
            verdict = A.parse_json(st.get("verdict", ""))
        except ValueError:
            verdict = {}
        checks = [c for c in O.clean_checks(verdict.get("checks")) if not str(c.get("id", "")).startswith("k")]
        judged = _contract_verdict(contract, verdict.get("kontrak") or [c for c in verdict.get("checks") or [] if str(c.get("id", "")).startswith("k")])
    failed = [c for c in checks if not c.get("ok")]
    broken = [c for c in judged if c["ok"] is False]
    emit({"type": "verdict", "validator": "kode" if light else "validator", "model": "kode (deterministik)" if light else roles["validator"], "checks": checks,
          "passed": len(checks) - len(failed), "total": len(checks), "steps": box.receipts.get("validator", []), "kontrak": judged})

    # 5. one revision when a checked claim or a blocking scrutiny check did not hold. A contract statement left unmet alone
    # does not rewrite a chat answer (it shows on the contract card): every run was being revised, 27–146 s each
    blocked = [c for c in scrut if c["blok"] and not c["ok"]]
    if failed or blocked:
        emit({"type": "stage", "stage": "revise", "agent": "orkestrator", "model": roles["writer"]})
        fix = failed + [{"kontrak": c["id"], "pernyataan": c["teks"], "bukti": c.get("bukti")} for c in broken] + \
            [{"scrutiny": c["klaim"], "bukti": c["bukti"]} for c in blocked]
        st = await chat_stage(service, A.writer(m, roles["writer"], q, findings, plan.get("ringkasan") or "", json.dumps(fix, ensure_ascii=False), voice, ctext, previous, fast,
                                                     focus=focus), q)
        # shown and spoken now, not after the screen; a revision that came back empty or as the prompt's shape keeps the first answer
        if st.get("jawaban") and not A.placeholder(st["jawaban"]):
            answer, checked = _written(_cited_only(st["jawaban"], {r["rid"] for r in box.index}), voice, revised=True)

    # 6. the dynamic screen: the dashboard template that fits what this run found, filled with its results (no model)
    emit({"type": "stage", "stage": "ui", "agent": "penyusun_layar", "model": roles["ui"]})
    spec = S.compose(q, checked, set(re.findall(r"\br\d+\b", checked)), box.index, box.rows, focus, "audit" if packs else None)
    for panel in spec["panels"]:  # a detail table shows the search's rows, not the one an agent glanced at
        wide = T.widen(box, panel["rid"]) if panel["widget"] == "table" else None
        if wide:
            n = len(box.rows.get(wide) or [])
            panel["rid"], panel["insight"] = wide, re.sub(r"\b[\d.]+ diambil", f"{n} ditampilkan", panel["insight"] or "")
    emit({"type": "ui_spec", "spec": spec})
    emit({"type": "answer", "text": answer, "checks": {"passed": len(checks) - len(failed), "total": len(checks), "revised": bool(failed or blocked),
                                                       "kontrak": {"terpenuhi": sum(c["ok"] is True for c in judged), "total": len(judged)}}})

    # 6b. plain words for leaders (the user, 2026-10-24): the validated briefing retold by another model, every number
    # checked by code against the briefing. Written beside the validator; a revised briefing is retold again
    if plain_draft:
        if checked != drafted:
            plain_draft.cancel()
        emit({"type": "stage", "stage": "awam", "agent": "penjelas_pimpinan", "model": roles["awam"]})
        try:
            emit(await (_plain_text(service, m, roles["awam"], q, checked) if checked != drafted else plain_draft))
        except Exception as e:  # noqa: BLE001 - the answer stands without it
            emit({"type": "error", "agent": "penjelas_pimpinan", "message": f"executive summary gagal: {type(e).__name__}: {str(e)[:200]}"})

    # 7. learning: what the validators caught becomes a lesson of the skill involved (new task → … → encode skill)
    issues = O.issues_for_learning(failed + [{"klaim": f"kontrak {c['id']}: {c['teks']}", "bukti": c.get("bukti"), "ok": False} for c in broken]
                                   + [c for c in scrut if not c["ok"]], list(handoffs.values()))
    await O.encode_lessons(chat_stage, service, m, roles["planner"], inp["run_id"], p, [t["skill"] for t in tasks], issues)


async def _plain_text(service: InMemorySessionService, m: A.Models, model: str, q: str, briefing: str) -> dict:
    """The briefing for leaders who are not technical: what it means, how big in everyday measures, what to decide — the
    event to emit. A sentence whose number the briefing does not give (or that code cannot recompute from it) is dropped
    and named."""
    st = await chat_stage(service, A.plain(m, model, q, briefing), "Ceritakan ulang untuk pimpinan.", 2)
    try:
        got = A.parse_json(st.get("awam", ""))
    except ValueError:
        got = None
    if not isinstance(got, dict):
        return {"type": "error", "agent": "penjelas_pimpinan", "message": "executive summary tidak terbaca; structuring tetap berlaku"}
    dropped: list[dict] = []

    def keep(text: str, part: str) -> bool:
        why = O.plain_check(text, briefing)
        if why:
            dropped.append({"bagian": part, "teks": text[:400], "alasan": why})
        return not why

    point = str(got.get("intinya") or "").strip()
    figures = [x for x in got.get("angka") or [] if isinstance(x, dict) and str(x.get("artinya") or "").strip()]
    return {"type": "awam", "model": model, "intinya": point[:600] if point and keep(point, "intinya") else "",
            "angka": [{"angka": str(x.get("angka") or "")[:60], "artinya": str(x["artinya"])[:500]} for x in figures
                      if keep(f"{x.get('angka') or ''} — {x['artinya']}", "angka")][:4],
            "keputusan": [str(x)[:300] for x in got.get("keputusan") or [] if isinstance(x, str) and x.strip() and keep(x, "keputusan")][:3],
            "hati_hati": [str(x)[:300] for x in got.get("hati_hati") or [] if isinstance(x, str) and x.strip() and keep(x, "hati_hati")][:2],
            "dibuang": dropped}


def _pasted_claims(q: str) -> list[dict]:
    """Claims pasted into the question as JSON — the judges' flat format (claim_id …) or the claims contract
    (kunjungan_fkrtl_id …): new claims, not in the data. Up to five."""
    out: list[dict] = []
    dec, i = json.JSONDecoder(), 0
    while len(out) < 5:
        i = q.find("{", i)
        if i < 0:
            break
        try:
            obj, end = dec.raw_decode(q, i)
        except ValueError:
            i += 1
            continue
        if isinstance(obj, dict) and ("claim_id" in obj or "kunjungan_fkrtl_id" in obj):
            out.append(obj)
        i = end
    return out


def _pasted_note(verified: list[dict]) -> str:
    """What the plan (and the validator) read about the pasted claims: verified already, not in the data, what the agents
    may still add."""
    lines = [f"- [{v['hasil_id']}] {v.get('ringkasan')}" if v.get("hasil_id") else f"- tidak terverifikasi: {v.get('error')}" for v in verified]
    return ("\n\nKLAIM BARU ditempel sebagai JSON — tidak ada di data Nexus. Pipeline /verify (model ML + aturan + telaah klinis) sudah "
            "menilainya:\n" + "\n".join(lines) + "\nJangan menugaskan agen mencari klaim ini di data. Tugaskan agen hanya untuk konteks pembanding "
            "yang menambah nilai (mis. statistik kode INA-CBG dan diagnosisnya di data; kode diagnosis di data ditulis tanpa titik, mis. A419, "
            "kategori A41), atau tanpa tugas (\"tugas\": []) bila hasil /verify sudah menjawab pertanyaan.")


def _verified_text(v: dict) -> str:
    """The pipeline's answer on a pasted claim, as a finding the writer cites ([rN])."""
    if not v.get("hasil_id"):
        return f"Verifikasi gagal: {v.get('error')}"
    tl = v.get("telaah_klinis") or {}
    parts = [f"[{v['hasil_id']}] status {v.get('status')} ({v.get('status_label')}); peluang koreksi menurut model {v.get('peluang_koreksi_pct')}%"
             + (f" ({v['arti_peluang']})" if v.get("arti_peluang") else ""),
             f"Telaah klinis: {tl.get('label')} (keyakinan {tl.get('keyakinan')}): {tl.get('ringkasan')}",
             "Kejanggalan: " + "; ".join(tl.get("kejanggalan") or []) if tl.get("kejanggalan") else "",
             "Penjelasan wajar: " + "; ".join(tl.get("penjelasan_wajar") or []) if tl.get("penjelasan_wajar") else "",
             "Dokumen yang perlu diperiksa: " + "; ".join(tl.get("dokumen_diperiksa") or []) if tl.get("dokumen_diperiksa") else "",
             f"Tag aturan: {v['tag_aturan']}" if v.get("tag_aturan") else "",
             f"Alasan model (TreeSHAP): {v['alasan_model']}" if v.get("alasan_model") else "",
             "Batas data: " + " · ".join(v.get("peringatan") or []) if v.get("peringatan") else ""]
    return "\n".join(x for x in parts if x)[:4000]


def _quantities(text: str) -> list[str]:
    """The quantities in a direct answer: numbers standing alone (counts, shares, rupiah, years) — not a list's numbering
    ("1."), not part of a name or code (ICD-10, A41.9, COVID-19, Q-5-44-0), not inside quotes (an example question is not
    a claim: seen 2026-10-23, "… per 1.000 klaim?" sent a redirect to the claims agent)."""
    t = re.sub(r'"[^"]*"|“[^”]*”', "", text)
    t = re.sub(r"(?m)^\s*\d+[.)]\s", "", t)
    t = re.sub(r"\b(?=[\w.-]*[A-Za-z])(?=[\w.-]*\d)[\w.-]+", "", t)
    return re.findall(r"\d+(?:[.,]\d+)*", t)


def _direct(plan: dict, text: str, voice: bool, rules: str = "") -> None:
    """A question that needs no data (a greeting, how to use AIP JKN, a general term, outside JKN): the orchestrator's
    answer from its plan, without domain agents or a validator — nothing was read, so there is nothing for them to check.
    One model call instead of about eleven; the gate that let it through (no number) is shown as a scrutiny check."""
    emit({"type": "plan", "summary": plan.get("ringkasan") or "jawaban langsung", "tasks": [], "kontrak": [], "skills": [], "jalur": "langsung",
          "aturan": rules})
    O.emit_scrutiny([{"klaim": "jawaban langsung tanpa angka (setiap angka butuh bacaan agen)", "ok": True, "blok": True,
                      "bukti": "pertanyaan tidak butuh data platform; jawaban tidak memuat angka"}], "jawaban")
    answer, _ = _written(text, voice)
    emit({"type": "answer", "text": answer, "jalur": "langsung",
          "checks": {"passed": 0, "total": 0, "revised": False, "kontrak": {"terpenuhi": 0, "total": 0}}})


def _contract_verdict(contract: list[dict], judged: Any) -> list[dict]:
    """Each contract statement with the validator's verdict on it (None when it gave none)."""
    by_id = {str(c.get("id")): c for c in judged or [] if isinstance(c, dict)}
    return [{**c, "ok": (by_id[c["id"]].get("ok") if isinstance(by_id[c["id"]].get("ok"), bool) else None) if c["id"] in by_id else None,
             "bukti": O.as_text((by_id.get(c["id"]) or {}).get("bukti"))[:600]} for c in contract]


def _cited_only(raw: str, known: set[str]) -> str:
    """The writer's text with only the citations of this run's results: [r8] of no read goes, [r2, r8] keeps [r2]."""
    def keep(m: re.Match) -> str:
        ids = [x for x in re.findall(r"r\d+", m.group(2)) if x in known]
        return f"{m.group(1)}[{', '.join(ids)}]" if ids else ""
    return re.sub(r"(\s?)\[(\s*r\d+(?:\s*[,/;]\s*r\d+)*\s*)\]", keep, raw or "")


# the verification's status codes are words for the reader (the writer copied "PERLU_DIPERIKSA" into an answer, 2026-10-27)
STATUS_WORDS = {"INDIKASI_KUAT": "indikasi kuat", "PERLU_DIPERIKSA": "perlu diperiksa", "WAJAR": "wajar"}


def _status_words(text: str) -> str:
    return re.sub(r"\b(?:INDIKASI_KUAT|PERLU_DIPERIKSA)\b|(?<=status )WAJAR\b|(?<=menetapkan )WAJAR\b", lambda m: STATUS_WORDS[m.group(0)], text)


def _written(raw: str, voice: bool, revised: bool = False) -> tuple[str, str]:
    """(the answer's text, what the validator checks): a briefing when the writer gave one — emitted for the page, its
    every number checked — else the text as written (voice, or a model that answered in prose)."""
    raw = _status_words(raw)
    briefing = None if voice else A.briefing_of(raw)
    if briefing:
        emit({"type": "briefing", "briefing": briefing, **({"revised": True} if revised else {})})
        text = briefing["jawaban"] or A.briefing_text(briefing)
        emit({"type": "draft", "text": text, **({"revised": True} if revised else {})})
        return text, A.briefing_text(briefing)
    emit({"type": "draft", "text": raw, **({"revised": True} if revised else {})})
    return raw, raw


# ------------------------------------------------------------------------------------------------ missions (aip/missions.py)


def _setup(inp: dict) -> tuple[Platform, A.Models, dict, T.Toolbox, InMemorySessionService]:
    p = Platform(inp["api"], inp.get("token", ""))
    cat = p.get("/api/aip/agents")
    m, box, service = A.Models(inp["api"], inp.get("token", ""), inp["run_id"]), T.Toolbox(p, cat), InMemorySessionService()
    _nest(box, service, m, cat["roles"])
    return p, m, cat, box, service


async def mission_plan(inp: dict) -> None:
    """The orchestrator turns a goal into milestones, tasks (each owned by a domain agent) and a validation contract."""
    p, m, cat, box, service = _setup(inp)
    roles = cat["roles"]
    emit({"type": "stage", "stage": "mission_plan", "agent": "orkestrator", "model": roles["planner"]})
    agents = "\n".join(f"- {a['key']}: {a['name']} — objek: {', '.join(t['name'] for t in a['object_types']) or 'platform'}" for a in cat["agents"])
    text = f"""Anda Orkestrator AIP JKN. Susun rencana misi audit untuk tujuan ini: {inp['q']}
Agen dan objek tanggung jawabnya:
{agents}
Skill (prosedur kerja) yang bisa Anda tetapkan untuk tiap tugas:
{O.skills_menu(cat.get("skills") or [], "tanya_jawab") or '- umum: tugas umum'}

Rencana: 1–3 milestone; tiap milestone 1–4 tugas, tiap tugas dikerjakan SATU agen pemilik objeknya, satu per satu (serial).
Tugas harus bisa dikerjakan dengan membaca objek Nexus (cari, agregasi, detail, fungsi) dan diakhiri dengan temuan.
Kontrak validasi: 3–6 pernyataan yang harus benar agar misi dianggap selesai dengan benar, ditulis sebelum pekerjaan dimulai
(mis. "Setiap klaim yang direkomendasikan ditahan menyebut alasan dan perbandingan peer-nya", "Angka total klaim berisiko per
provinsi sama dengan objek Provinsi (BPJS)", "Tidak ada data identitas peserta di keluaran").
Jawab HANYA JSON:
{{"summary": "<rencana satu kalimat>", "milestones": {{"M1": "<judul>"}}, "tasks": [{{"milestone": "M1", "agent": "<key agen>", "skill": "<key skill>",
"title": "<judul singkat>", "instruction": "<instruksi tugas>"}}], "contract": ["<pernyataan>"]}}"""
    st = await stage(service, LlmAgent(name="orkestrator", model=m.llm(roles["planner"], "orkestrator", 6000, think="deep"), instruction=A._const(text),
                                       output_key="rencana"), inp["q"], 2)
    try:
        plan = A.parse_json(st.get("rencana", ""))
    except ValueError:
        raise RuntimeError("the orchestrator gave no readable plan") from None
    plan["tasks"] = [t for t in plan.get("tasks") or [] if t.get("agent") in box.agents and t.get("instruction")][:12]
    if not plan["tasks"]:
        raise RuntimeError("the plan names no known agent")
    emit({"type": "mission_plan", "plan": plan})


async def mission_task(inp: dict) -> None:
    """One task in a fresh context: the mission state and earlier handoffs in, findings and a structured handoff out."""
    p, m, cat, box, service = _setup(inp)
    task = inp["task"]
    a = box.agents[task["agent"]]
    prior = "\n".join(f"- {h.get('task')} ({h.get('agent')}): {str(h.get('implemented', ''))[:500]}" for h in inp.get("handoffs") or [])
    contract = "\n".join(f"- {c['id']}: {c['text']}" for c in inp.get("contract") or [])
    full_task = f"""Misi: {inp['mission']['goal']}
Kontrak validasi misi (yang akan diperiksa validator):
{contract or '-'}
Handoff tugas sebelumnya:
{prior or '- (tugas pertama)'}
TUGAS ANDA ({task['id']}, {task['milestone']}): {task['instruction']}"""
    tools = T.tools_for(box, a)
    model = A.pick("batch")  # missions are not waited on: the cheaper model of the batch role
    skills = cat.get("skills") or []
    skill = O.skill_of(skills, str(task.get("skill") or "")) or next((s for s in skills if s.get("alur") == "tanya_jawab" and a["key"] in (s.get("agen") or [])),
                                                                     O.skill_of(skills, "umum"))
    emit({"type": "stage", "stage": "mission_task", "agent": f"agen_{a['key']}", "model": model, "task": task["id"], "skill": (skill or {}).get("key")})
    st = await stage(service, A.domain_agent(m, a, full_task, tools, model, O.skill_block(skills, (skill or {}).get("key", "")), "", O.HANDOFF_ASK),
                     task["instruction"])
    found = st.get(f"temuan_{a['key']}") or ""
    receipts = box.receipts.get(a["key"], [])
    stopped = not found.strip()
    if stopped:  # the stage stopped before the agent wrote its findings: what its steps established, said plainly
        found = "Tidak ada temuan akhir: tugas berhenti sebelum agen menulis temuannya. Langkah yang sudah dijalankan: " +                 "; ".join(f"{r['tool']} → {r['summary']}" for r in receipts)
    limit = "tugas berhenti di batas panggilan model sebelum temuan ditulis" if stopped \
        else "batas langkah tool tercapai sebelum tugas selesai" if box.calls.get(a["key"], 0) > T.MAX_CALLS else ""
    report, h = O.handoff(f"agen_{a['key']}", found, receipts, skill, task["instruction"], limit)
    handoff = {
        "implemented": report[:4000],
        "left_undone": "; ".join(h["left_undone"]),
        "queries_run": [{"tool": r["tool"], "args": r["args"], "ok": r["ok"], "rows": r.get("rows"), "rid": r.get("rid"), "ms": r["ms"]} for r in receipts],
        "issues_found": h["issues_found"],
        "procedures_followed": [f"{c['prosedur']} {'✓' if c['ok'] else '✗'}" for c in h["procedures_followed"]["cek"]] +
                               ["dibaca sebagai pengguna pemilik misi (izin & marking berlaku)", "tidak ada perubahan data: action hanya diusulkan"],
        "procedures_ok": h["procedures_followed"]["ok"], "skill": h["skill"], "dikerjakan": h["implemented"],
        "results": [r["rid"] for r in box.index],
    }
    emit({"type": "handoff", "agent": f"agen_{a['key']}", "handoff": handoff})
    emit({"type": "answer", "text": report})


async def mission_validate(inp: dict) -> None:
    """After a milestone: a validator, which never saw the workers' reasoning, checks the contract against the data."""
    p, m, cat, box, service = _setup(inp)
    roles = cat["roles"]
    contract = inp.get("contract") or []
    found = "\n\n".join(f"[{h.get('task')} · {h.get('agent')}] {str(h.get('implemented', ''))[:1500]}" for h in inp.get("handoffs") or [])
    model = roles["validator"]
    # the scrutiny validator first: plain code over the milestone's handoffs
    hs = inp.get("handoffs") or []
    scrut = [{"klaim": "setiap tugas milestone menyerahkan serah-terima dengan kueri yang berhasil", "blok": False,
              "ok": bool(hs) and all(any(q.get("ok") for q in h.get("queries_run") or []) for h in hs),
              "bukti": f"{sum(any(q.get('ok') for q in h.get('queries_run') or []) for h in hs)}/{len(hs)} tugas berbukti"},
             {"klaim": "prosedur skill diikuti di setiap tugas", "blok": False, "ok": all(h.get("procedures_ok", True) for h in hs),
              "bukti": f"{sum(bool(h.get('procedures_ok', True)) for h in hs)}/{len(hs)} tugas"},
             {"klaim": "tidak ada tugas yang menyisakan pekerjaan", "blok": False, "ok": not any(h.get("left_undone") for h in hs),
              "bukti": "; ".join(f"{h.get('task')}: {h.get('left_undone')}" for h in hs if h.get("left_undone"))[:600] or "semua selesai"}]
    emit({"type": "stage", "stage": "mission_scrutiny", "agent": "scrutiny", "model": "kode (deterministik)"})
    O.emit_scrutiny(scrut, str(inp.get("milestone") or ""))
    text = f"""Anda validator adversarial misi AIP JKN ({inp.get('milestone')}). Anda hanya melihat kontrak, temuan pekerja dan data.
Kontrak:
{chr(10).join(f"- {c['id']}: {c['text']}" for c in contract)}
Temuan pekerja:
{found or '-'}
Periksa setiap pernyataan kontrak dengan memanggil tool sendiri (paling banyak 6 panggilan). Jawab HANYA JSON:
{{"checks": [{{"id": "a1", "klaim": "<pernyataan>", "ok": true, "bukti": "<yang Anda temukan>"}}]}}"""
    emit({"type": "stage", "stage": "mission_validate", "agent": "validator", "model": model})
    st = await stage(service, LlmAgent(name="validator", model=m.llm(model, "validator"), instruction=A._const(text),
                                       tools=T.object_tools(box, "validator", any_owner=True, read_only=True), output_key="verdict"), "periksa kontrak")
    try:
        checks = O.clean_checks(A.parse_json(st.get("verdict", "")).get("checks"))
    except ValueError:
        checks = []
    if not checks and box.seen.get("validator"):  # it read the data but its turn ended without a verdict
        st = await stage(service, A.validator_verdict(m, model, inp.get("q", ""), found, _evidence(box.seen["validator"]),
                                                      "\n".join(f"- {c['id']}: {c['text']}" for c in contract)), "periksa kontrak")
        try:
            checks = O.clean_checks(A.parse_json(st.get("verdict", "")).get("checks"))
        except ValueError:
            checks = []
    failed = [c for c in checks if not c.get("ok")]
    emit({"type": "verdict", "validator": "validator", "model": model, "checks": checks, "passed": len(checks) - len(failed), "total": len(checks),
          "steps": box.receipts.get("validator", [])})
    # learning: what the validators caught becomes lessons of the skills the milestone used
    used = [h.get("skill") for h in hs if h.get("skill")]
    issues = [f"validator: {c.get('klaim')} → {c.get('bukti')}" for c in failed + [c for c in scrut if not c["ok"]]] + \
        [f"{h.get('agent')} ({h.get('skill')}): {x}" for h in hs for x in (h.get("issues_found") or [])[:2]]
    await O.encode_lessons(stage, service, m, roles["planner"], inp["run_id"], p, used, issues[:30])


def _sources(box: Any) -> str:
    """The run's results as the answer cites them ([rN]: what was read, its columns): the validator recomputes THAT
    measure. On 2026-10-23 it counted Indikasi Fraud rows per nama_objek (20) against Karantina Faskes klaim_bertag (168),
    called the true answer wrong, and the revision rewrote it with the proxy."""
    return "\n".join(f"- {r['rid']}: {r['title']} (kolom: {', '.join(map(str, r.get('columns') or []))[:240]})" for r in box.index[:40])


def _evidence(seen: list[dict]) -> str:
    """What a validator's reads returned, for its verdict when its own turn ended without one."""
    return "\n".join(f"- {s['tool']}({json.dumps(s['args'], ensure_ascii=False)[:300]}) → {json.dumps(s['result'], ensure_ascii=False, default=str)[:900]}"
                     for s in seen)


async def konsultan(inp: dict) -> None:
    """The fraud consultancy's engagement: about a hundred agents (adk_runtime/firm.py)."""
    from aip.adk_runtime import firm

    await firm.engagement(inp)


async def telaah(inp: dict) -> None:
    """A Blu 1.1 or 1.3 calibration on its own (POST /api/aip/telaah/kalibrasi): the review's first claims through both models,
    its numbers kept for the start form; its verdicts kept, so the engagement's own calibration reads them free."""
    from aip import telaah as TL
    from aip.adk_runtime import telaah as TR

    p, _m, _cat, box, _service = _setup(inp)
    emit({"type": "run", "status": "started", "kind": "telaah"})

    def result(title: str, rows: list[dict], meta: dict) -> str:
        token = T._CURRENT.set("telaah_klinis")
        try:
            return box.result(title, rows, meta=meta)
        finally:
            T._CURRENT.reset(token)

    out = await TR.Review(inp, p, result).run("kalibrasi", int(inp.get("telaah_n") or TL.SAMPLE_N))
    cal = out.get("kalibrasi") or {}
    hasil = cal.get("hasil") or {}
    versi = inp.get("versi") if inp.get("versi") in TL.REVIEWED else "1.1"
    other = "rujukan (putusan tersimpan, tidak dipanggil)" if versi == "1.3" else "model periksa"
    lines = [f"Uji kalibrasi Blu {versi}: {cal.get('n')} klaim, model saring {out['model']['saring']}, {other} {out['model']['periksa']}.",
             f"Kappa berbobot {hasil.get('kappa_berbobot')}, setuju 3 kelas {hasil.get('setuju_3_kelas')}; proyeksi biaya telaah penuh "
             f"${cal.get('proyeksi_usd')} (batas ${cal.get('batas_usd')}); biaya uji ini ${out.get('usd')}.",
             "Telaah penuh boleh berjalan." if cal.get("lolos") else "Telaah penuh TIDAK akan berjalan: " + "; ".join(cal.get("alasan") or [])]
    emit({"type": "answer", "text": "\n\n".join(lines)})


KINDS = {"ask": ask, "mission_plan": mission_plan, "mission_task": mission_task, "mission_validate": mission_validate, "konsultan": konsultan,
         "telaah": telaah}


def main() -> None:
    inp = json.loads(sys.stdin.read())
    try:
        if inp.get("kind") not in KINDS:
            raise ValueError(f"unknown run kind {inp.get('kind')!r}")
        asyncio.run(KINDS[inp["kind"]](inp))
        emit({"type": "done"})
    except Exception as e:  # noqa: BLE001 - the page shows why the run stopped
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"[:1000]})
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
