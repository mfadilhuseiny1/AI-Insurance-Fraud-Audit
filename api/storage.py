"""Result storage: Amazon S3 for uploaded files and parse results.

Layout in the S3 bucket (AWS_S3_BUCKET_NAME):
    files/<file_id>/source<ext>                 the uploaded document
    jobs/<job_id>/pages/<page:05d>.json.gz       public elements of one page (what the viewer loads)
    jobs/<job_id>/result.json.gz                 all public elements
    jobs/<job_id>/result.md, result.txt          downloads
    jobs/<job_id>/chunks.json.gz                 RAG chunks (text + pages + languages + element ids)
    jobs/<job_id>/internal.json.gz               elements with internal metadata (never served)
    drive/<item_id>                              a file in the Files tab (tree is in PostgreSQL)

Vector indexes (AWS_S3_VECTOR_STORE_BUCKET_NAME) are managed by vectors.py with this module's
AWS session.
"""

from __future__ import annotations

import gzip
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Any, BinaryIO, Callable, Optional
from urllib.parse import quote

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger("bluesandai.storage")

_settings: dict[str, str] = {}
_session: Optional[boto3.Session] = None


def init(env: Callable[[str], str]) -> bool:
    """Configure from the environment; returns False (storage stays local) if not configured."""
    global _session
    keys = ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_S3_BUCKET_NAME")
    if not all(env(k) for k in keys):
        return False
    _settings.update({k: env(k) for k in keys})
    _session = boto3.Session(
        aws_access_key_id=_settings["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=_settings["AWS_SECRET_ACCESS_KEY"],
        region_name=_settings["AWS_REGION"],
    )
    _s3().head_bucket(Bucket=_settings["AWS_S3_BUCKET_NAME"])
    return True


def enabled() -> bool:
    return _session is not None


@lru_cache(maxsize=1)
def _s3():
    return _session.client("s3")


@lru_cache(maxsize=1)
def s3vectors():
    """Amazon S3 Vectors client with the same credentials and region (used by vectors.py)."""
    return _session.client("s3vectors")


def _bucket() -> str:
    return _settings["AWS_S3_BUCKET_NAME"]


# ------------------------------------------------------------------------------------------------
# objects
# ------------------------------------------------------------------------------------------------


def put_file(key: str, path: str, content_type: str) -> None:
    _s3().upload_file(path, _bucket(), key, ExtraArgs={"ContentType": content_type})


def put_json(key: str, data: Any) -> None:
    body = gzip.compress(json.dumps(data, ensure_ascii=False).encode("utf-8"))
    _s3().put_object(Bucket=_bucket(), Key=key, Body=body, ContentType="application/json", ContentEncoding="gzip")


def put_text(key: str, text: str, content_type: str) -> None:
    _s3().put_object(Bucket=_bucket(), Key=key, Body=text.encode("utf-8"), ContentType=f"{content_type}; charset=utf-8")


def get_json(key: str) -> Any:
    obj = _s3().get_object(Bucket=_bucket(), Key=key)
    body = obj["Body"].read()
    if obj.get("ContentEncoding") == "gzip" or key.endswith(".gz"):
        body = gzip.decompress(body)
    return json.loads(body)


def get_text(key: str) -> str:
    return _s3().get_object(Bucket=_bucket(), Key=key)["Body"].read().decode("utf-8")


def exists(key: str) -> bool:
    try:
        _s3().head_object(Bucket=_bucket(), Key=key)
        return True
    except ClientError:
        return False


def download_file(key: str, path: str) -> None:
    _s3().download_file(_bucket(), key, path)


def open_stream(key: str) -> BinaryIO:
    """A readable (and closable) stream of an object, for copying without loading it all."""
    return _s3().get_object(Bucket=_bucket(), Key=key)["Body"]


def copy(src_key: str, dst_key: str) -> None:
    _s3().copy({"Bucket": _bucket(), "Key": src_key}, _bucket(), dst_key)


def put_fileobj(key: str, fileobj: BinaryIO, content_type: str) -> None:
    _s3().upload_fileobj(fileobj, _bucket(), key, ExtraArgs={"ContentType": content_type})


def presigned_url(
    key: str, filename: str, expires: int = 600, inline: bool = False, content_type: Optional[str] = None
) -> str:
    """A temporary link to an object; inline=True lets the browser show it instead of saving it."""
    # filename* (RFC 5987) carries non-ASCII names; filename= is the ASCII fallback
    ascii_name = filename.encode("ascii", "replace").decode().replace('"', "'").replace("?", "_")
    disposition = f"{'inline' if inline else 'attachment'}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
    params = {"Bucket": _bucket(), "Key": key, "ResponseContentDisposition": disposition}
    if content_type:
        params["ResponseContentType"] = content_type
    return _s3().generate_presigned_url("get_object", Params=params, ExpiresIn=expires)


def delete_keys(keys: list[str]) -> None:
    for i in range(0, len(keys), 1000):  # DeleteObjects limit
        _s3().delete_objects(Bucket=_bucket(), Delete={"Objects": [{"Key": k} for k in keys[i : i + 1000]]})


def purge_versions(key: str) -> int:
    """Delete every non-current version (and delete marker) of one object, for buckets with versioning: what Data
    Lifetime deleted must not survive as an older version. Returns how many were removed; 0 without versioning."""
    s3 = _s3()
    removed = 0
    paginator = s3.get_paginator("list_object_versions")
    for page in paginator.paginate(Bucket=_bucket(), Prefix=key):
        old = [{"Key": v["Key"], "VersionId": v["VersionId"]} for v in page.get("Versions", []) if v["Key"] == key and not v.get("IsLatest")]
        old += [{"Key": m["Key"], "VersionId": m["VersionId"]} for m in page.get("DeleteMarkers", []) if m["Key"] == key]
        for i in range(0, len(old), 1000):
            s3.delete_objects(Bucket=_bucket(), Delete={"Objects": old[i:i + 1000], "Quiet": True})
            removed += len(old[i:i + 1000])
    return removed


def delete_prefix(prefix: str) -> None:
    paginator = _s3().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=_bucket(), Prefix=prefix):
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if keys:
            _s3().delete_objects(Bucket=_bucket(), Delete={"Objects": keys})


def save_job_results(
    job_id: str, internal: list[dict], public: list[dict], markdown: str, text: str, chunks: list[dict]
) -> None:
    """Upload a finished job: one object per page (what the viewer reads) plus whole-job files."""
    by_page: dict[int, list[dict]] = {}
    for e in public:
        by_page.setdefault(e["metadata"].get("page_number") or 0, []).append(e)
    prefix = f"jobs/{job_id}"
    # one object per page; uploaded in parallel (sequential PUTs to a distant region take
    # minutes for a 1,000-page book)
    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(lambda item: put_json(f"{prefix}/pages/{item[0]:05d}.json.gz", item[1]), by_page.items()))
    put_json(f"{prefix}/result.json.gz", public)
    put_json(f"{prefix}/internal.json.gz", internal)
    put_json(f"{prefix}/chunks.json.gz", chunks)
    put_text(f"{prefix}/result.md", markdown, "text/markdown")
    put_text(f"{prefix}/result.txt", text, "text/plain")
