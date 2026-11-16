# Starts AI JKN Synthetic on this computer and opens it at http://localhost:9300/aip-jkn: its own PostgreSQL (.pgdata,
# 127.0.0.1:5435), the API on http://localhost:8300 and the UI on http://localhost:9300. It runs beside the BluesandAI
# platform it was copied from (8000 / 8888 / 5432) without touching it. Double-click start.bat to run it whatever the
# PowerShell execution policy is. First-time setup: README-AIP-JKN.md (setup-database.ps1, .venv, web\node_modules).
#
# It waits until the API answers, not just until it is launched:
# - An API that answers is left alone: a restart re-runs queued jobs and kills chat runs (restart it with
#   .work\koordinasi\restart_api.ps1). One that is still starting is waited for, never started twice.
# - PostgreSQL must accept connections first: after a hard reset it recovers for a while, and an API started then runs
#   without its database. An API that still logs "PostgreSQL unavailable" is started again.
# - All three start through WMI without a console window, so they keep running after this window closes.
# -NoBrowser: start everything but do not open the page.
# The UI is the production build (web\.next-prod, made by build-web.ps1) when there is one; -Dev: `next dev` instead.
# Uji klaim (http://localhost:9300/testing) has its own service on 127.0.0.1:8320 (testing\app.py), started last and not
# waited for (a few minutes to load); -NoTesting leaves it off.
param([switch]$NoBrowser, [switch]$Dev, [switch]$NoTesting)
$root = $PSScriptRoot
$py = "$root\.venv\Scripts\python.exe"
$apiPort = 8300
$webPort = 9300
$testingPort = 8320   # web\.env.local TESTING_API_URL points here
$pgPort = 5435
$pgdata = "$root\.pgdata"
$pgBin = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_ctl.exe' -ErrorAction SilentlyContinue | Select-Object -Last 1).DirectoryName
$status = "http://127.0.0.1:$apiPort/api/auth/status"   # answers without sign-in
$restartLock = "$root\.work\koordinasi\api-restart.lock"

function Test-Port([int]$port) {
    try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', $port); $c.Close(); $true } catch { $false }
}

function Test-Api {
    try { (Invoke-WebRequest $status -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } catch { $false }
}

function Test-Postgres {
    & "$pgBin\pg_isready.exe" -q -h 127.0.0.1 -p $pgPort
    $LASTEXITCODE -eq 0
}

function Wait-Until([scriptblock]$test, [int]$seconds) {
    $end = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $end) { if (& $test) { return $true }; Start-Sleep -Seconds 2 }
    $false
}

function Get-ApiProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -match "uvicorn server:app .*--port $apiPort" })
}

function Stop-Api {
    foreach ($p in Get-ApiProcesses) { try { Stop-Process -Id $p.ProcessId -Force -Confirm:$false -ErrorAction Stop } catch {} }
    [void](Wait-Until { -not (Test-Port $apiPort) } 20)
}

function Start-NoConsole([string]$commandLine, [string]$dir) {
    # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP: Windows Terminal ignores a hidden window and would show a blank console
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ CreateFlags = [uint32](0x08000000 -bor 0x200) }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $dir; ProcessStartupInformation = $si }
    if ($r.ReturnValue -ne 0) { throw "could not start: $commandLine (return $($r.ReturnValue))" }
}

function Show-LogTail([string]$path) {
    if (Test-Path $path) { Get-Content $path -Tail 15 | ForEach-Object { Write-Host "    $_" } }
}

# a second launch (a double double-click) waits for the first instead of starting a second API
$mutex = New-Object Threading.Mutex($false, 'AI-JKN-Synthetic-start')
try { [void]$mutex.WaitOne() } catch [Threading.AbandonedMutexException] {}

if (-not (Test-Path "$pgdata\PG_VERSION")) { Write-Warning "no database yet: run setup-database.ps1 first (README-AIP-JKN.md)"; exit 1 }
if (-not (Test-Postgres)) {
    Write-Host "PostgreSQL: starting (log: .pgdata\server.log) ..."
    Start-NoConsole "`"$pgBin\pg_ctl.exe`" start -D `"$pgdata`" -l `"$pgdata\server.log`" -w" $root
    if (-not (Wait-Until { Test-Postgres } 180)) {
        Write-Warning "PostgreSQL does not accept connections on 127.0.0.1:${pgPort}: the API was not started. Last lines of .pgdata\server.log:"
        Show-LogTail "$pgdata\server.log"; exit 1
    }
}
Write-Host "PostgreSQL: online at 127.0.0.1:$pgPort"

$apiOnline = Test-Api
$restarting = (Test-Path $restartLock) -and ((Get-Date) - (Get-Item $restartLock).LastWriteTime).TotalSeconds -lt 300
if (-not $apiOnline -and ((Get-ApiProcesses).Count -or $restarting)) {
    Write-Host "API: already starting (or being restarted), waiting for it ..."
    $apiOnline = Wait-Until { Test-Api } 300
    if (-not $apiOnline) { Write-Host "API: still not answering after 300 s, stopping it to start a fresh one"; Stop-Api }
}
if (-not $apiOnline) {
    $holder = Get-NetTCPConnection -State Listen -LocalPort $apiPort -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($holder) { Write-Warning "port $apiPort is taken by another program (pid $($holder.OwningProcess)): close it and run this again"; exit 1 }
    for ($try = 1; $try -le 2 -and -not $apiOnline; $try++) {
        Write-Host "API: starting (log: api\api.log) ..."
        # keep the previous run's logs (a crash leaves its last lines there); PYTHONFAULTHANDLER writes the Python stack of a native crash to api.log
        foreach ($f in 'api.log', 'api.out.log') { if (Test-Path "$root\api\$f") { Copy-Item "$root\api\$f" "$root\api\$f.prev" -Force } }
        Start-NoConsole ('cmd.exe /c "set PYTHONFAULTHANDLER=1&& "' + $py + '" -m uvicorn server:app --host 0.0.0.0 --port ' + $apiPort + ' > api.out.log 2> api.log"') "$root\api"
        if (-not (Wait-Until { Test-Api } 300)) {
            Write-Warning "API not online after 300 s. Last lines of api\api.log:"; Show-LogTail "$root\api\api.log"; Stop-Api; exit 1
        }
        if (Select-String -Path "$root\api\api.log" -Pattern 'PostgreSQL unavailable' -SimpleMatch -Quiet) {
            Write-Host "API: came up without PostgreSQL, starting it again ..."
            Stop-Api
        } else { $apiOnline = $true }
    }
    if (-not $apiOnline) { Write-Warning "API keeps starting without PostgreSQL. Last lines of api\api.log:"; Show-LogTail "$root\api\api.log"; exit 1 }
}
Write-Host "API: online at http://localhost:$apiPort"

if (-not (Test-Port $webPort)) {
    if (@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "(dev|start) -p $webPort" }).Count) {
        Write-Host "UI: already starting, waiting for it ..."
    } elseif (-not $Dev -and (Test-Path "$root\web\.next-prod\BUILD_ID")) {
        Write-Host "UI: starting the production build (web\.next-prod; log: web\web.err.log) ..."
        Start-NoConsole 'cmd.exe /c "set BLUESANDAI_NEXT_DIST=.next-prod&& npm run start > web.out.log 2> web.err.log"' "$root\web"
    } else {
        Write-Host "UI: starting in dev mode (log: web\web.err.log) ..."
        Start-NoConsole 'cmd.exe /c "npm run dev > web.out.log 2> web.err.log"' "$root\web"
    }
    if (-not (Wait-Until { Test-Port $webPort } 120)) { Write-Warning "UI not up after 120 s. Last lines of web\web.err.log:"; Show-LogTail "$root\web\web.err.log"; exit 1 }
}
Write-Host "UI: online at http://localhost:$webPort/aip-jkn"

# Uji klaim (/testing on the UI; the user, 2026-11-14): a service of its own, because it runs its own realtime engine on a
# copy of the synthetic stream (.tmp\testing-data); the UI's /testing/api route is its only door (it listens on 127.0.0.1).
# Not waited for: the model, the stream and the engine take a few minutes, and the page shows its progress meanwhile.
# Skipped without its data copy or a model (testing\start-testing.ps1 makes them the first time) and with -NoTesting.
if (-not $NoTesting -and -not (Test-Port $testingPort)) {
    $model = @('model_v3', 'model_v2', 'model') | Where-Object { Test-Path "$root\testing\$_\model.joblib" } | Select-Object -First 1
    if (-not (Test-Path "$root\.tmp\testing-data\aip\realtime\realtime.sqlite") -or -not $model) {
        Write-Host "Uji klaim: not started (no data copy or model yet: run testing\start-testing.ps1 once)"
    } elseif (@(Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -match "uvicorn app:app .*--port $testingPort" }).Count) {
        Write-Host "Uji klaim: already starting"
    } else {
        Write-Host "Uji klaim: starting on 127.0.0.1:$testingPort (log: testing\testing.log), ready in a few minutes at http://localhost:$webPort/testing"
        New-Item -ItemType Directory -Force "$root\.tmp" | Out-Null
        Start-NoConsole ('cmd.exe /c "set TEMP=' + "$root\.tmp" + '&& set TMP=' + "$root\.tmp" + '&& set PYTHONUTF8=1&& "' + $py + '" -m uvicorn app:app --host 127.0.0.1 --port ' + $testingPort + ' > testing.out.log 2> testing.log"') "$root\testing"
    }
}
if (-not $NoBrowser) { Start-Process "http://localhost:$webPort/aip-jkn" }
