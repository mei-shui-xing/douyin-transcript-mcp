$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'tunnel-common.ps1')
$paths = Get-TunnelPaths -Root $Root
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'runtime'), (Join-Path $Root 'logs') | Out-Null

if (Test-Path -LiteralPath $paths.Pids) {
    & (Join-Path $PSScriptRoot 'stop.ps1')
}
$state = Read-TunnelState -LiteralPath $paths.State
foreach ($required in @($paths.Executable, $paths.Profile, (Join-Path $Root 'dist\index.js'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing required file: $required" }
}

$node = Get-Command node.exe -ErrorAction Stop
$mcp = $null
$tunnel = $null
try {
    Remove-Item -LiteralPath $paths.HealthUrl, $paths.TunnelPid, $paths.McpStdout, $paths.McpStderr, $paths.TunnelLog -Force -ErrorAction SilentlyContinue
    $mcp = Start-Process -FilePath $node.Source `
        -ArgumentList @(('"' + (Join-Path $Root 'dist\index.js') + '"'), '--http') `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $paths.McpStdout `
        -RedirectStandardError $paths.McpStderr `
        -PassThru
    $localReady = $false
    for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
        Start-Sleep -Milliseconds 100
        $mcp.Refresh()
        if ($mcp.HasExited) { throw 'The local MCP server exited during startup.' }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:31338/healthz' -TimeoutSec 2
            if ($health.ok -eq $true -and $health.loopbackOnly -eq $true) { $localReady = $true; break }
        } catch { }
    }
    if (-not $localReady) { throw 'The local MCP server did not become ready.' }

    $apiKey = Unprotect-ApiKey -ProtectedValue ([string]$state.protectedApiKey)
    try {
        $env:CONTROL_PLANE_API_KEY = $apiKey
        $tunnel = Start-Process -FilePath $paths.Executable `
            -ArgumentList @(
                'run', '--profile', 'douyin-transcript', '--profile-dir', ('"' + $paths.ProfileDir + '"'),
                '--health.url-file', ('"' + $paths.HealthUrl + '"'), '--pid.file', ('"' + $paths.TunnelPid + '"'),
                '--log.file', ('"' + $paths.TunnelLog + '"'), '--log.format', 'json', '--log.level', 'warn'
            ) `
            -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -PassThru
    }
    finally {
        Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
        $apiKey = $null
    }

    $tunnelReady = $false
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        $tunnel.Refresh()
        if ($tunnel.HasExited) { throw 'tunnel-client exited during startup.' }
        $health = Get-TunnelHealth -HealthUrlFile $paths.HealthUrl
        if ($health.ready) { $tunnelReady = $true; break }
    }
    if (-not $tunnelReady) { throw 'Secure MCP Tunnel did not become ready in 60 seconds.' }

    [IO.File]::WriteAllText(
        $paths.Pids,
        (@{ version = 1; mcpPid = $mcp.Id; tunnelPid = $tunnel.Id; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )
    Protect-PrivatePath -LiteralPath $paths.Pids
    Protect-PrivatePath -LiteralPath $paths.HealthUrl
    Protect-PrivatePath -LiteralPath $paths.TunnelPid
    Write-Host 'Douyin Transcript MCP is ready. No VPS or public inbound port is used.' -ForegroundColor Green
}
catch {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    if ($mcp -and -not $mcp.HasExited) { Stop-Process -Id $mcp.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $paths.Pids, $paths.HealthUrl, $paths.TunnelPid -Force -ErrorAction SilentlyContinue
    throw
}
