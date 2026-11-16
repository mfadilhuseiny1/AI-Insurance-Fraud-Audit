# One-time: gives AI JKN Synthetic its own PostgreSQL server inside this folder (.pgdata, port 5435) and fills it with a copy
# of the database of the repo it was copied from. Uses the PostgreSQL 18 binaries already installed on this computer; no
# superuser of another project is needed (initdb makes this cluster's own). The app runs as the role `bluesandai` with a
# new password; both passwords are written to this folder only (.env.local and secrets\pg-superuser.txt), never printed.
#
#   powershell -ExecutionPolicy Bypass -File setup-database.ps1 [-SourceEnv <.env.local of the platform copied from>]
#
# Refuses when .pgdata already exists. start.ps1 starts this server before the API.
param([string]$SourceEnv = 'D:\BluesandAI\ai-jkn-audit\.env.local')  # the database copied here (then scrubbed of BPJS-derived rows)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pgdata = "$root\.pgdata"
$port = 5435
$bin = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\initdb.exe' | Select-Object -Last 1).DirectoryName
$py = "$root\.venv\Scripts\python.exe"
if (Test-Path $pgdata) { throw "$pgdata already exists: left as it is" }

function New-Secret { & $py -c "import secrets; print(secrets.token_urlsafe(24))" }
function Get-EnvValue([string]$file, [string]$key) {
    foreach ($line in Get-Content $file -Encoding utf8) { if ($line -match "^$key=(.*)$") { return $Matches[1].Trim() } }
    throw "$key not found in $file"
}

$superPass = New-Secret
$appPass = New-Secret
New-Item -ItemType Directory -Force "$root\secrets" | Out-Null
$pwFile = "$root\secrets\pg-superuser.txt"
[IO.File]::WriteAllText($pwFile, $superPass)

# the same encoding and collation as the source database (UTF8, English_Indonesia.1252), so text sorts the same way
& "$bin\initdb.exe" -D $pgdata -U postgres -A scram-sha-256 --pwfile=$pwFile -E UTF8 --locale=English_Indonesia.1252 | Out-Null
if ($LASTEXITCODE) { throw "initdb failed ($LASTEXITCODE)" }
Add-Content "$pgdata\postgresql.conf" "`nport = $port`nlisten_addresses = '127.0.0.1'`ntimezone = 'Asia/Bangkok'`nlog_timezone = 'Asia/Bangkok'`n" -Encoding ascii

# started through WMI (no console window), so it keeps running after this window closes
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ CreateFlags = [uint32](0x08000000 -bor 0x200) }
$cmd = "`"$bin\pg_ctl.exe`" start -D `"$pgdata`" -l `"$pgdata\server.log`" -w"
[void](Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root; ProcessStartupInformation = $si })
for ($i = 0; $i -lt 60; $i++) { & "$bin\pg_isready.exe" -q -h 127.0.0.1 -p $port; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
if ($LASTEXITCODE) { throw "the new server did not start: see $pgdata\server.log" }

$env:PGPASSWORD = $superPass
& "$bin\psql.exe" -h 127.0.0.1 -p $port -U postgres -d postgres -v ON_ERROR_STOP=1 -q `
    -c "CREATE ROLE bluesandai LOGIN PASSWORD '$appPass'" `
    -c "CREATE DATABASE ai_jkn_synthetic OWNER bluesandai ENCODING 'UTF8' LOCALE 'English_Indonesia.1252' TEMPLATE template0"
if ($LASTEXITCODE) { throw "creating the role and database failed" }

# the copy: dumped with the source app's own credentials, restored as bluesandai
$src = [Uri](Get-EnvValue $SourceEnv 'BLUESANDAI_DATABASE_URL')
$srcUser, $srcPass = $src.UserInfo.Split(':', 2)
$dump = "$env:TEMP\ai-jkn-synthetic-src.dump"
$env:PGPASSWORD = [Uri]::UnescapeDataString($srcPass)
& "$bin\pg_dump.exe" -h $src.Host -p $src.Port -U $srcUser -d $src.AbsolutePath.TrimStart('/') -Fc -f $dump
if ($LASTEXITCODE) { throw "pg_dump failed" }
$env:PGPASSWORD = $appPass
& "$bin\pg_restore.exe" -h 127.0.0.1 -p $port -U bluesandai -d ai_jkn_synthetic --no-owner --no-acl --exit-on-error $dump
if ($LASTEXITCODE) { throw "pg_restore failed" }
Remove-Item $dump -Force -Confirm:$false
Remove-Item Env:PGPASSWORD

# this folder's .env.local points at the new database
$envFile = "$root\.env.local"
$url = "postgresql://bluesandai:$appPass@127.0.0.1:$port/ai_jkn_synthetic"
$lines = Get-Content $envFile -Encoding utf8 | ForEach-Object { if ($_ -match '^BLUESANDAI_DATABASE_URL=') { "BLUESANDAI_DATABASE_URL=$url" } else { $_ } }
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
Write-Host "PostgreSQL for AI JKN Synthetic: 127.0.0.1:$port, database ai_jkn_synthetic (copied from $($src.AbsolutePath.TrimStart('/')))"
