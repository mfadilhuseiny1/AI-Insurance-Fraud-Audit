# Watchdog for the synthetic app's API (port 8300): the API process dies now and then of a native crash (access violation in
# python312.dll, 2026-11-12: four times in a day, more under an AI Agent Swarm run). Every 20 s: if nothing listens on 8300,
# keep the crash log (api\crash-<time>.api.log) and start the API again with start.ps1 -NoBrowser; an engagement cut short
# resumes from its own trail (aip/runs.py "lanjut"). Log: .tmp\watchdog-api.log.
# Start (hidden):  Start-Process powershell -ArgumentList '-ExecutionPolicy','Bypass','-File','D:\BluesandAI\ai-jkn-synthetic\watchdog-api.ps1' -WindowStyle Hidden
# Stop:            Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'watchdog-api.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $root ".tmp\watchdog-api.log"
$env:TEMP = Join-Path $root ".tmp"; $env:TMP = $env:TEMP
function Say($m) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) }
Say "watchdog started"
while ($true) {
    Start-Sleep -Seconds 20
    $up = Get-NetTCPConnection -State Listen -LocalPort 8300 -ErrorAction SilentlyContinue
    if ($up) { continue }
    Start-Sleep -Seconds 10  # a restart in progress (start.ps1 itself) gets time to bind the port
    if (Get-NetTCPConnection -State Listen -LocalPort 8300 -ErrorAction SilentlyContinue) { continue }
    $stamp = Get-Date -Format "MMdd-HHmm"
    $apiLog = Join-Path $root "api\api.log"
    if (Test-Path $apiLog) { Copy-Item $apiLog (Join-Path $root "api\crash-$stamp.api.log") -Force }
    Say "API down: crash log api\crash-$stamp.api.log; restarting"
    try {
        $out = powershell -ExecutionPolicy Bypass -File (Join-Path $root "start.ps1") -NoBrowser 2>&1 | Select-Object -Last 2
        Say ("restart: " + ($out -join " | "))
    } catch { Say "restart failed: $_" }
}
