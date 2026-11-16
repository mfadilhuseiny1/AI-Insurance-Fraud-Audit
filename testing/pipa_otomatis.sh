#!/bin/bash
# Unattended pipeline (the user, 2026-11-12: "pisahin mana yg butuh nunggu tanpa claude, biarin itu run meskipun token abis").
# Runs the deterministic, heavy steps one after the other, each under the shared heavy-job lock (.tmp/BERAT.lock), and writes a
# status line per step to .tmp/pipa_status.log. Nothing here chooses a model, a threshold or a rule from a test set; it only BUILDS
# data and runs the pre-registered rule selection on the validation members.
#   1. wait for data_v4 (10 chunks + stream_x4.npz)
#   2. rule selection on validation (testing/pilih_aturan_v4.py; light)
#   3. test C2      (UJI100K_SET=C2, 10 chunks, with X4)        -> .tmp/uji100k_c2
#   4. gen2 seed 3  (GEN2_SEED3=1, 8 chunks, with X4)           -> .tmp/gen2_seed3
#   5. generator 3  (GEN3=1, only if testing/generator3.py runs) -> .tmp/gen3_uji
# Re-running is safe: every builder skips chunks it already finished.
cd /d/BluesandAI/ai-jkn-synthetic || exit 1
PY=.venv/Scripts/python.exe
export PYTHONUTF8=1 TEMP=D:/BluesandAI/ai-jkn-synthetic/.tmp TMP=D:/BluesandAI/ai-jkn-synthetic/.tmp
STATUS=.tmp/pipa_status.log
LOCK=.tmp/BERAT.lock
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$STATUS"; }

ambil_kunci() {  # wait (up to 4 hours) until nobody holds the lock, then take it
  local tunggu=0
  while [ -f "$LOCK" ]; do
    sleep 30; tunggu=$((tunggu + 30))
    if [ $tunggu -ge 14400 ]; then log "GAGAL: lock still held after 4 h by: $(cat $LOCK)"; return 1; fi
  done
  echo "pipa_otomatis $1 $(date '+%Y-%m-%d %H:%M')" > "$LOCK"
}
lepas_kunci() { rm -f "$LOCK"; }

log "START pipa_otomatis (pid $$)"

# 1. data_v4
until [ -f .tmp/data_v4/stream_x4.npz ] && [ "$(ls .tmp/data_v4/fitur_*.npz 2>/dev/null | wc -l)" -ge 10 ]; do
  if grep -q "stopped" .tmp/data_v4_jalankan.log 2>/dev/null; then
    log "data_v4 build stopped; restarting it (resumable)"
    ambil_kunci data_v4 || exit 1
    $PY testing/data_v4.py jalankan > .tmp/data_v4_jalankan.log 2>&1
    lepas_kunci
  fi
  sleep 30
done
log "OK 1 data_v4 complete: $(ls .tmp/data_v4/fitur_*.npz | wc -l) chunks + stream_x4"

# 2. rule selection (validation only, pre-registered)
if [ ! -f .tmp/data_v4/aturan_v4.json ]; then
  $PY testing/pilih_aturan_v4.py > .tmp/pilih_aturan_v4.log 2>&1 && log "OK 2 rule selection -> .tmp/data_v4/aturan_v4.json" || log "GAGAL 2 rule selection (see .tmp/pilih_aturan_v4.log)"
else
  log "SKIP 2 rule selection already done"
fi

# 3. test C2
if [ "$(ls .tmp/uji100k_c2/hasil_*.npz 2>/dev/null | wc -l)" -lt 10 ]; then
  ambil_kunci uji_c2 || exit 1
  UJI100K_SET=C2 UJI100K_FITUR=1 $PY testing/uji100k.py jalankan > .tmp/uji100k_c2_jalankan.log 2>&1
  lepas_kunci
fi
n=$(ls .tmp/uji100k_c2/hasil_*.npz 2>/dev/null | wc -l); [ "$n" -ge 10 ] && log "OK 3 test C2: $n chunks" || log "GAGAL 3 test C2: $n chunks (see .tmp/uji100k_c2_jalankan.log)"

# 4. gen2 seed 3
if [ "$(ls .tmp/gen2_seed3/hasil_*.npz 2>/dev/null | wc -l)" -lt 8 ]; then
  ambil_kunci gen2_seed3 || exit 1
  GEN2_SEED3=1 UJI_MODELS=model_v3_bersih,model_v3 $PY testing/uji_gen2.py jalankan > .tmp/gen2_seed3_jalankan.log 2>&1
  lepas_kunci
fi
n=$(ls .tmp/gen2_seed3/hasil_*.npz 2>/dev/null | wc -l); [ "$n" -ge 8 ] && log "OK 4 gen2 seed 3: $n chunks" || log "GAGAL 4 gen2 seed 3: $n chunks (see .tmp/gen2_seed3_jalankan.log)"

# 5. generator 3 (waits up to 3 hours for the generator to exist and pass its own sample check)
tunggu=0
until [ -f testing/generator3.py ] && $PY testing/generator3.py contoh 0 > .tmp/gen3_contoh0.log 2>&1; do
  sleep 120; tunggu=$((tunggu + 120))
  if [ $tunggu -ge 10800 ]; then log "SKIP 5 generator 3: testing/generator3.py not ready after 3 h"; log "END"; exit 0; fi
done
if [ "$(ls .tmp/gen3_uji/hasil_*.npz 2>/dev/null | wc -l)" -lt 8 ]; then
  ambil_kunci gen3 || exit 1
  GEN3=1 UJI_MODELS=model_v3_bersih,model_v3 $PY testing/uji_gen2.py jalankan > .tmp/gen3_jalankan.log 2>&1
  lepas_kunci
fi
n=$(ls .tmp/gen3_uji/hasil_*.npz 2>/dev/null | wc -l); [ "$n" -ge 8 ] && log "OK 5 generator 3: $n chunks" || log "GAGAL 5 generator 3: $n chunks (see .tmp/gen3_jalankan.log)"
log "END"
