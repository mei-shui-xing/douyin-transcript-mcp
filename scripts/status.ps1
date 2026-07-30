$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'tunnel-common.ps1')
$paths = Get-TunnelPaths -Root $Root
$localReady = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:31338/healthz' -TimeoutSec 3
    $localReady = $health.ok -eq $true -and $health.loopbackOnly -eq $true -and [int]$health.tools -eq 5
} catch { }
$tunnelHealth = Get-TunnelHealth -HealthUrlFile $paths.HealthUrl
[pscustomobject]@{
    configured = (Test-Path -LiteralPath $paths.State -PathType Leaf) -and (Test-Path -LiteralPath $paths.Profile -PathType Leaf)
    localMcpReady = [bool]$localReady
    tunnelHealthy = [bool]$tunnelHealth.healthy
    tunnelReady = [bool]$tunnelHealth.ready
    noVpsRequired = $true
} | ConvertTo-Json
if ($localReady -and $tunnelHealth.ready) {
    Write-Host 'Ready: ChatGPT can use the five read-only transcription tools.' -ForegroundColor Green
} else {
    Write-Host 'Not ready. Run START.cmd or DIAGNOSE.cmd.' -ForegroundColor Yellow
    exit 1
}
