"""Resource Management: compute usage by pipeline, stream and sync (estimates from what ran and for how long).

Every container is counted at max(vCPU, GiB / 7.5) × 0.5 compute-seconds per second — the rate of the
streaming compute formula (web/src/lib/compute.ts; keep the two in sync):

* Streaming pipeline jobs: job manager + task managers × (parallelism + 1) of the streaming profile, for as
  long as the job ran (until now while it runs). Each job's usage is also split evenly over the output
  ingest streams it writes.
* Batch pipeline builds: per job, its driver plus the minimum number of executors of the job's compute profile
  (the managed profile records the allocation it chose) for the job's duration. Builds run on this server's
  engine, so this is what the profile would be billed, not measured usage.
* Streaming syncs: one 1-vCPU consumer per parallel consumer, for each minute the sync reported metrics.
* Data source (batch) syncs: one 1-vCPU agent for each run's duration.
* Iceberg tables (iceberg_tables.usage): maintenance jobs and syncs into tables as one 1-vCPU container each, and the
  storage of Foundry-managed tables — the live data and delete files of main's latest snapshot, in gigabyte-months
  (bring-your-own-bucket tables report no storage).

Mounted by server.py under /api/resources.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter

import pipeline_runtime as rt

router = APIRouter(prefix="/api/resources")

# (vCPU, GiB) of the job manager; task managers' (vCPU, GiB) and parallelism
STREAMING = {
    "xxs": ((1, 1), (1, 1), 1),
    "xs": ((1, 1), (1, 1), 1),
    "s": ((1, 1), (1, 4), 2),
    "m": ((1, 1), (1, 6), 3),
    "l": ((1, 2), (1, 8), 4),
    "xl": ((1, 2), (1, 12), 8),
}
# batch profiles: driver (vCPU, GiB), minimum executors, executor (vCPU, GiB) — Build settings → compute profiles
BATCH = {
    "xs": ((1, 4), 0, (0, 0)),
    "s": ((1, 2), 1, (1, 3)),
    "m": ((1, 6), 2, (2, 6)),
    "l": ((1, 13), 2, (2, 6)),
    "xl": ((1, 27), 2, (2, 6)),
    "warm-xs": ((3, 13), 0, (0, 0)),
    "warm-s": ((3, 7), 1, (1, 3)),
    "native-s": ((1, 2), 1, (1, 3)),
    "native-m": ((1, 6), 2, (1, 6)),
    "native-l": ((1, 13), 2, (1, 6)),
    "native-xl": ((1, 27), 2, (1, 6)),
    "native-advanced": ((1, 6), 2, (1, 6)),
    "faster-s": ((1, 7.5), 0, (0, 0)),
    "faster-m": ((2, 15), 0, (0, 0)),
    "faster-l": ((4, 30), 0, (0, 0)),
    "faster-xl": ((8, 60), 0, (0, 0)),
    "faster-xxl": ((16, 120), 0, (0, 0)),
}


def rate(cpu: float, gib: float) -> float:
    """Compute-seconds per second of one container."""
    return max(cpu, gib / 7.5) * 0.5


def _parse(at: Optional[str]) -> Optional[datetime]:
    if not at:
        return None
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _span(start: Optional[str], end: Optional[str], now: datetime) -> float:
    a = _parse(start)
    if not a:
        return 0.0
    z = _parse(end) or now
    return max(0.0, (z - a).total_seconds())


def streaming_usage(b: dict, now: datetime) -> tuple[float, float]:
    """(seconds, compute-seconds) of a streaming job."""
    profile = ((b.get("jobs") or [{}])[0].get("profile")) or "xs"
    (jc, jg), (tc, tg), par = STREAMING.get(profile, STREAMING["xs"])
    secs = _span(b.get("started_at"), b.get("finished_at"), now)
    return secs, rate(jc, jg) * secs + rate(tc, tg) * secs * (par + 1)


def batch_usage(b: dict, now: datetime) -> tuple[float, float]:
    """(seconds, compute-seconds) of a batch build: each job's driver and minimum executors over its duration."""
    total_s = total_c = 0.0
    for j in b.get("jobs") or []:
        secs = _span(j.get("started_at"), j.get("finished_at") or b.get("finished_at"), now)
        (dc, dg), n, (ec, eg) = BATCH.get(str(j.get("profile") or "xs"), BATCH["xs"])
        total_s += secs
        total_c += (rate(dc, dg) + n * (rate(ec, eg) if ec or eg else 0)) * secs
    return total_s, total_c


def _day(at: Optional[str]) -> str:
    return (at or "")[:10]


@router.get("/usage")
def usage(days: int = 30) -> dict:
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=max(1, min(days, 365)))
    pipelines: dict[str, dict] = {}
    streams: dict[str, dict] = {}
    by_kind = {"batch": 0.0, "streaming": 0.0}
    daily: dict[str, dict[str, float]] = {}

    def add_day(day: str, kind: str, cs: float) -> None:
        d = daily.setdefault(day, {"batch": 0.0, "streaming": 0.0, "syncs": 0.0, "media": 0.0})
        d[kind] += cs

    for b in rt._builds(limit=20000):
        created = _parse(b["created_at"])
        if created and created < since:
            break
        if not b.get("started_at"):
            continue
        streaming = bool(b.get("streaming"))
        secs, cs = streaming_usage(b, now) if streaming else batch_usage(b, now)
        p = pipelines.setdefault(b["pipeline_id"], {"id": b["pipeline_id"], "name": b.get("pipeline_name"), "type": "streaming" if streaming else "batch",
                                                    "builds": 0, "failed": 0, "seconds": 0.0, "compute_seconds": 0.0, "running": False, "profiles": {}})
        p["builds"] += 1
        p["failed"] += b["status"] == "failed"
        p["seconds"] += secs
        p["compute_seconds"] += cs
        by_kind["streaming" if streaming else "batch"] += cs
        p["running"] |= b["status"] in ("queued", "running")
        if streaming:
            p["type"] = "streaming"
        for j in b.get("jobs") or []:
            p["profiles"][str(j.get("profile"))] = p["profiles"].get(str(j.get("profile")), 0) + 1
        add_day(_day(b["created_at"]), "streaming" if streaming else "batch", cs)
        if streaming:
            outs = [o for o in ((b.get("jobs") or [{}])[0].get("outputs") or []) if o.get("streamId")]
            for o in outs:
                s = streams.setdefault(o["streamId"], {"id": o["streamId"], "name": o.get("name"), "pipeline_id": b["pipeline_id"], "pipeline_name": b.get("pipeline_name"),
                                                       "seconds": 0.0, "compute_seconds": 0.0, "records": 0})
                s["seconds"] += secs
                s["compute_seconds"] += cs / len(outs)
                s["records"] += int(o.get("rows") or 0)

    syncs: list[dict] = []
    try:
        import streaming as st

        since_min = since.strftime("%Y-%m-%dT%H:%M")
        with st._db() as con:
            recs = [__import__("json").loads(r[0]) for r in con.execute("SELECT record FROM syncs").fetchall()]
            for rec in recs:
                consumers = st.compose(rec.get("profiles", []), rec.get("advanced"))["parallelism"] if rec.get("kind") in ("kafka", "sqs", "pubsub", "rabbitmq") else 1
                rows = con.execute("SELECT substr(minute, 1, 10), COUNT(*), SUM(records) FROM metrics WHERE sync_id = ? AND minute >= ? GROUP BY 1", (rec["id"], since_min)).fetchall()
                minutes = sum(r[1] for r in rows)
                cs = minutes * 60 * consumers * rate(1, 1)
                for day, n, _ in rows:
                    add_day(day, "syncs", n * 60 * consumers * rate(1, 1))
                syncs.append({"id": rec["id"], "name": rec.get("name"), "kind": rec.get("kind"), "type": "streaming", "consumers": consumers, "minutes": minutes,
                              "records": sum(int(r[2] or 0) for r in rows), "compute_seconds": cs, "running": rec.get("desired") == "running"})
    except Exception:  # noqa: BLE001 - streaming store unavailable
        pass
    try:
        import datasources

        runs = datasources._rows(
            "SELECT s.id, s.name, r.started_at, r.finished_at, r.rows FROM data_source_runs r JOIN data_sources s ON s.id = r.source_id WHERE r.started_at >= %s",
            (since,))
        by: dict[str, dict[str, Any]] = {}
        for r in runs:
            secs = _span(str(r["started_at"]), str(r["finished_at"]) if r.get("finished_at") else None, now)
            e = by.setdefault(r["id"], {"id": r["id"], "name": r["name"], "kind": "data source", "type": "batch", "runs": 0, "seconds": 0.0, "records": 0, "compute_seconds": 0.0, "running": False})
            e["runs"] += 1
            e["seconds"] += secs
            e["records"] += int(r.get("rows") or 0)
            e["compute_seconds"] += secs * rate(1, 1)
            e["running"] |= not r.get("finished_at")
            add_day(_day(r["started_at"].isoformat() if hasattr(r["started_at"], "isoformat") else str(r["started_at"])), "syncs", secs * rate(1, 1))
        syncs += list(by.values())
    except Exception:  # noqa: BLE001 - data sources need the database
        pass

    # media sets: downloads and access patterns at the per-GB rates of the media usage doc (media_sets.py)
    media_sets_usage: list[dict] = []
    try:
        import media_sets

        by_set: dict[str, dict[str, Any]] = {}
        for e in media_sets.usage_entries(since):
            add_day(_day(e["at"]), "media", e["compute_seconds"])
            m = by_set.setdefault(e["media_set"] or "_", {"id": e["media_set"], "name": None, "compute_seconds": 0.0, "gb": 0.0, "requests": 0, "by": {}})
            m["compute_seconds"] += e["compute_seconds"]
            m["gb"] += e["gb"]
            m["requests"] += 1
            m["by"][e["transformation"]] = m["by"].get(e["transformation"], 0.0) + e["compute_seconds"]
        import db

        for m in by_set.values():
            m["name"] = (db.drive_get(m["id"]) or {}).get("name") if m["id"] else "Uploads (format conversion)"
        media_sets_usage = sorted(by_set.values(), key=lambda m: -m["compute_seconds"])
    except Exception:  # noqa: BLE001 - media sets not configured
        pass

    # Iceberg tables: storage of main's latest snapshot (Foundry-managed storage), maintenance jobs, syncs into tables
    iceberg = None
    try:
        import iceberg_tables

        iceberg = iceberg_tables.usage(since, days)
        if iceberg["sync_compute_seconds"]:
            syncs.append({"id": "iceberg-syncs", "name": "Iceberg table syncs", "kind": "iceberg sync", "type": "batch",
                          "compute_seconds": iceberg["sync_compute_seconds"], "records": 0, "running": False})
    except Exception:  # noqa: BLE001 - Iceberg not configured
        pass

    totals = {**by_kind, "syncs": sum(s["compute_seconds"] for s in syncs), "media": sum(m["compute_seconds"] for m in media_sets_usage),
              "iceberg": iceberg["maintenance_compute_seconds"] if iceberg else 0.0}
    return {
        "days": days,
        "since": since.isoformat(timespec="seconds"),
        "totals": {**totals, "all": sum(totals.values())},
        "pipelines": sorted(pipelines.values(), key=lambda p: -p["compute_seconds"]),
        "streams": sorted(streams.values(), key=lambda s: -s["compute_seconds"]),
        "syncs": sorted(syncs, key=lambda s: -s["compute_seconds"]),
        "media_sets": media_sets_usage,
        "daily": [{"day": d, **v} for d, v in sorted(daily.items()) if d],
        "iceberg": iceberg,
        "accounts": _by_account(pipelines.values()),
    }


def _by_account(pipelines: Any) -> list[dict]:
    """Pipeline compute by usage account: the account of the space each pipeline's Project is in
    (governance_model.py; "Unassigned" without one)."""
    import auth

    try:
        import governance_model
    except Exception:  # noqa: BLE001
        return []
    out: dict[str, dict] = {}
    for p in pipelines:
        acct = governance_model.setting_for(auth.project_of(p.get("id")), "usage_account") or "Unassigned"
        a = out.setdefault(acct, {"account": acct, "compute_seconds": 0.0, "pipelines": 0})
        a["compute_seconds"] += p.get("compute_seconds") or 0.0
        a["pipelines"] += 1
    return sorted(out.values(), key=lambda a: -a["compute_seconds"])
