"""Amazon DynamoDB (boto3): tables in one region.

The region is the only database. Columns are inferred from a bounded Scan (numbers come back as
Decimals: whole ones become integers); maps, lists and sets become JSON text. Item counts are
DescribeTable's estimate (refreshed by AWS about every six hours), so browsing never scans.

Incremental cursors are any date-time string or number attribute: the range is pushed down as a
Scan FilterExpression. A Scan still reads (and is billed for) the whole table, so keep
incremental syncs on tables of a manageable size.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Iterator, Optional

from .records import RecordConnector

PAGE_ITEMS = 1000


class DynamoDbConnector(RecordConnector):
    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._client: Any = None
        self._resource: Any = None

    def _session(self) -> Any:
        import boto3

        return boto3.session.Session(
            aws_access_key_id=self.config.get("access_key_id") or None,
            aws_secret_access_key=self.secrets.get("secret_access_key") or None,
            aws_session_token=self.secrets.get("session_token") or None,
            region_name=self.config["region"],
        )

    def _endpoint(self) -> Optional[str]:
        return self.config.get("endpoint_url") or None

    @property
    def client(self) -> Any:
        if self._client is None:
            from botocore.config import Config

            cfg = Config(connect_timeout=10, read_timeout=int(self.statement_timeout_s), retries={"max_attempts": 3})
            s = self._session()
            self._client = s.client("dynamodb", endpoint_url=self._endpoint(), config=cfg)
            self._resource = s.resource("dynamodb", endpoint_url=self._endpoint(), config=cfg)
        return self._client

    @property
    def resource(self) -> Any:
        _ = self.client
        return self._resource

    # -- discovery --

    def test_connection(self) -> dict:
        self._safe(lambda: self.client.list_tables(Limit=1), "Could not connect")
        return {"version": f"Amazon DynamoDB ({self.config['region']})"}

    def list_databases(self) -> list[str]:
        return [self.config["region"]]

    def _list_tables(self, database: str, search: str) -> list[dict]:
        def names() -> list[str]:
            out: list[str] = []
            for page in self.client.get_paginator("list_tables").paginate():
                out.extend(page.get("TableNames", []))
            return out

        found = [n for n in self._safe(names, "Could not list tables") if not search or search.lower() in n.lower()]
        tables = []
        for n in found[:300]:
            rows = None
            try:
                rows = self.client.describe_table(TableName=n)["Table"].get("ItemCount")
            except Exception:
                pass
            tables.append({"name": n, "kind": "table", "rows": rows, "comment": None})
        tables.extend({"name": n, "kind": "table", "rows": None, "comment": None} for n in found[300:])
        return tables

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        desc = self._safe(lambda: self.client.describe_table(TableName=table)["Table"], "Could not describe the table")
        return [k["AttributeName"] for k in sorted(desc.get("KeySchema", []), key=lambda k: k["KeyType"] != "HASH")]

    def _schema(self, database: str, table: str) -> dict:
        info = super()._schema(database, table)
        if info.get("rows") is None:
            try:
                info["rows"] = self.client.describe_table(TableName=table)["Table"].get("ItemCount")
            except Exception:
                pass
        # key attributes first
        pk = info["primary_key"]
        info["columns"].sort(key=lambda c: (c["name"] not in pk, pk.index(c["name"]) if c["name"] in pk else 0))
        return info

    # -- reads --

    def _scan(self, table: str, limit: Optional[int], **kwargs: Any) -> Iterator[list[dict]]:
        t = self.resource.Table(table)
        start = None
        left = limit
        while True:
            args = dict(kwargs)
            args["Limit"] = min(PAGE_ITEMS, left) if left else PAGE_ITEMS
            if start:
                args["ExclusiveStartKey"] = start
            page = t.scan(**args)
            items = page.get("Items", [])
            if items:
                yield items
            if left:
                left -= len(items)
                if left <= 0:
                    return
            start = page.get("LastEvaluatedKey")
            if not start:
                return

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        return self._scan(table, limit)

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        from boto3.dynamodb.conditions import Attr

        def bound(v: Any) -> Any:
            # date-time strings compare as text: bind the stored form
            if col["type"] == "Timestamp" and isinstance(v, datetime):
                return None
            if col["type"] == "Date" and isinstance(v, date):
                return v.isoformat()
            if isinstance(v, float):
                return None
            return v

        hi = bound(upper) if upper is not None else None
        lo = bound(lower) if lower is not None else None
        if (upper is not None and hi is None) or (lower is not None and lo is None):
            return None  # filtered here instead
        attr = Attr(col["name"])
        cond = attr.lte(hi) if hi is not None else attr.exists()
        if lo is not None:
            cond = cond & (attr.gte(lo) if lower_inclusive else attr.gt(lo))
        return self._scan(table, None, FilterExpression=cond)

