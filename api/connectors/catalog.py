"""The connector catalog: Foundry's available connectors and what each one supports.

catalog.json was generated from Palantir Foundry's "Available connectors" documentation. Each
entry has the connector's capabilities with their release status (ga | beta), its mandatory and
recommended configuration properties, and the network domains it must reach. Connectors this
server implements show the same capabilities, each marked supported or not here; the rest are
listed (with this reference) as not available yet.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

_ENTRIES: dict[str, dict] = {e["slug"]: e for e in json.loads((Path(__file__).with_name("catalog.json")).read_text(encoding="utf-8"))}

# what every connector on this server does: browse, snapshot and incremental syncs, and reads
# from Pipeline Builder (virtual tables, pipeline_runtime.virtual_read)
BASE_CAPABILITIES = ("Exploration", "Batch syncs", "Incremental")
SUPPORTED = {"Exploration", "Batch syncs", "Bulk import", "Incremental", "Virtual tables", "Table inputs"}


def entry(slug: str) -> dict:
    return _ENTRIES[slug]


def slugs() -> list[str]:
    return list(_ENTRIES)


def capabilities(slug: Optional[str], available: bool, features: set[str]) -> list[dict]:
    """The capabilities shown for a connector: the catalog's (or the base set for connectors not in
    it), each with `supported` = works on this server. `features` are the connector's own extras
    (Table exports, Media sets, File exports, OAuth 2.0 authentication)."""
    ours = SUPPORTED | features
    if slug is None:
        names = [*BASE_CAPABILITIES, *sorted(features & {"Table exports", "OAuth 2.0 authentication"})]
        return [{"name": n, "status": "ga", "supported": True} for n in names]
    return [{**c, "supported": available and c["name"] in ours} for c in _ENTRIES[slug]["capabilities"]]


def reference(slug: Optional[str]) -> dict:
    """ConnectorSpec keyword arguments from the catalog entry."""
    if slug is None:
        return {}
    e = _ENTRIES[slug]
    return {"docs_url": e["docs_url"], "beta": e["beta"], "properties": e["properties"], "networking": e["networking"]}
