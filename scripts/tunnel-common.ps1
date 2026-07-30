$ErrorActionPreference = 'Stop'

function Get-TunnelPaths {
    param([Parameter(Mandatory = $true)][string]$Root)
    [pscustomobject]@{
        Executable = Join-Path $Root 'tools\tunnel-client.exe'
        PrivateDir = Join-Path $Root 'runtime\private-config'
        State = Join-Path $Root 'runtime\private-config\tunnel-state.json'
        ProfileDir = Join-Path $Root 'runtime\private-config\tunnel-client'
        Profile = Join-Path $Root 'runtime\private-config\tunnel-client\douyin-transcript.yaml'
        HealthUrl = Join-Path $Root 'runtime\tunnel-health-url.txt'
        TunnelPid = Join-Path $Root 'runtime\tunnel-client.pid'
        Pids = Join-Path $Root 'runtime\pids.json'
        TunnelLog = Join-Path $Root 'logs\tunnel-client.log'
        McpStdout = Join-Path $Root 'logs\mcp-stdout.log'
        McpStderr = Join-Path $Root 'logs\mcp-stderr.log'
    }
}

function Protect-PrivatePath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $grant = if ((Get-Item -LiteralPath $LiteralPath).PSIsContainer) {
        "*$sid`:(OI)(CI)F"
    } else { "*$sid`:F" }
    & icacls.exe $LiteralPath /inheritance:r /grant:r $grant '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to restrict ACLs for $LiteralPath" }
}

function Protect-ApiKey {
    param([Parameter(Mandatory = $true)][string]$Value)
    Add-Type -AssemblyName System.Security
    $plain = [Text.Encoding]::UTF8.GetBytes($Value)
    $entropy = [Text.Encoding]::UTF8.GetBytes('douyin-transcript-mcp:tunnel-key:v1')
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect(
            $plain,
            $entropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Convert]::ToBase64String($protected)
    }
    finally {
        [Array]::Clear($plain, 0, $plain.Length)
        [Array]::Clear($entropy, 0, $entropy.Length)
    }
}

function Unprotect-ApiKey {
    param([Parameter(Mandatory = $true)][string]$ProtectedValue)
    Add-Type -AssemblyName System.Security
    $protected = [Convert]::FromBase64String($ProtectedValue)
    $entropy = [Text.Encoding]::UTF8.GetBytes('douyin-transcript-mcp:tunnel-key:v1')
    $plain = $null
    try {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect(
            $protected,
            $entropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $value = [Text.Encoding]::UTF8.GetString($plain)
        if ($value -notmatch '^sk-[A-Za-z0-9_-]{20,}$') { throw 'The stored runtime API key is invalid.' }
        return $value
    }
    finally {
        if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
        [Array]::Clear($protected, 0, $protected.Length)
        [Array]::Clear($entropy, 0, $entropy.Length)
    }
}

function Read-TunnelState {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        throw 'Tunnel configuration is missing. Run CONFIGURE_TUNNEL.cmd first.'
    }
    $state = Get-Content -LiteralPath $LiteralPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$state.version -ne 1 -or [string]$state.protectedApiKey -notmatch '^[A-Za-z0-9+/=]+$') {
        throw 'Tunnel configuration is invalid.'
    }
    return $state
}

function Get-TunnelHealth {
    param([Parameter(Mandatory = $true)][string]$HealthUrlFile)
    if (-not (Test-Path -LiteralPath $HealthUrlFile -PathType Leaf)) {
        return [pscustomobject]@{ healthy = $false; ready = $false }
    }
    $raw = (Get-Content -LiteralPath $HealthUrlFile -Raw -Encoding UTF8).Trim()
    $base = $null
    if (-not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$base) -or
        $base.Scheme -ne 'http' -or $base.Host -notin @('127.0.0.1', 'localhost')) {
        return [pscustomobject]@{ healthy = $false; ready = $false }
    }
    $healthy = $false
    $ready = $false
    try { $healthy = (Invoke-WebRequest -UseBasicParsing -Uri ([Uri]::new($base, '/healthz')) -TimeoutSec 3).StatusCode -eq 200 } catch { }
    try { $ready = (Invoke-WebRequest -UseBasicParsing -Uri ([Uri]::new($base, '/readyz')) -TimeoutSec 3).StatusCode -eq 200 } catch { }
    [pscustomobject]@{ healthy = [bool]$healthy; ready = [bool]$ready }
}

function Stop-VerifiedProcess {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$Paths
    )
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $candidate) { return $true }
    $valid = $false
    if ($Role -eq 'mcp') {
        $valid = $candidate.Name -eq 'node.exe' -and $candidate.CommandLine -and
            $candidate.CommandLine.Contains((Join-Path $Root 'dist\index.js')) -and
            $candidate.CommandLine.Contains('--http')
    }
    elseif ($Role -eq 'tunnel') {
        $valid = $candidate.ExecutablePath -and
            [IO.Path]::GetFullPath([string]$candidate.ExecutablePath) -eq [IO.Path]::GetFullPath([string]$Paths.Executable) -and
            $candidate.CommandLine -and $candidate.CommandLine.Contains([string]$Paths.ProfileDir)
    }
    if (-not $valid) { throw "Refusing to stop an unverified $Role process." }
    Stop-Process -Id $ProcessId -Force
    for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 100
    }
    throw "The verified $Role process did not stop."
}
