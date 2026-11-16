"""Realtime Fraud (deteksi fraud realtime) of AIP JKN: every claim judged the moment it arrives, in the context of
everything around it — the pattern Quantexa describes for fraud (entity resolution → a dynamic network → contextual
scoring with mitigating factors → alerts consolidated per entity → investigation → decisions fed back), built on what
the audit system already has, and feeding it:

  ingest     routes.py: POST /api/aip/realtime/v1/klaim (the platform's claim contract, session or PAT) and
             POST /api/aip/realtime/v1/faskes/klaim (a hospital system's submission: ai-jkn's Kodifikasi, ingest token)
  resolve    entitas.py: members, facilities (the insurer's registry of each connected hospital), and the patients of
             hospital submissions (RM number + name, fuzzy), each decision with its rule and a quality score
  context    graf.py: a sliding event-time window of the stream as a graph, and its signals (overlapping stays, one
             card at many facilities, duplicates, split episodes, facility rings, cloning, severity bursts, risk by
             association) with their mitigating context
  score      mesin.py: the deployed production model (aip/layanan.py, point-in-time features incl. the stream's own
             history, TreeSHAP reasons, the semantic layer's rules) + the graph → score 0–100 → LOLOS / PERIKSA / TAHAN
  alert      one case per entity (facility, member or ring), by priority
  integrate  integrasi.py: every alert a tag in the indikasi ledger at once; Box Karantina rebuilt from them; a
             person's verdict on a case decides its tags; the AI Agent Swarm reads the ledger and the box
  evaluate   simulator.py: the last two weeks of the synthetic claims replayed with planted scenarios (the truth kept
             apart, never an input): detection, delay, false alerts, the effect of the mitigating context
"""

from aip.realtime.routes import router  # noqa: F401
