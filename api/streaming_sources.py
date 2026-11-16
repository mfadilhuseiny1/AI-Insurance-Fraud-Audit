"""Streaming sources: clients that pull records from streaming platforms for streaming syncs
(streaming.py), as Data Connection's streaming syncs ("Set up a streaming sync").

Each source follows its platform's consumer API and checkpoints only after the records were
written to the ingest stream (at-least-once):

  kafka      confluent-kafka consumer group; offsets committed on checkpoint; lag from the
             partitions' high watermarks
  kinesis    boto3 GetShardIterator / GetRecords per shard; the shard sequence numbers are the
             checkpoint; lag is MillisBehindLatest
  sqs        boto3 ReceiveMessage (long polling); messages deleted on checkpoint; Amazon SNS
             notifications delivered to the queue are unwrapped (SNS → SQS subscription);
             lag is ApproximateNumberOfMessages
  pubsub     Google Pub/Sub REST pull with a service account; acknowledged on checkpoint
  pi         AVEVA PI Web API: points by path, recorded values of all points through
             streamsets/recorded since the last checkpoint
  mqtt       paho-mqtt subscription (also ActiveMQ, Solace, IBM MQ MQTT channels and the
             RabbitMQ MQTT plugin); QoS 1/2 messages acknowledged on checkpoint (manual acks)
  rabbitmq   AMQP 0-9-1 (pika); basic_get with acks on checkpoint; lag is the queue depth
  ibmmq      IBM MQ queue through pymqi (needs the IBM MQ client); gets under syncpoint,
             committed on checkpoint

A message becomes one record: with value format "json" an object's fields become columns, else
the value is a `value` column; every record carries `_key`, `_timestamp` and the source position
(`_partition` / `_offset`, `_shard` / `_sequence`, …).
"""

from __future__ import annotations

import base64
import json
import queue
import time
from datetime import datetime, timezone
from typing import Any, Optional


class SourceError(Exception):
    """A user-facing error of a streaming source (no credentials)."""


def _driver(module: str, package: str) -> Any:
    import importlib

    try:
        return importlib.import_module(module)
    except ImportError:
        raise SourceError(f"This source needs the {package} package on the server: pip install {package}") from None


def _iso(ts: Any) -> Optional[str]:
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000 if ts > 1e11 else ts, tz=timezone.utc).isoformat()
    return str(ts)


def decode(raw: Any, fmt: str) -> dict:
    """Message value → record fields."""
    if raw is None:
        return {"value": None}
    if isinstance(raw, (bytes, bytearray)):
        if fmt == "base64":
            return {"value": base64.b64encode(bytes(raw)).decode()}
        try:
            text = bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            return {"value": base64.b64encode(bytes(raw)).decode()}
    else:
        text = raw if isinstance(raw, str) else json.dumps(raw)
    if fmt == "json":
        try:
            v = json.loads(text)
        except ValueError:
            return {"value": text}
        return v if isinstance(v, dict) else {"value": v}
    return {"value": text}


class Message:
    __slots__ = ("record", "ack", "size")

    def __init__(self, record: dict, ack: Any = None, size: int = 0):
        self.record, self.ack, self.size = record, ack, size


class Source:
    """poll() → messages; checkpoint(messages) after they were written; lag(); close()."""

    def __init__(self, config: dict, secrets: dict, profile: dict, state: dict):
        self.config, self.secrets, self.profile = config, secrets, profile
        # the checkpointed position (persisted by streaming.py): offsets, sequence numbers, times
        self.state = state
        self.fmt = config.get("value_format") or "json"

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        raise NotImplementedError

    def checkpoint(self, messages: list[Message]) -> None:
        """Commit / acknowledge the messages (they are in the stream)."""

    def lag(self) -> Optional[float]:
        return None

    def close(self) -> None:
        pass


# --------------------------------------------------------------------------------------------
# Apache Kafka
# --------------------------------------------------------------------------------------------


class KafkaSource(Source):
    def __init__(self, *a: Any):
        super().__init__(*a)
        ck = _driver("confluent_kafka", "confluent-kafka")
        c = self.config
        conf: dict[str, Any] = {
            "bootstrap.servers": c["bootstrap_servers"],
            "group.id": c.get("group_id") or "bluesandai-streaming",
            "enable.auto.commit": False,
            "auto.offset.reset": c.get("start_from") or "earliest",
            "security.protocol": c.get("security_protocol") or "PLAINTEXT",
            "client.id": "bluesandai-streaming",
            "message.max.bytes": int(self.profile.get("max_record_bytes", 1_048_576)) + 512,
            "fetch.max.bytes": max(52_428_800, int(self.profile.get("max_record_bytes", 1_048_576)) * 2),
        }
        if c.get("sasl_mechanism"):
            conf.update({"sasl.mechanism": c["sasl_mechanism"], "sasl.username": c.get("user") or "", "sasl.password": self.secrets.get("password") or ""})
        if self.secrets.get("ca_pem"):
            conf["ssl.ca.pem"] = self.secrets["ca_pem"]
        conf.update(c.get("extra") or {})
        self._ck = ck
        self.consumer = ck.Consumer(conf)
        self.consumer.subscribe([t.strip() for t in str(c["topic"]).split(",") if t.strip()])

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        out = []
        for m in self.consumer.consume(num_messages=max_records, timeout=timeout_s):
            if m.error():
                if m.error().code() == self._ck.KafkaError._PARTITION_EOF:
                    continue
                raise SourceError(f"Kafka: {m.error().str()}")
            key = m.key()
            rec = decode(m.value(), self.fmt)
            rec.update({
                "_key": key.decode("utf-8", "replace") if isinstance(key, bytes) else key,
                "_timestamp": _iso(m.timestamp()[1]) if m.timestamp()[0] else None,
                "_topic": m.topic(),
                "_partition": m.partition(),
                "_offset": m.offset(),
            })
            out.append(Message(rec, m, len(m.value() or b"")))
        return out

    def checkpoint(self, messages: list[Message]) -> None:
        if messages:
            self.consumer.commit(asynchronous=False)

    def lag(self) -> Optional[float]:
        total = 0
        try:
            for tp in self.consumer.assignment():
                lo, hi = self.consumer.get_watermark_offsets(tp, timeout=5, cached=False)
                pos = self.consumer.position([tp])[0].offset
                total += max(0, hi - (pos if pos >= 0 else lo))
        except Exception:
            return None
        return float(total)

    def close(self) -> None:
        try:
            self.consumer.close()
        except Exception:
            pass


# --------------------------------------------------------------------------------------------
# Amazon Kinesis, SQS (and SNS through SQS)
# --------------------------------------------------------------------------------------------


def _aws(config: dict, secrets: dict, service: str) -> Any:
    import boto3
    from botocore.config import Config

    return boto3.session.Session(
        aws_access_key_id=config.get("access_key_id") or None,
        aws_secret_access_key=secrets.get("secret_access_key") or None,
        aws_session_token=secrets.get("session_token") or None,
        region_name=config.get("region") or None,
    ).client(service, endpoint_url=config.get("endpoint_url") or None, config=Config(connect_timeout=10, read_timeout=40, retries={"max_attempts": 3}))


class KinesisSource(Source):
    def __init__(self, *a: Any):
        super().__init__(*a)
        self.client = _aws(self.config, self.secrets, "kinesis")
        self.stream = self.config["stream_name"]
        self.iterators: dict[str, Optional[str]] = {}
        self.pending: dict[str, str] = {}
        self.behind = 0.0
        shards = []
        kw: dict[str, Any] = {"StreamName": self.stream}
        while True:
            res = self.client.list_shards(**kw)
            shards += [s["ShardId"] for s in res["Shards"]]
            if not res.get("NextToken"):
                break
            kw = {"NextToken": res["NextToken"]}
        seqs = self.state.setdefault("sequence", {})
        for sid in shards:
            if seqs.get(sid):
                it = self.client.get_shard_iterator(StreamName=self.stream, ShardId=sid, ShardIteratorType="AFTER_SEQUENCE_NUMBER", StartingSequenceNumber=seqs[sid])
            else:
                start = "TRIM_HORIZON" if (self.config.get("start_from") or "earliest") == "earliest" else "LATEST"
                it = self.client.get_shard_iterator(StreamName=self.stream, ShardId=sid, ShardIteratorType=start)
            self.iterators[sid] = it["ShardIterator"]

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        out: list[Message] = []
        behind = 0.0
        for sid, it in list(self.iterators.items()):
            if not it or len(out) >= max_records:
                continue
            res = self.client.get_records(ShardIterator=it, Limit=min(10_000, max(1, max_records - len(out))))
            self.iterators[sid] = res.get("NextShardIterator")
            behind = max(behind, float(res.get("MillisBehindLatest") or 0))
            for r in res.get("Records", []):
                rec = decode(r["Data"], self.fmt)
                rec.update({"_key": r.get("PartitionKey"), "_timestamp": _iso(r.get("ApproximateArrivalTimestamp")), "_shard": sid, "_sequence": r["SequenceNumber"]})
                out.append(Message(rec, (sid, r["SequenceNumber"]), len(r["Data"])))
        self.behind = behind
        if not out:
            time.sleep(min(timeout_s, 1.0))  # GetRecords is limited to 5 calls per shard per second
        return out

    def checkpoint(self, messages: list[Message]) -> None:
        seqs = self.state.setdefault("sequence", {})
        for m in messages:
            sid, seq = m.ack
            seqs[sid] = seq

    def lag(self) -> Optional[float]:
        return self.behind  # milliseconds behind the tip of the stream


class SqsSource(Source):
    def __init__(self, *a: Any):
        super().__init__(*a)
        self.client = _aws(self.config, self.secrets, "sqs")
        self.url = self.config["queue_url"]

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        out: list[Message] = []
        while len(out) < max_records:
            res = self.client.receive_message(
                QueueUrl=self.url,
                MaxNumberOfMessages=min(10, max_records - len(out)),
                WaitTimeSeconds=0 if out else int(min(20, max(0, timeout_s))),
                AttributeNames=["SentTimestamp"],
                MessageAttributeNames=["All"],
            )
            msgs = res.get("Messages", [])
            if not msgs:
                break
            for m in msgs:
                body = m.get("Body", "")
                topic = None
                try:
                    env = json.loads(body)
                    if isinstance(env, dict) and env.get("Type") == "Notification" and "Message" in env:
                        body, topic = env["Message"], env.get("TopicArn")  # an SNS notification
                except ValueError:
                    pass
                rec = decode(body, self.fmt)
                rec.update({"_key": m["MessageId"], "_timestamp": _iso(int(m.get("Attributes", {}).get("SentTimestamp", 0)) or None), "_topic": topic})
                out.append(Message(rec, m["ReceiptHandle"], len(m.get("Body", ""))))
        return out

    def checkpoint(self, messages: list[Message]) -> None:
        for i in range(0, len(messages), 10):
            chunk = messages[i : i + 10]
            self.client.delete_message_batch(QueueUrl=self.url, Entries=[{"Id": str(n), "ReceiptHandle": m.ack} for n, m in enumerate(chunk)])

    def lag(self) -> Optional[float]:
        try:
            a = self.client.get_queue_attributes(QueueUrl=self.url, AttributeNames=["ApproximateNumberOfMessages"])["Attributes"]
            return float(a["ApproximateNumberOfMessages"])
        except Exception:
            return None


# --------------------------------------------------------------------------------------------
# Google Pub/Sub (REST pull)
# --------------------------------------------------------------------------------------------


class PubSubSource(Source):
    API = "https://pubsub.googleapis.com/v1"

    def __init__(self, *a: Any, http: Any = None):
        super().__init__(*a)
        import httpx

        self.http = http or httpx.Client(timeout=60)
        self.sub = f"projects/{self.config['project_id']}/subscriptions/{self.config['subscription']}"
        self._creds: Any = None

    def _token(self) -> str:
        if self.secrets.get("access_token"):
            return self.secrets["access_token"]
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account

        if self._creds is None:
            info = json.loads(self.secrets["service_account"])
            self._creds = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/pubsub"])
        if not self._creds.valid:
            self._creds.refresh(Request())
        return self._creds.token

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        r = self.http.post(f"{self.API}/{self.sub}:pull", json={"maxMessages": min(1000, max_records)}, headers={"Authorization": f"Bearer {self._token()}"}, timeout=max(30, timeout_s + 10))
        if r.status_code >= 400:
            raise SourceError(f"Pub/Sub pull failed: HTTP {r.status_code} {r.text[:200]}")
        out = []
        for rm in r.json().get("receivedMessages", []):
            m = rm["message"]
            data = base64.b64decode(m.get("data", ""))
            rec = decode(data, self.fmt)
            rec.update({"_key": m.get("orderingKey") or m.get("messageId"), "_timestamp": m.get("publishTime"), "_message_id": m.get("messageId"),
                        "_attributes": json.dumps(m.get("attributes")) if m.get("attributes") else None})
            out.append(Message(rec, rm["ackId"], len(data)))
        if not out:
            time.sleep(min(timeout_s, 2.0))
        return out

    def checkpoint(self, messages: list[Message]) -> None:
        for i in range(0, len(messages), 1000):
            ids = [m.ack for m in messages[i : i + 1000]]
            r = self.http.post(f"{self.API}/{self.sub}:acknowledge", json={"ackIds": ids}, headers={"Authorization": f"Bearer {self._token()}"})
            if r.status_code >= 400:
                raise SourceError(f"Pub/Sub acknowledge failed: HTTP {r.status_code}")


# --------------------------------------------------------------------------------------------
# AVEVA PI (PI Web API)
# --------------------------------------------------------------------------------------------


class PiSource(Source):
    def __init__(self, *a: Any, http: Any = None):
        super().__init__(*a)
        import httpx

        auth = (self.config.get("user") or "", self.secrets.get("password") or "") if self.config.get("user") else None
        self.http = http or httpx.Client(timeout=60, auth=auth, verify=not self.config.get("insecure_tls"))
        self.base = str(self.config["url"]).rstrip("/")
        self.webids: dict[str, str] = {}
        for path in [p.strip() for p in str(self.config["points"]).splitlines() if p.strip()]:
            r = self.http.get(f"{self.base}/points", params={"path": path, "selectedFields": "WebId;Name"})
            if r.status_code >= 400:
                raise SourceError(f'PI point "{path}" was not found (HTTP {r.status_code})')
            self.webids[r.json()["WebId"]] = path
        self.last = self.state.setdefault("last", {})
        self.interval = float(self.config.get("poll_seconds") or 5)

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        start = min(self.last.values()) if len(self.last) == len(self.webids) and self.last else (self.config.get("start_time") or "*-1h")
        params: list[tuple[str, str]] = [("webId", w) for w in self.webids] + [("startTime", start), ("endTime", "*"), ("maxCount", str(max_records))]
        r = self.http.get(f"{self.base}/streamsets/recorded", params=params)
        if r.status_code >= 400:
            raise SourceError(f"PI Web API: HTTP {r.status_code} {r.text[:200]}")
        out = []
        for item in r.json().get("Items", []):
            w = item.get("WebId")
            for v in item.get("Items", []):
                ts = v.get("Timestamp")
                if self.last.get(w) and ts <= self.last[w]:
                    continue  # recorded values from startTime are inclusive
                value = v.get("Value")
                if isinstance(value, dict):  # digital states
                    value = value.get("Name", value.get("Value"))
                rec = {"point": self.webids.get(w, item.get("Name")), "value": value, "good": v.get("Good"), "questionable": v.get("Questionable"),
                       "substituted": v.get("Substituted"), "_key": item.get("Name"), "_timestamp": ts}
                out.append(Message(rec, (w, ts), 64))
        out.sort(key=lambda m: m.record["_timestamp"] or "")
        if not out:
            time.sleep(min(self.interval, timeout_s))
        return out[:max_records]

    def checkpoint(self, messages: list[Message]) -> None:
        for m in messages:
            w, ts = m.ack
            if ts > self.last.get(w, ""):
                self.last[w] = ts


# --------------------------------------------------------------------------------------------
# MQTT (ActiveMQ, Solace, IBM MQ MQTT channels, RabbitMQ MQTT plugin, any broker)
# --------------------------------------------------------------------------------------------


class MqttSource(Source):
    def __init__(self, *a: Any):
        super().__init__(*a)
        mqtt = _driver("paho.mqtt.client", "paho-mqtt")
        c = self.config
        self.q: "queue.Queue[Any]" = queue.Queue(maxsize=int(self.profile.get("buffer_records", 10_000)))
        self.qos = int(c.get("qos") or 1)
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=c.get("client_id") or "bluesandai-streaming", clean_session=False,
                                  protocol=mqtt.MQTTv311, manual_ack=True)
        if c.get("user"):
            self.client.username_pw_set(c["user"], self.secrets.get("password") or None)
        if c.get("tls"):
            self.client.tls_set()
        self.connected = queue.Queue()
        topics = [t.strip() for t in str(c["topics"]).split(",") if t.strip()]

        def on_connect(client: Any, userdata: Any, flags: Any, reason: Any, props: Any) -> None:
            if not reason.is_failure:
                client.subscribe([(t, self.qos) for t in topics])
            self.connected.put(reason)

        self.client.on_connect = on_connect
        self.client.on_message = lambda client, userdata, msg: self.q.put(msg)
        self.client.connect(c["host"], int(c.get("port") or 1883), keepalive=60)
        self.client.loop_start()
        try:
            reason = self.connected.get(timeout=15)
        except queue.Empty:
            raise SourceError("MQTT: the broker did not answer") from None
        if reason.is_failure:
            raise SourceError(f"MQTT: connection refused ({reason})")

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        out = []
        deadline = time.monotonic() + timeout_s
        while len(out) < max_records:
            try:
                msg = self.q.get(timeout=max(0.0, deadline - time.monotonic()) if not out else 0.05)
            except queue.Empty:
                break
            rec = decode(msg.payload, self.fmt)
            rec.update({"_key": msg.topic, "_timestamp": datetime.now(timezone.utc).isoformat(), "_topic": msg.topic, "_qos": msg.qos})
            out.append(Message(rec, (msg.mid, msg.qos), len(msg.payload)))
        return out

    def checkpoint(self, messages: list[Message]) -> None:
        for m in messages:
            mid, qos = m.ack
            if qos > 0:
                self.client.ack(mid, qos)

    def lag(self) -> Optional[float]:
        return float(self.q.qsize())  # received but not yet written

    def close(self) -> None:
        try:
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass


# --------------------------------------------------------------------------------------------
# RabbitMQ (AMQP 0-9-1)
# --------------------------------------------------------------------------------------------


class RabbitSource(Source):
    def __init__(self, *a: Any):
        super().__init__(*a)
        pika = _driver("pika", "pika")
        url = str(self.config["url"])
        params = pika.URLParameters(url)
        if self.config.get("user"):
            params.credentials = pika.PlainCredentials(self.config["user"], self.secrets.get("password") or "")
        self.conn = pika.BlockingConnection(params)
        self.ch = self.conn.channel()
        self.queue = self.config["queue"]

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        out = []
        while len(out) < max_records:
            method, props, body = self.ch.basic_get(self.queue, auto_ack=False)
            if method is None:
                break
            rec = decode(body, self.fmt)
            rec.update({"_key": props.message_id or props.correlation_id, "_timestamp": _iso(props.timestamp) if props.timestamp else None,
                        "_routing_key": method.routing_key, "_exchange": method.exchange})
            out.append(Message(rec, method.delivery_tag, len(body or b"")))
        if not out:
            self.conn.sleep(min(timeout_s, 1.0))
        return out

    def checkpoint(self, messages: list[Message]) -> None:
        if messages:
            self.ch.basic_ack(delivery_tag=max(m.ack for m in messages), multiple=True)

    def lag(self) -> Optional[float]:
        try:
            return float(self.ch.queue_declare(self.queue, passive=True).method.message_count)
        except Exception:
            return None

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass


# --------------------------------------------------------------------------------------------
# IBM MQ (pymqi)
# --------------------------------------------------------------------------------------------


class IbmMqSource(Source):
    def __init__(self, *a: Any):
        super().__init__(*a)
        pymqi = _driver("pymqi", "pymqi (with the IBM MQ client installed)")
        c = self.config
        self.pymqi = pymqi
        self.qmgr = pymqi.connect(c["queue_manager"], c.get("channel") or "DEV.APP.SVRCONN", f"{c['host']}({int(c.get('port') or 1414)})",
                                  c.get("user") or None, self.secrets.get("password") or None)
        self.queue = pymqi.Queue(self.qmgr, c["queue"])

    def poll(self, max_records: int, timeout_s: float) -> list[Message]:
        out = []
        gmo = self.pymqi.GMO(Options=self.pymqi.CMQC.MQGMO_WAIT | self.pymqi.CMQC.MQGMO_SYNCPOINT | self.pymqi.CMQC.MQGMO_FAIL_IF_QUIESCING, WaitInterval=int(timeout_s * 1000))
        while len(out) < max_records:
            md = self.pymqi.MD()
            try:
                body = self.queue.get(None, md, gmo)
            except self.pymqi.MQMIError as e:
                if e.reason == self.pymqi.CMQC.MQRC_NO_MSG_AVAILABLE:
                    break
                raise SourceError(f"IBM MQ: {e}") from None
            gmo.WaitInterval = 0
            rec = decode(body, self.fmt)
            rec.update({"_key": md.MsgId.hex(), "_timestamp": None})
            out.append(Message(rec, None, len(body)))
        return out

    def checkpoint(self, messages: list[Message]) -> None:
        if messages:
            self.qmgr.commit()

    def close(self) -> None:
        try:
            self.queue.close()
            self.qmgr.disconnect()
        except Exception:
            pass


SOURCES = {
    "kafka": KafkaSource,
    "kinesis": KinesisSource,
    "sqs": SqsSource,
    "pubsub": PubSubSource,
    "pi": PiSource,
    "mqtt": MqttSource,
    "rabbitmq": RabbitSource,
    "ibmmq": IbmMqSource,
}
