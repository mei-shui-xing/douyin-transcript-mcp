$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $Root 'tools'
$RuntimeDir = Join-Path $Root 'runtime'
$DownloadDir = Join-Path $RuntimeDir 'downloads'
$Target = Join-Path $ToolsDir 'tunnel-client.exe'
New-Item -ItemType Directory -Force -Path $ToolsDir, $DownloadDir | Out-Null

$headers = @{ 'User-Agent' = 'douyin-transcript-mcp-installer' }
$release = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/openai/tunnel-client/releases/latest'
$asset = @($release.assets | Where-Object { $_.name -match '^tunnel-client-v.+-windows-amd64\.zip$' }) | Select-Object -First 1
if (-not $asset) { throw 'The latest official OpenAI release has no Windows AMD64 asset.' }

$archive = Join-Path $DownloadDir ([string]$asset.name)
Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri ([string]$asset.browser_download_url) -OutFile $archive
$expected = ([string]$asset.digest).Replace('sha256:', '').ToLowerInvariant()
if (-not $expected) {
    $sumsAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }) | Select-Object -First 1
    if (-not $sumsAsset) { throw 'The official release does not publish an asset digest or SHA256SUMS.txt.' }
    $sums = (Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri ([string]$sumsAsset.browser_download_url)).Content
    $match = [regex]::Match($sums, "(?im)^([a-f0-9]{64})\s+\*?$([regex]::Escape([string]$asset.name))$")
    if (-not $match.Success) { throw 'The Windows asset is missing from SHA256SUMS.txt.' }
    $expected = $match.Groups[1].Value.ToLowerInvariant()
}
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
    Remove-Item -LiteralPath $archive -Force
    throw 'The downloaded tunnel-client archive failed SHA-256 verification.'
}

$extractDir = Join-Path $DownloadDir ('extract-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $extractDir | Out-Null
try {
    Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
    $candidate = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'tunnel-client.exe' -File | Select-Object -First 1
    if (-not $candidate) { throw 'The verified archive did not contain tunnel-client.exe.' }
    Copy-Item -LiteralPath $candidate.FullName -Destination $Target -Force
}
finally {
    $resolvedExtract = [IO.Path]::GetFullPath($extractDir)
    $resolvedRuntime = [IO.Path]::GetFullPath($RuntimeDir).TrimEnd('\') + '\'
    if ($resolvedExtract.StartsWith($resolvedRuntime, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}

& $Target help | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { throw 'tunnel-client.exe could not start after installation.' }
[IO.File]::WriteAllText(
    (Join-Path $RuntimeDir 'TUNNEL_CLIENT_RELEASE.txt'),
    ([string]$release.tag_name + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)
Write-Host 'Official OpenAI tunnel-client installed and checksum verified.' -ForegroundColor Green
