"""Unit tests of the realtime fraud rules (aip/realtime): no API, no data files; each rule on hand-made events.

    ..\\.venv\\Scripts\\python.exe -m pytest test_aip_realtime.py -q
"""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

from aip.realtime import aturan_rt as A
from aip.realtime import fktp as F
from aip.realtime import graf as G
from aip.realtime import mesin as E
from aip.realtime import modus as MO


def claim(key: str, pid: int, f: str = "F1", d: date = date(2024, 12, 20), los: int = 3, ritl: bool = True, kode: str = "J-4-16-I",
          dx3: str = "J18", **kv) -> dict:
    c = {"key": key, "pid": pid, "f": f, "kab": 3273, "kab_nama": "KOTA BANDUNG", "prov": "JAWA BARAT", "tipe": "RS Kelas B", "rank": 3, "d": d,
         "p": d + timedelta(days=los if ritl else 0), "ritl": ritl, "kode": kode, "dx3": dx3, "sev3": False, "biaya": 5_000_000, "tarif_total": 5_000_000,
         "los": los, "prosedur": None, "status_pulang": "Sehat", "poli": None, "iomt": {}, "faskes_label": f, "idx_los": 1.0}
    c.update(kv)
    return c


def codes(sigs: list[dict]) -> set[str]:
    return {s["kode"] for s in sigs}


def graf() -> G.Graf:
    return G.Graf({}, {}, 0.05, {})


def test_every_signal_has_modes_tag_and_weight():
    assert all(isinstance(v[0], list) and v[2] > 0 and v[3] for v in MO.SIGNALS.values())
    covered = {m for v in MO.SIGNALS.values() for m in v[0]}
    # the 20 modes minus M19 (= M07)
    assert covered == {f"M{i:02d}" for i in range(1, 21)} - {"M19"}


def test_overlapping_stays_at_two_facilities():
    g = graf()
    g.add(claim("a", 1, "F1", los=5))
    s = g.add(claim("b", 1, "F2", d=date(2024, 12, 22), kab=1171))
    assert "RAWAT_INAP_TUMPANG_TINDIH" in codes(s)


def test_duplicate_and_resubmission():
    g = graf()
    g.add(claim("a", 1))
    assert "KLAIM_GANDA_STREAM" in codes(g.add(claim("b", 1)))
    g2 = graf()
    g2.add(claim("a", 1))
    g2.remove("a")  # a hospital's amendment replaces the earlier version
    assert "KLAIM_GANDA_STREAM" not in codes(g2.add(claim("a", 1)))


def test_split_episode_same_day_shifted_repeat_and_readmission():
    g = graf()
    g.add(claim("a", 1, los=2))
    assert "PEMECAHAN_EPISODE" in codes(g.add(claim("b", 1, d=date(2024, 12, 23))))
    g = graf()
    g.add(claim("a", 1, ritl=False, kode="Q-5-44-0"))
    assert "EPISODE_HARI_SAMA" in codes(g.add(claim("b", 1)))
    g = graf()
    g.add(claim("a", 1, los=4))
    assert "KLAIM_BERULANG_MIRIP" in codes(g.add(claim("b", 1, d=date(2024, 12, 21))))
    g = graf()
    g.add(claim("a", 1, los=2))
    assert "READMISI_DX_SAMA" in codes(g.add(claim("b", 1, d=date(2024, 12, 22) + timedelta(days=10))))


def test_death_recorded_in_the_stream():
    g = graf()
    g.add(claim("a", 7, status_pulang="Meninggal", los=2))
    assert g.deaths[7] == date(2024, 12, 22)
    c = SimpleNamespace(tgl_datang=date(2024, 12, 26), peserta_id=7, edisi="reguler", dx_primer_icd3="J18", inacbg_kode="J-4-16-I", kelas_rawat="Kelas 3",
                        tingkat_pelayanan="RJTL", prosedur=None, jumlah_dx_sekunder=0, **{k: 0 for k in A.TOPUPS})
    R = SimpleNamespace(rare_pair=lambda dx, code: None, kode={}, topup={}, family=lambda *a: [])
    assert "MENINGGAL_TERCATAT" in codes(A.claim_rules(c, {"f": "F1"}, None, R, None, {}, g.deaths))


def test_card_holder_mismatch_and_class():
    assert A.mismatch("O80", "O-6-10-I", "L", 30) is not None
    assert A.mismatch("N40", "N-1-01-I", "P", 60) is not None
    assert A.mismatch("O80", "O-6-10-I", "P", 28) is None
    c = SimpleNamespace(tgl_datang=date(2024, 12, 20), peserta_id=9, edisi="reguler", dx_primer_icd3="O80", inacbg_kode="O-6-10-I", kelas_rawat="Kelas 1",
                        tingkat_pelayanan="RITL", prosedur=None, jumlah_dx_sekunder=0, **{k: 0 for k in A.TOPUPS})
    wife = {"peserta_id": 10, "jk": "P", "tgl_lahir": date(1995, 1, 1)}
    R = SimpleNamespace(rare_pair=lambda dx, code: None, kode={}, topup={}, family=lambda con, ed, kel, but: [wife])
    m = {"jk": "L", "tgl_lahir": date(1990, 1, 1), "hak": 3, "segmen": "PBI APBN", "keluarga_id": 5, "tahun_meninggal": float("nan")}
    got = codes(A.claim_rules(c, {"f": "F1"}, m, R, None, {}, {}))
    assert {"TIDAK_SESUAI_PESERTA", "KARTU_KELUARGA", "KELAS_DI_ATAS_HAK"} <= got


def test_procedure_group_without_procedure_and_hospital_lines():
    c = SimpleNamespace(tgl_datang=date(2024, 12, 20), peserta_id=9, edisi="faskes", dx_primer_icd3="K80", inacbg_kode="K-1-12-I", kelas_rawat="Kelas 3",
                        tingkat_pelayanan="RITL", prosedur=None, jumlah_dx_sekunder=0, **{k: 0 for k in A.TOPUPS})
    R = SimpleNamespace(rare_pair=lambda dx, code: None, kode={}, topup={}, family=lambda *a: [])
    meta = {"obat": [{"nama": "A", "diresepkan": 10, "ditagih": 10, "diserahkan": 4}, {"nama": "B", "ditagih": 3, "diserahkan": 0}],
            "pemeriksaan": [{"parameter": "Hb", "nilai_klaim": 6.0, "nilai_alat": 12.0, "toleransi": 0.1}]}
    got = codes(A.claim_rules(c, {"f": "F1"}, None, R, None, meta, {}))
    assert {"KODE_PROSEDUR_TANPA_TINDAKAN", "OBAT_DIKURANGI", "OBAT_TIDAK_DISERAHKAN", "HASIL_PEMERIKSAAN_TIDAK_COCOK"} <= got


def test_nonkap_rules():
    R = SimpleNamespace(nonkap_tindakan={"Pelayanan KB : Suntik": {"n": 100, "median": 20000, "p95": 25000}}, nonkap_fac={}, fktp={}, fktp_dest={}, unit={})
    s = F.FktpState(R, {})
    n = SimpleNamespace(kunjungan_id="k1", edisi="reguler", peserta_id=3, tgl_kunjungan=date(2024, 12, 20), tgl_tindakan=date(2024, 12, 20), tgl_pulang=None,
                        kabkota_faskes_kode=3273, kabkota_faskes="KOTA BANDUNG", kepemilikan_faskes="PEMKAB", jenis_faskes="PUSKESMAS", tipe_faskes=None,
                        tindakan="Pelayanan KB : Suntik", tindakan_ke=1, biaya_tagih_rp=90000)
    _, sigs = s.nonkap(n, {"jk": "L"}, 30.0)
    assert {"NONKAP_TIDAK_SESUAI_PESERTA", "NONKAP_TARIF"} <= codes(sigs)
    _, sigs = s.nonkap(SimpleNamespace(**{**vars(n), "kunjungan_id": "k2"}), {"jk": "P"}, 30.0)
    assert "NONKAP_GANDA" in codes(sigs)


def test_active_learning_strategies_and_committee():
    import numpy as np

    from aip.realtime import aktif as AL

    rng = np.random.default_rng(1)
    n = 600
    X = rng.normal(size=(n, len(AL.NAMES))).astype(np.float32)
    y = (X[:, 0] + 0.5 * X[:, 1] > 1.2).astype(int)
    ia = AL.NAMES.index("skor_aturan")
    X[:, ia] = 50 * y + rng.normal(0, 20, n)
    cold, why = AL.query("hibrida", None, X, 10, rng)  # no model yet: half the rule score's top, half diverse
    assert len(set(cold)) == 10 and any("awal dingin" in w for w in why)
    kom = AL.fit(X[:200], y[:200], seed=1)
    p, sd = kom.predict(X[200:])
    assert len(p) == 400 and (sd >= 0).all() and AL.auprc(y[200:], p) > y[200:].mean() * 2
    for s in AL.STRATEGIES:
        idx, why = AL.query(s, kom, X[200:], 15, rng, X[:200])
        assert len(set(idx)) == 15 and len(why) == 15


def test_operating_points_compare_rules_and_model():
    import numpy as np

    from aip.realtime import aktif as AL

    y = np.array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0])
    op = AL._op(y, np.array([True, False, True, False, False, False, False, False, False, False]))
    assert op == {"alarm": 2, "laju_alarm": 0.2, "presisi": 0.5, "recall": 0.5, "tp": 1}
    rng = np.random.default_rng(3)
    X = rng.normal(size=(300, len(AL.NAMES))).astype(np.float32)
    yy = (X[:, 0] > 1.5).astype(int)
    X[:, AL.NAMES.index("skor_aturan")] = 60 * yy + rng.normal(0, 15, 300)
    kom = AL.fit(X[:200], yy[:200], seed=0)
    evs = [{"keputusan": "PERIKSA" if s >= 45 else "LOLOS"} for s in X[200:, AL.NAMES.index("skor_aturan")]]
    out = AL.operating_points(evs, yy[200:], kom, X[200:])
    assert len(out["model"]) == len(AL.AMBANG) and out["kalibrasi"]["positif_teramati"] == int(yy[200:].sum())
    assert sum(b["n"] for b in out["kalibrasi"]["bin"]) == 100  # every test event in exactly one calibration bin
    assert [m["alarm"] for m in out["model"]] == sorted((m["alarm"] for m in out["model"]), reverse=True)  # higher threshold, fewer alerts


def test_ssl_scale_floor_for_near_constant_features():
    import pandas as pd

    from aip.realtime import ssl as SSL

    df = pd.DataFrame({"kembar": [1.0] * 999 + [2.0], "biaya_tagih": range(1000)})
    prep = SSL.Prep.fit(SSL.FKRTL, df)
    assert prep.iqr["kembar"] >= 0.1  # a one-step change cannot explode to the clip value
    z = prep.transform(df.tail(1))
    assert abs(z[0, SSL.FKRTL.num.index("kembar")]) < 8


def _fktp_rows(n: int) -> "object":
    import pandas as pd

    rows = []
    for i in range(n):
        rows.append({"edisi": "reguler", "peserta_id": i, "tgl_datang": date(2024, 11, 1) + timedelta(days=i % 20), "tgl_pulang": None,
                     "kabkota_fktp_kode": 3273, "kepemilikan_fktp": "PEMKAB", "jenis_fktp": "PUSKESMAS", "tipe_fktp": "NON RAWAT INAP",
                     "tingkat_pelayanan": "RJTP", "poli": ["POLI UMUM", "POLI KIA", None][i % 3], "jenis_kunjungan": "KUNJUNGAN SAKIT",
                     "status_pulang": "RUJUK LANJUT" if i % 7 == 0 else "BEROBAT JALAN", "dx_icd3": ["J06", "I10", "O80"][i % 3],
                     "kabkota_rujukan_kode": 3204 if i % 7 == 0 else None, "tipe_faskes_rujukan": "RS Kelas C" if i % 7 == 0 else None,
                     "jk": "P" if i % 3 == 2 else ["L", "P"][i % 2], "tgl_lahir": date(1980 + i % 30, 1, 1), "unit_terdaftar": "3273|PEMKAB|PUSKESMAS", "segmen": "PBI APBN"})
    return pd.DataFrame(rows)


def test_ssl_fktp_inputs_pairs_and_raw_roundtrip():
    import numpy as np
    import torch

    from aip.realtime import ssl as SSL

    R = SimpleNamespace(fktp={}, nonkap_tindakan={}, nonkap_fac={})
    base = SSL.base_fktp(_fktp_rows(300), R)
    assert list(base.columns) == SSL.FKTP.base_cols
    assert base["unit_sama"].eq(1).all() and base["poli"].isin(SSL.POLI).all()  # a missing poli is its own category
    tabs = SSL.fit_tables(SSL.FKTP, base)
    fr = SSL.derive(SSL.FKTP, base, tabs)
    # pointwise mutual information: a seen pair is usual, an unseen one is not
    probe = base.head(2).copy()
    probe.loc[probe.index[1], "jk"] = "L"
    probe.loc[probe.index[1], "dx"] = "O80"  # a delivery for a man never occurs in the training rows
    pm = SSL.derive(SSL.FKTP, probe, tabs)["pmi_jk_dx"].to_numpy()
    assert pm[1] < pm[0] and set(SSL.FKTP.derived) <= set(fr.columns)
    prep = SSL.Prep.fit(SSL.FKTP, fr)
    torch.manual_seed(0)
    m = SSL.Model(SSL.FKTP, prep, tabs, SSL._net(len(prep.names)).eval(), {"versi": "v1", "ambang": {"p50": 0.0, "p99": 0.0, "p999": 1e9}})
    recs = m.score_events(base)
    again = m.score_events(m.from_x([r["x"] for r in recs]))  # re-embedding from the stored raw inputs gives the same result
    assert np.allclose([r["err"] for r in recs], [r["err"] for r in again], atol=1e-5)
    assert recs[0]["spek"] == SSL.FKTP.key() and recs[0]["alasan"]  # above p99 (0 here): explained, largest share first
    assert recs[0]["alasan"][0]["porsi"] >= recs[0]["alasan"][-1]["porsi"]


def test_ssl_fieldwise_groups_cover_every_dimension_once():
    import pandas as pd

    from aip.realtime import ssl as SSL

    prep = SSL.Prep(SSL.NONKAP, {c: 0.0 for c in SSL.NONKAP.num}, {c: 1.0 for c in SSL.NONKAP.num})
    dims = sorted(d for _, ds in prep.fields for d in ds)
    assert dims == list(range(len(prep.names)))
    z = prep.transform(pd.DataFrame([{"kelompok": "ANC", "jk": "L"}]))
    for k, vs in SSL.NONKAP.cats.items():  # a category block is one-hot or all zeros, never two at once
        blk = [d for name, ds in prep.fields if name == k for d in ds]
        assert z[0, blk].sum() <= 1
    assert SSL.kelompok("Pelayanan ANC 4 (Empat) oleh Bidan") == "ANC" and SSL.kelompok("Gula Darah Puasa (GDP) - Skrining DM") == "SKRINING_DM"


def test_adaptive_features_only_from_known_ssl_versions_and_refresh():
    import numpy as np

    from aip.realtime import aktif as AL

    e = {"jenis": "fkrtl", "sinyal": [], "skor": 10, "ssl": {"versi": "a", "err": 0.5, "emb": [1.0] * AL.EMB}}
    i = AL.NAMES.index("emb0")
    assert AL.vec(e, {"fkrtl": "a"})[i] == 1.0
    assert np.isnan(AL.vec(e, {"fkrtl": "b"})[i])  # another embedding space is left out, not mixed in
    assert np.isnan(AL.vec(e, {})[i])
    stale = [{"jenis": "fkrtl", "ssl": {"versi": "old", "err": 1.0, "emb": [0.0] * AL.EMB}}]  # no raw inputs kept
    n = AL.refresh(stale, {"fkrtl": SimpleNamespace(versi="new", spec=SimpleNamespace(key=lambda: "k"))})
    assert n == {"diperbarui": 0, "dibuang": 1} and stale[0]["ssl"] is None


def test_simulator_resends_a_batch_the_full_queue_refused():
    from fastapi import HTTPException

    from aip.realtime import simulator as S

    class Eng:
        calls = 0

        def ingest(self, objs, sumber, metas, kinds=None):
            Eng.calls += 1
            if Eng.calls == 1:
                raise HTTPException(429, "antrean penuh")
            return [f"ev{i}" for i in range(len(objs))]

        store = SimpleNamespace(add_truth=lambda rows: None)

    sim = S.Simulator(Eng())
    S.time.sleep = lambda s: None  # no waiting in the test
    body = {"_t": "fktp", "kunjungan_fktp_id": "K1", "edisi": "reguler", "peserta_id": 1, "tgl_datang": "2024-12-20", "kabkota_fktp_kode": 3273,
            "kepemilikan_fktp": "PEMKAB", "jenis_fktp": "PUSKESMAS"}
    batch = [("fktp", body, ("normal", None, None), {})]
    assert sim._send(batch) is False and sim.emitted == 0 and sim.waits == 1  # refused: the caller keeps it
    assert sim._send(batch) is True and sim.emitted == 1


def test_document_request_draft_one_item_per_topic_and_nothing_internal():
    from aip.realtime import permintaan as PM

    e = {"ssl": {"alasan": [
        {"fitur": "kembar", "label": "klaim kembar", "nilai": "4,00", "pola": "1,00", "arah": "lebih tinggi", "porsi": 0.45},
        {"fitur": "rasio_tagih_tarif", "label": "rasio tagihan terhadap tarif", "nilai": "16,58", "pola": "1,02", "arah": "lebih tinggi", "porsi": 0.44},
        {"fitur": "f_pct_kembar", "label": "porsi klaim kembar faskes", "nilai": "0,1", "pola": "0,0", "arah": "lebih tinggi", "porsi": 0.11}]},
         "sinyal": [{"kode": "KLAIM_GANDA_STREAM", "kontribusi": 1.6, "bukti": "... sudah diklaim dengan id ai-jkn.xyz (internal)"},
                    {"kode": "TAGIHAN_MELEBIHI_TARIF", "kontribusi": 0.3, "bukti": "tagihan 16.58× tarif"},
                    {"kode": "LOS_DIPERPANJANG", "kontribusi": 0.5, "bukti": "LOS 23 hari"},
                    {"kode": "RISIKO_ASOSIASI", "kontribusi": 0.07, "bukti": "faskes ini di Box Karantina"}]}
    d = PM.draft(e)
    docs = [b["dokumen"] for b in d["butir"]]
    assert len(d["butir"]) == 3  # duplicate (SSL kembar + rule), bill (SSL ratio + rule), length of stay (rule)
    assert d["butir"][0]["asal"] == "self-supervised" and "4,00" in d["butir"][0]["isi"]
    assert not any("Box" in x or "internal" in x for b in d["butir"] for x in b.values())  # rule evidence never copied
    assert not any("porsi klaim kembar faskes" in b["isi"] for b in d["butir"])  # facility-profile fields are not asked of a claim
    hosp = PM.for_hospital({"id": "pd-1", "dibuat": "t", "status": "terkirim", "pesan": "p", "butir": d["butir"], "oleh": "u1"})
    assert "oleh" not in hosp and all(set(b) == {"medan", "isi", "dokumen"} for b in hosp["butir"]) and len(set(docs)) == len(docs)


def test_ssl_drift_test():
    from aip.realtime import ssl as SSL

    assert SSL.drift(10_000, 105, 12)["status"] == "stabil"
    assert SSL.drift(10_000, 400, 60)["status"] == "drift"
    assert SSL.drift(100, 50, 50)["status"] == "terlalu sedikit data"


def test_score_uses_catalogue_weights_and_mitigation():
    sigs = [G.sig("KLAIM_GANDA_STREAM", "", None, 1.0, 0, ("faskes", "F1"), "x")]
    sc, raw, dec, _ = E.score(sigs, {}, 45, 75)
    assert dec == "TAHAN" and sigs[0]["w"] == MO.SIGNALS["KLAIM_GANDA_STREAM"][2]
    sigs = [G.sig("KELAS_DI_ATAS_HAK", "", None, 1.0, 0, ("faskes", "F1"), "x", [], [{"kode": "M", "label": "m", "faktor": 0.6}])]
    sc, raw, dec, dec_raw = E.score(sigs, {}, 45, 75)
    assert sc < raw and dec == "LOLOS" and dec_raw == "PERIKSA"
    sigs = [G.sig("KELAS_DI_ATAS_HAK", "", None, 1.0, 0, ("faskes", "F1"), "x")]
    assert E.score(sigs, {"KELAS_DI_ATAS_HAK": 0.3}, 45, 75)[2] == "LOLOS"  # a recalibrated weight overrides the default


def test_precheck_lists_documents_and_own_conflicts_never_a_score(tmp_path):
    import json

    from aip.realtime import precheck as PC
    from aip.realtime.entitas import Resolver
    from aip.realtime.store import Store

    st = Store(tmp_path / "rt.sqlite")
    res = Resolver(st)
    ent = res.resolve("ai-jkn", "RM-1", "Budi Santoso")
    # this hospital's earlier submission for the same patient (1-5 Nov), scored TAHAN by the engine
    st.add_events([{"id": "ev1", "klaim": "faskes:ai-jkn.k1", "sumber": "faskes:ai-jkn", "diterima": 0, "diputus": 0, "latensi_ms": 1, "skor": 81.5,
                    "keputusan": "TAHAN", "faskes": "F", "peserta": ent["peserta_id"], "kasus": None, "entitas": ent, "tgl_datang": "2026-11-01",
                    "tgl_pulang": "2026-11-05", "kode": "J-4-16-III", "tanda_terima": "tt-1"}])
    for i in (1, 2):  # the verifier asked this hospital twice for the same document on that CMG
        st.add_request({"id": f"pd-{i}", "peristiwa": "ev1", "tanda_terima": "tt-1", "sumber": "ai-jkn", "klaim": "k1", "status": "terkirim",
                        "dibuat": f"2026-11-0{5 + i}", "butir": [{"medan": "x", "isi": "y", "dokumen": "Hasil laboratorium darah lengkap"}]})
    los_ref = {"J-4-16-III": (6.0, 10.0)}
    p = PC.PrecheckIn(no_rm="rm-1", jenis_episode="ri", tanggal_masuk=date(2026, 11, 4), tanggal_pulang=date(2026, 11, 20), diagnosis_utama="J18.9",
                      diagnosis_sekunder=["E11.9"], tindakan=["96.04"], inacbg_kode="J-4-16-III", kelas_rawat=1, hak_kelas=2, topup_kode="DD01")
    out = PC.run(p, st, res, los_ref, "2026-11-10T08:00:00")
    kodes = {d["kode"] for d in out["dokumen"]}
    assert kodes == {"laporan_tindakan", "penunjang_dx_sekunder", "cppt", "naik_kelas", "topup", "riwayat_permintaan"}
    assert [w["kode"] for w in out["peringatan"]] == ["beririsan"]  # its own earlier claim overlaps the draft
    flat = json.dumps({k: v for k, v in out.items() if k != "catatan"})
    assert "TAHAN" not in flat and "81.5" not in flat and "skor" not in flat and "sinyal" not in flat  # never the engine's view
    # a readmission three days after that stay asks for the earlier resume, without a conflict
    out2 = PC.run(p.model_copy(update={"tanggal_masuk": date(2026, 11, 8), "tanggal_pulang": date(2026, 11, 10)}), st, res, los_ref, "2026-11-10T08:01:00")
    assert "resume_sebelumnya" in {d["kode"] for d in out2["dokumen"]} and not out2["peringatan"]
    # the same draft checked again after an edit: the auditor sees what changed, billing fields only
    PC.run(p.model_copy(update={"inacbg_kode": "J-4-16-II"}), st, res, los_ref, "2026-11-10T08:02:00")
    h = PC.history(st, "ai-jkn", out["kunci_draf"])
    assert len(h) == 2 and h[1]["berubah"] == [{"medan": "inacbg", "dari": "J-4-16-III", "ke": "J-4-16-II"}]
    assert "Budi" not in json.dumps(h)
    # the submission carries the same key (integrasi.map_faskes), so the auditor can join them
    assert PC.draft_key("ai-jkn", " rm-1 ", date(2026, 11, 4)) == out["kunci_draf"]
    # a submission accepted a moment ago but not decided yet (still in the engine's queue) is already a conflict
    PC.ACCEPTED.add("ai-jkn", ent["entitas"], "k2", date(2026, 11, 25), date(2026, 11, 28), "tt-2")
    queued = PC.run(p.model_copy(update={"tanggal_masuk": date(2026, 11, 26), "tanggal_pulang": date(2026, 11, 27)}), st, res, los_ref, "2026-11-10T08:04:00")
    assert [w["kode"] for w in queued["peringatan"]] == ["beririsan"]
    assert not PC.run(p.model_copy(update={"klaim_id": "k2", "tanggal_masuk": date(2026, 11, 26), "tanggal_pulang": date(2026, 11, 27)}), st, res, los_ref,
                      "2026-11-10T08:05:00")["peringatan"]  # its own re-submission is not a conflict
    # another hospital's pre-check never sees this hospital's claims
    other = PC.run(p.model_copy(update={"sumber": "rs-lain"}), st, res, los_ref, "2026-11-10T08:03:00")
    assert not other["peringatan"] and "riwayat_permintaan" not in {d["kode"] for d in other["dokumen"]}
