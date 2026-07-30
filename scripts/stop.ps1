$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'tunnel-common.ps1')
$paths = Get-TunnelPaths -Root $Root
if (-not (Test-Path -LiteralPath $paths.Pids -PathType Leaf)) {
    Write-Host 'No managed process state was found.' -ForegroundColor Yellow
    exit 0
}
$pids = Get-Content -LiteralPath $paths.Pids -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pids.tunnelPid) { $null = Stop-VerifiedProcess -ProcessId ([int]$pids.tunnelPid) -Role tunnel -Root $Root -Paths $paths }
if ($pids.mcpPid) { $null = Stop-VerifiedProcess -ProcessId ([int]$pids.mcpPid) -Role mcp -Root $Root -Paths $paths }
Remove-Item -LiteralPath $paths.Pids, $paths.HealthUrl, $paths.TunnelPid -Force -ErrorAction SilentlyContinue
Write-Host 'Douyin Transcript MCP stopped. Models and transcript cache were preserved.' -ForegroundColor Green
