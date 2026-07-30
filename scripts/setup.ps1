$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw 'Node.js 20 or newer and npm are required.'
}
$versionText = (& $node.Source --version).Trim().TrimStart('v')
$major = [int]$versionText.Split('.')[0]
if ($major -lt 20) { throw 'Node.js 20 or newer is required.' }

Push-Location $Root
try {
    & $npm.Source ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & $npm.Source test
    if ($LASTEXITCODE -ne 0) { throw 'npm test failed.' }
    Write-Host ''
    Write-Host 'Node.js dependencies and MCP fixtures are ready.' -ForegroundColor Green
    Write-Host 'Next: run INSTALL_QWEN.cmd, then INSTALL_TUNNEL_CLIENT.cmd.' -ForegroundColor Cyan
}
finally {
    Pop-Location
}
