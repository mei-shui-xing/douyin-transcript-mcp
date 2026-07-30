$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'tunnel-common.ps1')
$paths = Get-TunnelPaths -Root $Root

foreach ($required in @($paths.Executable, (Join-Path $Root 'dist\index.js'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw 'Run SETUP.cmd and INSTALL_TUNNEL_CLIENT.cmd before configuring the tunnel.'
    }
}

$tunnelId = (Read-Host 'Paste your own tunnel_id from OpenAI Platform').Trim()
if ($tunnelId -notmatch '^tunnel_[a-z0-9]{32}$') { throw 'Invalid tunnel_id.' }
$secure = Read-Host 'Paste the runtime API key (input is hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$apiKey = ''
try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ($apiKey -notmatch '^sk-[A-Za-z0-9_-]{20,}$') { throw 'Invalid runtime API key.' }
    New-Item -ItemType Directory -Force -Path $paths.PrivateDir, $paths.ProfileDir | Out-Null
    $protected = Protect-ApiKey -Value $apiKey
    [IO.File]::WriteAllText(
        $paths.State,
        (@{ version = 1; protectedApiKey = $protected } | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )
    $env:CONTROL_PLANE_API_KEY = $apiKey
    try {
        & $paths.Executable init `
            --force `
            --sample sample_mcp_remote_no_auth `
            --profile douyin-transcript `
            --profile-dir $paths.ProfileDir `
            --tunnel-id $tunnelId `
            --mcp-server-url 'http://127.0.0.1:31338/mcp' `
            --health-listen-addr '127.0.0.1:0'
        if ($LASTEXITCODE -ne 0) { throw 'tunnel-client init failed.' }
    }
    finally {
        Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    }
    Protect-PrivatePath -LiteralPath $paths.PrivateDir
    Protect-PrivatePath -LiteralPath $paths.ProfileDir
    Protect-PrivatePath -LiteralPath $paths.State
    Protect-PrivatePath -LiteralPath $paths.Profile
    Write-Host 'Tunnel configuration saved with Windows DPAPI protection.' -ForegroundColor Green
    Write-Host 'Run START.cmd, then select this tunnel in ChatGPT developer-mode plugin settings.' -ForegroundColor Cyan
}
finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $apiKey = $null
    $secure = $null
}
