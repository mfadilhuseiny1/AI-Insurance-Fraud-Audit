# Builds the UI for production and serves it on http://localhost:9300 with `next start`: pages are compiled once here, not on
# every visit as in dev mode (the user, 2026-10-30: "build repo ini, jadi gaada lag kayak mode dev").
#
# 1. `next build` into web\.next-build while the running UI keeps serving (next.config.ts: BLUESANDAI_NEXT_DIST);
#    a failed build leaves the running UI untouched (log: web\build.log);
# 2. the UI on port 9300 is stopped (dev or production), the build swapped into web\.next-prod and started without a
#    console window: a few seconds without UI. The API and any running engagement are not touched.
# Run it again after every UI change. start.ps1 serves web\.next-prod when it exists (start.ps1 -Dev for dev mode).
# -NoSwap: build only.
param([switch]$NoSwap)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$web = "$root\web"
$port = 9300

function Test-Port([int]$p) {
    try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', $p); $c.Close(); $true } catch { $false }
}

function Start-NoConsole([string]$commandLine, [string]$dir) {
    # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, as start.ps1: it keeps running after this window closes
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ CreateFlags = [uint32](0x08000000 -bor 0x200) }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $dir; ProcessStartupInformation = $si }
    if ($r.ReturnValue -ne 0) { throw "could not start: $commandLine (return $($r.ReturnValue))" }
}

Write-Host "UI build: next build -> web\.next-build (log: web\build.log) ..."
if (Test-Path "$web\.next-build") { Remove-Item "$web\.next-build" -Recurse -Force }
$env:BLUESANDAI_NEXT_DIST = '.next-build'
Push-Location $web
try {
    $ErrorActionPreference = 'Continue'
    & cmd.exe /c "npm run build > build.log 2>&1"
    $code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = 'Stop'
    Pop-Location
    Remove-Item Env:BLUESANDAI_NEXT_DIST -ErrorAction SilentlyContinue
}
if ($code -ne 0 -or -not (Test-Path "$web\.next-build\BUILD_ID")) {
    Write-Host "BUILD FAILED (exit $code); the running UI is untouched. Last lines of web\build.log:"
    Get-Content "$web\build.log" -Tail 30 | ForEach-Object { Write-Host "    $_" }
    exit 1
}
Write-Host "UI build: done ($(Get-Content "$web\.next-build\BUILD_ID"))"
if ($NoSwap) { exit 0 }

# The UI and the processes under it, but never an audit runner it launched (python.exe and everything under it): the runner is
# detached on purpose, yet `taskkill /T` follows the parent link and killed it with the UI (2026-11-16: a running branch audit
# stopped at batch 80/332 when the UI was rebuilt). Children first, then the parent.
function Stop-UiTree([int]$root) {
    $all = @(Get-CimInstance Win32_Process)
    $anak = @{}
    foreach ($q in $all) { $k = [int]$q.ParentProcessId; if (-not $anak.ContainsKey($k)) { $anak[$k] = New-Object System.Collections.ArrayList }; [void]$anak[$k].Add($q) }
    $urut = New-Object System.Collections.Generic.List[int]
    $lihat = New-Object System.Collections.Generic.HashSet[int]
    $antre = New-Object System.Collections.Generic.Queue[int]
    $antre.Enqueue($root)
    while ($antre.Count -gt 0) {
        $id = $antre.Dequeue()
        if (-not $lihat.Add($id)) { continue }
        $urut.Add($id)
        if ($anak.ContainsKey($id)) {
            foreach ($c in $anak[$id]) { if ($c.Name -ne 'python.exe' -and [int]$c.ProcessId -ne $id) { $antre.Enqueue([int]$c.ProcessId) } }
        }
    }
    for ($i = $urut.Count - 1; $i -ge 0; $i--) { & taskkill.exe /PID $urut[$i] /F *> $null }
}
# the UI on the port: `next dev -p 9300` or `next start -p 9300`, with its npm and cmd parents
$ui = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "next.*(dev|start) -p $port" })
foreach ($p in $ui) { Stop-UiTree ([int]$p.ProcessId) }
$owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
foreach ($o in @($owner)) { if ($o) { Stop-UiTree ([int]$o) } }
for ($i = 0; $i -lt 30 -and (Test-Port $port); $i++) { Start-Sleep -Milliseconds 500 }
if (Test-Port $port) { Write-Host "NOT SWAPPED: port $port is still in use; the build is in web\.next-build"; exit 1 }

if (Test-Path "$web\.next-prod") { Remove-Item "$web\.next-prod" -Recurse -Force }
Rename-Item "$web\.next-build" '.next-prod'
Start-NoConsole 'cmd.exe /c "set BLUESANDAI_NEXT_DIST=.next-prod&& npm run start > web.out.log 2> web.err.log"' $web
for ($i = 0; $i -lt 60 -and -not (Test-Port $port); $i++) { Start-Sleep -Seconds 1 }
if (-not (Test-Port $port)) { Write-Host "UI did not come up. Last lines of web\web.err.log:"; Get-Content "$web\web.err.log" -Tail 20 | ForEach-Object { Write-Host "    $_" }; exit 1 }
Write-Host "UI: production build online at http://localhost:$port/aip-jkn"
