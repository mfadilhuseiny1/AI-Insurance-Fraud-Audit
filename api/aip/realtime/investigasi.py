"""What an investigator gets beside a case, and what the case decisions teach the engine.

brief (Quantexa's Q Assist report, written here from templates, no model): the finding in one paragraph, the modes of
Permenkes 16/2019 it points to with the documents each needs, the strongest evidence in the words of the signals, the
entities and the network around them, the money at stake, the next steps and what the data cannot show. Every sentence
is built from the case's own events; nothing is inferred beyond them.

weights (the feedback loop): each signal's precision among the cases people decided — confirmed against false
positive — as a Beta(2, 2) posterior; a proposed weight = default × clip(posterior / 0.5, 0.5, 1.6). Applied by an admin
(config "bobot"), the engine scores the next events with it. The verifier's correction label of the replayed claims is
shown beside it as information only (it measures coding corrections, not fraud). labels: the decided cases' events as
rows (signals, modes, the decision) for retraining a model.
"""

from __future__ import annotations

import collections
import json
from typing import Any

from aip.realtime import modus as MO

PRIOR = (2.0, 2.0)


def _rp(n: float) -> str:
    if n >= 1e9:
        return f"Rp{n / 1e9:.2f} miliar".replace(".", ",")
    if n >= 1e6:
        return f"Rp{n / 1e6:.1f} juta".replace(".", ",")
    return f"Rp{n:,.0f}".replace(",", ".")


def brief(engine: Any, case: dict) -> dict:
    evs = engine.store.events_of(case["peristiwa"])
    evs.sort(key=lambda e: e.get("seq") or 0)
    if not evs:
        return {"kasus": case["id"], "ringkasan": "Kasus belum memuat peristiwa."}
    kinds = collections.Counter(e.get("jenis", "fkrtl") for e in evs)
    sig_n: collections.Counter = collections.Counter()
    best: dict[str, dict] = {}
    for e in evs:
        for s in e["sinyal"]:
            if s["kontribusi"] <= 0:
                continue
            sig_n[s["kode"]] += 1
            if s["kode"] not in best or s["kontribusi"] > best[s["kode"]]["kontribusi"]:
                best[s["kode"]] = {**s, "peristiwa": e["id"], "kunjungan": e["kunjungan"], "tanggal": e.get("tgl_datang")}
    modes = collections.Counter(m for e in evs for m in e.get("modus") or [])
    facilities = collections.Counter(e["faskes_label"] for e in evs)
    members = {e.get("peserta") for e in evs if e.get("peserta")}
    money = sum(e.get("biaya") or 0 for e in evs)
    held = sum(e.get("biaya") or 0 for e in evs if e["keputusan"] == "TAHAN")
    dates = sorted(e.get("tgl_datang") for e in evs if e.get("tgl_datang"))
    mit = collections.Counter(x["label"] for e in evs for s in e["sinyal"] for x in s.get("mitigasi") or [])
    who = {"faskes": "Faskes", "peserta": "Peserta", "jaringan": "Jaringan faskes"}[case["jenis"]]
    top_modes = [m for m, _ in modes.most_common()]
    names = {m: MO.MODES.get(m, {}).get("nama", m) for m in top_modes}
    kind_txt = ", ".join(f"{n} {'klaim FKRTL' if k == 'fkrtl' else 'kunjungan FKTP' if k == 'fktp' else 'klaim nonkapitasi' if k == 'nonkap' else 'temuan pemantauan'}"
                         for k, n in kinds.most_common())
    para = (f"{who} {case['judul']}: {len(evs)} peristiwa yang di-alert ({kind_txt}) antara {dates[0] if dates else '-'} dan {dates[-1] if dates else '-'}, "
            f"{case['tahan_n']} ditahan, skor tertinggi {case['skor_maks']:.0f}. "
            + (f"Polanya menunjuk ke {', '.join(f'{m} {names[m]}' for m in top_modes[:3])}. " if top_modes else "")
            + (f"Tagihan yang terkait {_rp(money)}, {_rp(held)} di antaranya pada klaim yang ditahan. " if money else "")
            + (f"{len(members)} peserta dan {len(facilities)} faskes terlibat." if case["jenis"] != "peserta" else f"Klaim di {len(facilities)} faskes."))
    evidence = [{"sinyal": b["label"], "kode": k, "modus": b.get("modus") or [], "jumlah": sig_n[k], "bukti": b["bukti"], "contoh": b["kunjungan"],
                 "tanggal": b["tanggal"], "kontribusi": b["kontribusi"]}
                for k, b in sorted(best.items(), key=lambda kv: -kv[1]["kontribusi"] * (1 + 0.1 * sig_n[kv[0]]))[:8]]
    steps = []
    for m in top_modes[:4]:
        md = MO.MODES.get(m) or {}
        steps.append({"modus": m, "nama": md.get("nama", m), "minta": md.get("dokumen"), "cara": md.get("cara")})
    if case["jenis"] == "jaringan":
        steps.append({"modus": "M10", "nama": "Jaringan", "minta": "kepemilikan dan kerja sama antarfaskes di cincin, pola rujukan masuk/keluar",
                      "cara": "periksa apakah peserta yang sama berpindah antarfaskes tanpa indikasi"})
    if case["jenis"] == "peserta":
        steps.append({"modus": "M06", "nama": "Identitas", "minta": "verifikasi identitas peserta (sidik jari/face recognition di SEP), keluarga",
                      "cara": "pastikan pemegang kartu adalah pasien di setiap klaim"})
    limits = []
    if kinds.get("fkrtl"):
        limits.append("data sampel tidak memuat ID faskes asli: faskes adalah profil (kab/kota, kepemilikan, jenis, tipe), satu profil bisa beberapa RS")
    if any(m in modes for m in ("M01",)):
        limits.append("penggunaan dana kapitasi tidak ada di data: M01 dibaca dari proksinya (indikator KBK)")
    if any(k in sig_n for k in ("KLAIM_SETELAH_MENINGGAL", "KUNJUNGAN_SETELAH_MENINGGAL")):
        limits.append("registri mencatat tahun kematian saja; di data sintetis tahun itu disintesis terpisah dari urutan klaim")
    if any(k in sig_n for k in ("OBAT_DIKURANGI", "OBAT_TIDAK_DISERAHKAN", "HASIL_PEMERIKSAAN_TIDAK_COCOK")):
        limits.append("baris obat dan hasil pemeriksaan berasal dari kiriman faskes atau skenario simulator, bukan data sampel")
    net = None
    if engine.graf is not None and case["jenis"] in ("faskes", "peserta", "jaringan"):
        try:
            g = engine.graf.ego(case["jenis"], case["kunci"])
            net = {"faskes": sum(n["jenis"] == "faskes" for n in g["nodes"]), "peserta": sum(n["jenis"] == "peserta" for n in g["nodes"]),
                   "klaim": sum(e["jenis"] == "klaim" for e in g["edges"]), "pasangan_tidak_wajar": sum(e["jenis"] == "pasangan_tidak_wajar" for e in g["edges"])}
        except Exception:  # noqa: BLE001 - the brief stands without the network numbers
            net = None
    return {"kasus": case["id"], "judul": case["judul"], "status": case["status"], "ringkasan": para,
            "modus": [{"id": m, "nama": names[m], "peristiwa": n} for m, n in modes.most_common()], "bukti": evidence,
            "faskes": [{"label": k, "peristiwa": v} for k, v in facilities.most_common(8)], "peserta": len(members), "jaringan": net,
            "nilai_rp": money, "ditahan_rp": held, "mitigasi": [{"label": k, "peristiwa": v} for k, v in mit.most_common(5)],
            "langkah": steps, "batas_data": limits, "riwayat": case.get("riwayat") or [],
            "catatan": "Ringkasan ini disusun dari peristiwa kasus dengan templat (tanpa model bahasa). Indikasi untuk diperiksa, bukan bukti fraud."}


def weights(engine: Any) -> dict:
    """Each signal: its default and applied weight, the decided cases it appeared in, the posterior precision and the
    proposed weight; the verifier label's precision on replayed claims beside it."""
    from aip.realtime import mesin as E

    applied = E.config().get("bobot") or {}
    conf: collections.Counter = collections.Counter()
    fp: collections.Counter = collections.Counter()
    for c in engine.cases.values():
        if c["status"] not in ("dikonfirmasi", "false_positive"):
            continue
        for k in c.get("sinyal") or {}:
            (conf if c["status"] == "dikonfirmasi" else fp)[k] += 1
    ver_n: collections.Counter = collections.Counter()
    ver_y: collections.Counter = collections.Counter()
    for (rec, y) in engine.store.rows("""SELECT p.rec, k.label_verifikator FROM kebenaran k JOIN peristiwa p ON p.id = k.peristiwa
                                         WHERE k.skenario = 'normal' AND p.keputusan != 'LOLOS' AND k.label_verifikator IS NOT NULL"""):
        e = json.loads(rec)
        for s in e["sinyal"]:
            if s["kontribusi"] > 0:
                ver_n[s["kode"]] += 1
                ver_y[s["kode"]] += int(y or 0)
    base_rate = (engine.store.rows("SELECT avg(label_verifikator) FROM kebenaran WHERE skenario = 'normal' AND label_verifikator IS NOT NULL") or [(None,)])[0][0]
    rows = []
    for k, (modes, tag, w0, label) in MO.SIGNALS.items():
        a, b = PRIOR[0] + conf[k], PRIOR[1] + fp[k]
        post = a / (a + b)
        decided = conf[k] + fp[k]
        prop = round(w0 * min(1.6, max(0.5, post / 0.5)), 3) if decided else w0
        rows.append({"kode": k, "label": label, "modus": modes, "bobot_bawaan": w0, "bobot_berlaku": applied.get(k, w0), "bobot_usulan": prop,
                     "dikonfirmasi": conf[k], "false_positive": fp[k], "presisi_posterior": round(post, 3),
                     "verifikator_alert": ver_n[k], "verifikator_dikoreksi": ver_y[k],
                     "verifikator_presisi": round(ver_y[k] / ver_n[k], 3) if ver_n[k] else None})
    rows.sort(key=lambda r: (-(r["dikonfirmasi"] + r["false_positive"]), -r["verifikator_alert"]))
    return {"sinyal": rows, "kasus_diputus": sum(1 for c in engine.cases.values() if c["status"] in ("dikonfirmasi", "false_positive")),
            "dasar_koreksi_verifikator": base_rate, "prior": {"alpha": PRIOR[0], "beta": PRIOR[1]},
            "aturan": "usulan = bobot bawaan × clip(presisi posterior / 0,5; 0,5; 1,6), presisi posterior = (2 + dikonfirmasi) / (4 + diputus)"}


def apply_weights(engine: Any) -> dict:
    from aip.realtime import mesin as E

    tab = weights(engine)
    new = {r["kode"]: r["bobot_usulan"] for r in tab["sinyal"] if r["dikonfirmasi"] + r["false_positive"] > 0}
    E.set_config(bobot=new)
    return {"diterapkan": new, "sinyal": len(new)}


def labels(engine: Any) -> list[dict]:
    out = []
    for c in engine.cases.values():
        if c["status"] not in ("dikonfirmasi", "false_positive"):
            continue
        for e in engine.store.events_of(c["peristiwa"]):
            out.append({"kasus": c["id"], "label": 1 if c["status"] == "dikonfirmasi" else 0, "jenis": e.get("jenis", "fkrtl"), "klaim": e["klaim"],
                        "faskes": e["faskes"], "tanggal": e.get("tgl_datang"), "skor": e["skor"], "keputusan": e["keputusan"],
                        "modus": "|".join(e.get("modus") or []), "sinyal": "|".join(s["kode"] for s in e["sinyal"] if s["kontribusi"] > 0),
                        "ml_risiko_pct": (e.get("ml") or {}).get("risiko_pct")})
    return out
