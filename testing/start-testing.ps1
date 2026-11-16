# /testing: the claim test bench on the synthetic stream.
# Usage (from the repo root or anywhere):  powershell -ExecutionPolicy Bypass -File testing\start-testing.ps1
# Then open http://localhost:9300/testing (inside the app, signed in; web\src\app\testing proxies to this service) or
# http://localhost:8320/testing directly (start-up takes a few minutes: model, stream, realtime engine).
# ..\start.ps1 starts it too, in the background (log: testing\testing.log).
# First time only:  .venv\Scripts\python.exe testing\siapkan_data.py   (copies the synthetic stream for testing)
# The model in testing\model was trained with clean plants that live in this data copy. After a fresh copy
# (siapkan_data.py --force), start the service and run  .venv\Scripts\python.exe testing\bangun_ulang.py  (about 20 minutes),
# then restart it.
param([int]$Port = 8320)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $root ".tmp"
New-Item -ItemType Directory -Force $tmp | Out-Null
$env:TEMP = $tmp
$env:TMP = $tmp
$env:PYTHONUTF8 = "1"
$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path (Join-Path $tmp "testing-data\aip\realtime\realtime.sqlite"))) {
    Write-Host "Copying the synthetic stream for testing (first run)..."
    & $py (Join-Path $PSScriptRoot "siapkan_data.py")
}
if (-not (Test-Path (Join-Path $PSScriptRoot "model\model.joblib"))) {
    Write-Host "Training a starter model on the simulator claims (first run). For the full model, run testing\bangun_ulang.py once the service is up."
    & $py (Join-Path $PSScriptRoot "latih_model.py")
}
Set-Location $PSScriptRoot
Write-Host "Starting on http://localhost:$Port/testing"
& $py -m uvicorn app:app --host 127.0.0.1 --port $Port
