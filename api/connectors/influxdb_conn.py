"""InfluxDB 2.x / Cloud (influxdb-client, Flux).

Browsing is bucket → measurement. A measurement reads as a table by pivoting its fields into
columns: one row per point with `_time`, the tag columns and the field columns. Columns come from
a bounded sample. The incremental cursor is always `_time`. Every value (bucket, measurement,
times, limits) is passed as a typed Flux parameter, never pasted into the query text.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator, Optional

from influxdb_client import InfluxDBClient

from .base import ConnectorError, DatabaseConnector

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
# Python date-times are microseconds; an exclusive bound moves by one
TICK = timedelta(microseconds=1)
SAMPLE = 500
HIDDEN = ("result", "table", "_start", "_stop", "_measurement")

POINTS = """
from(bucket: bs_bucket)
  |> range(start: bs_start, stop: bs_stop)
  |> filter(fn: (r) => r._measurement == bs_measurement)
"""
ROWS = """
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_measurement"])
  |> group()
"""


def _utc(v: Any) -> datetime:
    if not isinstance(v, datetime):
        raise ConnectorError("InfluxDB cursors are times")
    return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v.astimezone(timezone.utc)


def _kind(values: list[Any]) -> tuple[str, str]:
    present = [v for v in values if v is not None]
    kinds = {type(v) for v in present}
    if not present or kinds == {str}:
        return "String", "string"
    if kinds == {bool}:
        return "Boolean", "boolean"
    if kinds == {int}:
        return "Long", "integer"
    if kinds <= {int, float}:
        return "Double", "float"
    if kinds == {datetime}:
        return "Timestamp", "time"
    return "String", "mixed"


class InfluxConnector(DatabaseConnector):
    statement_timeout_s = 60

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._client: Optional[InfluxDBClient] = None

    @property
    def client(self) -> InfluxDBClient:
        if self._client is None:
            self._client = InfluxDBClient(
                url=self.config["url"].rstrip("/"),
                token=self.secrets.get("token"),
                org=self.config["org"],
                timeout=int(self.statement_timeout_s * 1000),
            )
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def _query(self, flux: str, params: dict, action: str) -> list[Any]:
        try:
            return [rec for table in self.client.query_api().query(flux, params=params) for rec in table.records]
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, action) from None

    def _params(self, bucket: str, measurement: str, start: datetime = EPOCH, stop: Optional[datetime] = None) -> dict:
        return {
            "bs_bucket": bucket,
            "bs_measurement": measurement,
            "bs_start": start,
            "bs_stop": stop or datetime.now(timezone.utc) + timedelta(days=1),
        }

    # -- discovery --

    def test_connection(self) -> dict:
        try:
            ok = self.client.ping()
            version = self.client.version() if ok else None
        except Exception as e:
            raise self.error(e, "Could not connect") from None
        if not ok:
            raise ConnectorError("Could not connect: the server did not answer the ping")
        self.list_databases()  # checks the token and organization
        return {"version": f"InfluxDB {version}"}

    def list_databases(self) -> list[str]:
        try:
            buckets = self.client.buckets_api().find_buckets(limit=100).buckets or []
        except Exception as e:
            raise self.error(e, "Could not list buckets") from None
        names = sorted(b.name for b in buckets if not b.name.startswith("_"))
        own = self.config.get("bucket")
        return names if not own or own in names else [own, *names]

    def list_schemas(self, database: str) -> list[str]:
        return [database]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        recs = self._query(
            'import "influxdata/influxdb/schema"\nschema.measurements(bucket: bs_bucket, start: bs_start)',
            {"bs_bucket": database, "bs_start": EPOCH},
            "Could not list measurements",
        )
        names = sorted({r.get_value() for r in recs if isinstance(r.get_value(), str)})
        return [{"name": n, "kind": "table", "rows": None, "comment": None} for n in names if not search or search.lower() in n.lower()]

    def _known(self, database: str, table: str) -> None:
        if not any(t["name"] == table for t in self.list_tables(database, database, table)):
            raise ConnectorError(f'Measurement "{table}" was not found in bucket "{database}"')

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        self._known(database, table)
        recs = self._query(
            POINTS + "  |> limit(n: bs_per_series)" + ROWS + "  |> limit(n: bs_sample)",
            {**self._params(database, table), "bs_per_series": 50, "bs_sample": SAMPLE},
            "Could not sample the measurement",
        )
        names: list[str] = []
        for r in recs:
            for k in r.values:
                if k not in HIDDEN and k not in names:
                    names.append(k)
        if "_time" in names:
            names.remove("_time")
        names.insert(0, "_time")
        columns = []
        for n in names:
            kind, shown = ("Timestamp", "time") if n == "_time" else _kind([r.values.get(n) for r in recs])
            columns.append(
                {
                    "name": n,
                    "db_type": shown,
                    "type": kind,
                    "nullable": n != "_time",
                    "comment": None,
                    "tz": True,
                    "cursor": n == "_time",
                    "recommended": n == "_time",
                }
            )
        return {"columns": columns, "primary_key": [], "rows": None, "comment": f"Fields pivoted into columns; types from {len(recs)} sampled points"}

    def _names(self, database: str, schema: str, table: str, columns: list[str]) -> list[str]:
        return columns or [c["name"] for c in self.get_table_schema(database, schema, table)["columns"]]

    # -- reads --

    def preview_rows(self, database: str, schema: str, table: str, limit: int = 100) -> tuple[list[dict], list[tuple]]:
        info = self.get_table_schema(database, schema, table)
        names = [c["name"] for c in info["columns"]]
        recs = self._query(
            POINTS + ROWS + "  |> sort(columns: [\"_time\"], desc: true)\n  |> limit(n: bs_limit)",
            {**self._params(database, table), "bs_limit": max(1, min(limit, 1000))},
            "Preview failed",
        )
        return info["columns"], [tuple(r.values.get(n) for n in names) for r in recs]

    def _check_cursor(self, column: str) -> None:
        if column != "_time":
            raise ConnectorError("InfluxDB data sources use _time as the incremental cursor")

    def get_incremental_metadata(self, database: str, schema: str, table: str, column: str) -> dict:
        self._check_cursor(column)
        self._known(database, table)
        # only _time survives: fields of different types cannot be grouped together
        recs = self._query(
            POINTS + '  |> last()\n  |> keep(columns: ["_time"])\n  |> group()\n  |> max(column: "_time")',
            self._params(database, table),
            "Could not read the latest time",
        )
        return {"max": recs[0].get_time() if recs else None}

    def _bounds(self, lower: Any, lower_inclusive: bool, upper: Any) -> tuple[datetime, datetime]:
        start = EPOCH if lower is None else _utc(lower) + (timedelta(0) if lower_inclusive else TICK)
        # range() stops before `stop`: one tick past the inclusive upper bound
        return start, _utc(upper) + TICK

    def count_range(self, database: str, schema: str, table: str, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> int:
        self._check_cursor(column)
        self._known(database, table)
        start, stop = self._bounds(lower, lower_inclusive, upper)
        # count() cannot aggregate a time column: count a constant per row instead
        recs = self._query(
            POINTS + ROWS + '  |> keep(columns: ["_time"])\n  |> map(fn: (r) => ({r with bs_n: 1}))\n  |> count(column: "bs_n")',
            self._params(database, table, start, stop),
            "Could not count the new points",
        )
        return int(recs[0].values.get("bs_n") or 0) if recs else 0

    def read_range(
        self, database: str, schema: str, table: str, columns: list[str], column: str, lower: Any, lower_inclusive: bool, upper: Any, limit: Optional[int]
    ) -> list[tuple]:
        self._check_cursor(column)
        self._known(database, table)
        names = self._names(database, schema, table, columns)
        start, stop = self._bounds(lower, lower_inclusive, upper)
        flux = POINTS + ROWS + "  |> sort(columns: [\"_time\"])" + ("\n  |> limit(n: bs_limit)" if limit else "")
        params = {**self._params(database, table, start, stop), **({"bs_limit": int(limit)} if limit else {})}
        return [tuple(r.values.get(n) for n in names) for r in self._query(flux, params, "Reading new points failed")]

    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        self._known(database, table)
        names = self._names(database, schema, table, columns)
        try:
            batch: list[tuple] = []
            for r in self.client.query_api().query_stream(POINTS + ROWS, params=self._params(database, table)):
                batch.append(tuple(r.values.get(n) for n in names))
                if len(batch) >= batch_size:
                    yield batch
                    batch = []
            if batch:
                yield batch
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, "Reading the measurement failed") from None
