$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'tunnel-common.ps1')
$paths = Get-TunnelPaths -Root $Root
$localReady = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:31338/healthz' -TimeoutSec 3
    $localReady = $health.ok -eq $true -and [int]$health.tools -eq 5
} catch { }
$tunnelHealth = Get-TunnelHealth -HealthUrlFile $paths.HealthUrl
$pythonPointer = Join-Path $Root 'runtime\QWEN_TRANSCRIPT_PYTHON.txt'
$modelPointer = Join-Path $Root 'runtime\QWEN_TRANSCRIPT_MODEL.txt'
$nodeReady = $false
try {
    $versionText = (& node.exe --version).Trim().TrimStart('v')
    $nodeReady = [int]$versionText.Split('.')[0] -ge 20
} catch { }
[pscustomobject]@{
    node20OrNewer = [bool]$nodeReady
    ffmpegAvailable = [bool](Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)
    ffprobeAvailable = [bool](Get-Command ffprobe.exe -ErrorAction SilentlyContinue)
    buildPresent = Test-Path -LiteralPath (Join-Path $Root 'dist\index.js') -PathType Leaf
    qwenPythonConfigured = Test-Path -LiteralPath $pythonPointer -PathType Leaf
    qwenModelConfigured = Test-Path -LiteralPath $modelPointer -PathType Leaf
    tunnelClientInstalled = Test-Path -LiteralPath $paths.Executable -PathType Leaf
    tunnelConfigured = (Test-Path -LiteralPath $paths.State -PathType Leaf) -and (Test-Path -LiteralPath $paths.Profile -PathType Leaf)
    localMcpReady = [bool]$localReady
    tunnelHealthy = [bool]$tunnelHealth.healthy
    tunnelReady = [bool]$tunnelHealth.ready
    inboundPublicPortRequired = $false
    vpsRequired = $false
} | ConvertTo-Json
