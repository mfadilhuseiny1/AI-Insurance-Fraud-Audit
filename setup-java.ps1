# Java transforms toolchain for Code Repositories: a portable JDK 17 (Eclipse Temurin), the test jars and Apache POI
# (transforms-excel-parser) in .java/,
# and pyspark (its Spark jars) in .venv. Safe to run again: what is already there is kept.
#   powershell -ExecutionPolicy Bypass -File setup-java.ps1 [-JavaDir D:\elsewhere]
# The API looks in .java/ (or BLUESANDAI_JAVA_DIR); BLUESANDAI_JAVA_HOME / JAVA_HOME point at another JDK 17 instead.
param([string]$JavaDir = "")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # Invoke-WebRequest is many times slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = $PSScriptRoot
if (-not $JavaDir) { $JavaDir = if ($env:BLUESANDAI_JAVA_DIR) { $env:BLUESANDAI_JAVA_DIR } else { Join-Path $root ".java" } }
New-Item -ItemType Directory -Force $JavaDir | Out-Null

# --- JDK 17 ---------------------------------------------------------------------------------------
$jdk = Get-ChildItem $JavaDir -Directory -Filter "jdk-17*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($jdk -and (Test-Path (Join-Path $jdk.FullName "bin\javac.exe"))) {
    Write-Host "JDK: $($jdk.Name) (already there)"
} else {
    $zip = Join-Path $JavaDir "jdk17.zip"
    Write-Host "JDK: downloading Eclipse Temurin 17 (about 190 MB)..."
    Invoke-WebRequest -UseBasicParsing "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse" -OutFile $zip
    Expand-Archive $zip -DestinationPath $JavaDir -Force
    Remove-Item $zip
    $jdk = Get-ChildItem $JavaDir -Directory -Filter "jdk-17*" | Sort-Object Name -Descending | Select-Object -First 1
    Write-Host "JDK: $($jdk.Name)"
}

# --- test jars (JUnit 5 console, JUnit 4, AssertJ, Mockito): names as api/code_java.py TEST_JARS ---------------
$central = "https://repo1.maven.org/maven2"
$jars = [ordered]@{
    "junit-platform-console-standalone.jar" = "org/junit/platform/junit-platform-console-standalone/1.11.4/junit-platform-console-standalone-1.11.4.jar"
    "junit-4.jar"                           = "junit/junit/4.13.2/junit-4.13.2.jar"
    "hamcrest-core.jar"                     = "org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar"
    "assertj-core.jar"                      = "org/assertj/assertj-core/3.26.3/assertj-core-3.26.3.jar"
    "mockito-core.jar"                      = "org/mockito/mockito-core/5.14.2/mockito-core-5.14.2.jar"
    "byte-buddy.jar"                        = "net/bytebuddy/byte-buddy/1.15.10/byte-buddy-1.15.10.jar"
    "byte-buddy-agent.jar"                  = "net/bytebuddy/byte-buddy-agent/1.15.10/byte-buddy-agent-1.15.10.jar"
    "objenesis.jar"                         = "org/objenesis/objenesis/3.3/objenesis-3.3.jar"
}
foreach ($name in $jars.Keys) {
    $dest = Join-Path $JavaDir $name
    if (Test-Path $dest) { Write-Host "jar: $name (already there)"; continue }
    $url = "$central/$($jars[$name])"
    $tmp = "$dest.part"
    Invoke-WebRequest -UseBasicParsing $url -OutFile $tmp
    # Maven Central publishes a SHA-1 next to every artifact
    $expected = (Invoke-WebRequest -UseBasicParsing "$url.sha1").Content
    if ($expected -is [byte[]]) { $expected = [Text.Encoding]::ASCII.GetString($expected) }
    $expected = $expected.Trim().Split(" ")[0].ToLower()
    $actual = (Get-FileHash $tmp -Algorithm SHA1).Hash.ToLower()
    if ($actual -ne $expected) { Remove-Item $tmp; throw "checksum mismatch for $name ($actual, expected $expected)" }
    Move-Item $tmp $dest
    Write-Host "jar: $name"
}

# --- Apache POI for transforms-excel-parser (names and versions as api/code_java.py POI_JARS) ---------------------
# POI's other dependencies (commons-io / compress / codec / collections4 / math3, log4j-api) come with Spark.
$poiDir = Join-Path $JavaDir "poi"
New-Item -ItemType Directory -Force $poiDir | Out-Null
$poi = [ordered]@{
    "poi-5.2.3.jar"            = "org/apache/poi/poi/5.2.3/poi-5.2.3.jar"
    "poi-ooxml-5.2.3.jar"      = "org/apache/poi/poi-ooxml/5.2.3/poi-ooxml-5.2.3.jar"
    "poi-ooxml-lite-5.2.3.jar" = "org/apache/poi/poi-ooxml-lite/5.2.3/poi-ooxml-lite-5.2.3.jar"
    "xmlbeans-5.1.1.jar"       = "org/apache/xmlbeans/xmlbeans/5.1.1/xmlbeans-5.1.1.jar"
    "SparseBitSet-1.2.jar"     = "com/zaxxer/SparseBitSet/1.2/SparseBitSet-1.2.jar"
    "curvesapi-1.07.jar"       = "com/github/virtuald/curvesapi/1.07/curvesapi-1.07.jar"
}
foreach ($name in $poi.Keys) {
    $dest = Join-Path $poiDir $name
    if (Test-Path $dest) { Write-Host "poi: $name (already there)"; continue }
    $url = "$central/$($poi[$name])"
    $tmp = "$dest.part"
    Invoke-WebRequest -UseBasicParsing $url -OutFile $tmp
    $expected = (Invoke-WebRequest -UseBasicParsing "$url.sha1").Content
    if ($expected -is [byte[]]) { $expected = [Text.Encoding]::ASCII.GetString($expected) }
    $expected = $expected.Trim().Split(" ")[0].ToLower()
    $actual = (Get-FileHash $tmp -Algorithm SHA1).Hash.ToLower()
    if ($actual -ne $expected) { Remove-Item $tmp; throw "checksum mismatch for $name ($actual, expected $expected)" }
    Move-Item $tmp $dest
    Write-Host "poi: $name"
}

# --- Iceberg Spark runtime for Iceberg tables in Spark transforms (version as api/code_java.py ICEBERG_VERSION) -----
$iceDir = Join-Path $JavaDir "iceberg"
New-Item -ItemType Directory -Force $iceDir | Out-Null
$iceJar = "iceberg-spark-runtime-3.5_2.12-1.9.2.jar"
$iceDest = Join-Path $iceDir $iceJar
if (Test-Path $iceDest) {
    Write-Host "iceberg: $iceJar (already there)"
} else {
    $url = "$central/org/apache/iceberg/iceberg-spark-runtime-3.5_2.12/1.9.2/$iceJar"
    $tmp = "$iceDest.part"
    Invoke-WebRequest -UseBasicParsing $url -OutFile $tmp
    $expected = (Invoke-WebRequest -UseBasicParsing "$url.sha1").Content
    if ($expected -is [byte[]]) { $expected = [Text.Encoding]::ASCII.GetString($expected) }
    $expected = $expected.Trim().Split(" ")[0].ToLower()
    $actual = (Get-FileHash $tmp -Algorithm SHA1).Hash.ToLower()
    if ($actual -ne $expected) { Remove-Item $tmp; throw "checksum mismatch for $iceJar ($actual, expected $expected)" }
    Move-Item $tmp $iceDest
    Write-Host "iceberg: $iceJar"
}

# --- pyspark (Spark local mode and its jars) ----------------------------------------------------------
$py = Join-Path $root ".venv\Scripts\python.exe"
if (Test-Path $py) {
    & $py -c "import pyspark" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "pyspark: installing 3.5.7 with uv..."
        uv pip install --python $py "pyspark==3.5.7"
    } else {
        Write-Host "pyspark: installed"
    }
} else {
    Write-Host "pyspark: no .venv yet (create it and install requirements.txt; pyspark is in it)"
}

& (Join-Path $jdk.FullName "bin\javac.exe") -version
Write-Host "Done. Restart the API: Code Repositories picks the toolchain up (Java transforms, UDFs and tests)."
