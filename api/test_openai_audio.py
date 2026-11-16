"""Tests for OpenAI audio (openai_audio.py) and the Text to Speech app on it. No fakes: the live tests read a sentence
aloud with the real realtime model, transcribe that audio back with the real transcriber, and book into the real
monthly ledger (<data>/openai_audio), so their cost counts against BLUESANDAI_OPENAI_AUDIO_MONTHLY_USD. A full run
costs about $0.01. Run: python -m pytest test_openai_audio.py -q (from api/). Needs OPENAI_API_KEY."""
import pytest

import openai_audio as A
import tts

SENTENCE = "Klaim berisiko di Sulawesi Selatan berjumlah 1.093, dengan indikasi utama selisih verifikasi."


@pytest.fixture
def live():
    if not A.configured():
        pytest.skip("OPENAI_API_KEY is not set")


# ---------------------------------------------------------------- plain logic


def test_similarity_counts_words_not_punctuation_or_case():
    assert A.similarity("Itu keputusan auditor.", "itu keputusan Auditor") == 1.0
    assert A.similarity("Apakah klaim ini perlu ditahan?", "Ya, klaim itu sebaiknya ditahan.") < A.VERBATIM


def test_cost_from_the_usage_the_realtime_api_reports():
    # the usage of a real 16-second reading (2026-10-22)
    usage = {"input_token_details": {"text_tokens": 136, "cached_tokens_details": {"text_tokens": 0}},
             "output_token_details": {"text_tokens": 118, "audio_tokens": 321}}
    assert A.reader_cost("gpt-realtime-2.1-mini", usage) == pytest.approx((136 * 0.60 + 118 * 2.40 + 321 * 20.00) / 1e6)


def test_estimate_before_reading():
    est = A.estimate(1270)
    assert est["seconds"] == pytest.approx(100, rel=0.01) and 0.03 < est["usd"] < 0.06


def test_the_cap_refuses_new_calls(monkeypatch):
    monkeypatch.setenv("BLUESANDAI_OPENAI_AUDIO_MONTHLY_USD", "0")
    with pytest.raises(A.BudgetExceeded):
        A.check_budget()


def test_each_user_has_a_share_of_the_cap(monkeypatch):
    monkeypatch.setenv("BLUESANDAI_OPENAI_AUDIO_USER_MONTHLY_USD", "0")
    with pytest.raises(A.BudgetExceeded):
        A.check_budget("u-someone")
    A.check_budget()  # work booked to no user (a test) is held only to the total


def test_tts_jobs_are_their_owners():
    job = {"id": "j1", "user_id": "u-a"}
    assert tts._visible(job, {"id": "u-a", "role": "user"})
    assert not tts._visible(job, {"id": "u-b", "role": "user"})
    assert tts._visible(job, {"id": "u-b", "role": "admin"})
    assert not tts._visible({"id": "j0"}, {"id": "u-a", "role": "user"})  # from before owners were kept: administrators only


@pytest.mark.parametrize("n,words", [(11, "sebelas"), (115, "seratus lima belas"), (626, "enam ratus dua puluh enam"),
                                     (1093, "seribu sembilan puluh tiga"), (9506, "sembilan ribu lima ratus enam"),
                                     (1250000000, "satu miliar dua ratus lima puluh juta")])
def test_numbers_in_indonesian_words(n, words):
    from aip.voice import terbilang

    assert terbilang(n) == words


def test_spoken_numbers_leave_codes_alone():
    from aip.voice import spoken_numbers

    assert spoken_numbers("Selisih verifikasi 626 klaim, rasio 17,5% dan Rp 3.000.000.") == \
        "Selisih verifikasi enam ratus dua puluh enam klaim, rasio tujuh belas koma lima persen dan rupiah tiga juta."
    codes = "Kode J18.9, INA-CBG I-4-10-I, klaim 0301R0010926V000113, tanggal 2026-10-22."
    assert spoken_numbers(codes) == codes


def test_tts_chunks_are_shorter_for_the_realtime_reader():
    text = tts.markdown_to_text("# Judul\n\n" + "Kalimat yang cukup panjang untuk dibacakan. " * 80)
    assert all(len(c) <= tts.CHUNK_CHARS["openai"] for c in tts.chunk_text(text, tts.CHUNK_CHARS["openai"]))


def test_new_tts_jobs_take_openai_voices_only():
    with pytest.raises(tts.HTTPException):
        tts._check_voice("Kore", tts.DEFAULT_MODEL)  # a Gemini voice
    assert tts._check_voice("marin", tts.DEFAULT_MODEL) == "openai"
    assert tts._check_voice("Kore", "gemini-3.8-flash-tts") == "gemini"  # old jobs still finish


# ---------------------------------------------------------------- live: read aloud, then transcribe what was read


def test_read_aloud_then_transcribe_round_trip(live):
    before = A.spend()["usd"]
    pcm, meta = A.read_aloud(SENTENCE, "marin", kind="test")
    seconds = len(pcm) / 2 / A.RATE
    assert 3 < seconds < 20
    assert meta["similarity"] >= A.VERBATIM and meta["usd"] > 0
    heard = A.transcribe(A.wav(pcm), "test.wav", "audio/wav", "id")
    assert A.similarity(SENTENCE, heard["text"]) >= 0.85, heard["text"]
    assert A.spend()["usd"] == pytest.approx(before + meta["usd"] + heard["usd"], abs=1e-6)
