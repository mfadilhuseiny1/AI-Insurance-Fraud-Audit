"""Smoke test: the realtime engine warmed on the testing copy, one replayed claim ingested, its decision printed."""
import os
import sys
import time
from pathlib import Path

os.environ["BLUESANDAI_AUTH"] = "off"
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
from mailer import env  # noqa: E402
from aip import vertex  # noqa: E402

vertex.configure(ROOT / ".tmp" / "testing-data", env)
sys.path.insert(0, str(ROOT / "testing"))
import platform_lokal  # noqa: E402

platform_lokal.pasang()
from aip.realtime import mesin as E  # noqa: E402
from aip import layanan as L  # noqa: E402
import pandas as pd  # noqa: E402

t0 = time.time()
E.ENGINE.start(None)
while not E.ENGINE.ready():
    time.sleep(1)
    if time.time() - t0 > 900:
        sys.exit("engine not ready: " + str(E.ENGINE.error))
print("ready in", round(time.time() - t0), "s;", E.ENGINE.warm_info.get("dipulihkan"))
df = pd.read_parquet(ROOT / "data" / "aip" / "realtime" / "replay_fkrtl_2024-12-18_2024-12-31.parquet")
print("replay columns:", list(df.columns)[:60])
row = df.iloc[0].to_dict()
fields = set(L.KlaimIn.model_fields)
body = {k: v for k, v in row.items() if k in fields and not (v is None or (isinstance(v, float) and pd.isna(v)))}
body["kunjungan_fkrtl_id"] = "UJI-" + str(int(time.time()))
k = L.KlaimIn.model_validate(body)
ids = E.ENGINE.ingest([k], "testing:uji")
dec = E.ENGINE.wait(ids, 60)[0]
print("decision keys:", sorted(dec.keys()) if dec else None)
if dec:
    print({x: dec.get(x) for x in ("keputusan", "skor", "faskes_label", "peserta", "kode", "tgl_datang")})
    print("signals:", [s.get("kode") for s in dec.get("sinyal") or []], "| ssl x len:", len((dec.get("ssl") or {}).get("x") or []))
E.ENGINE.stop()
