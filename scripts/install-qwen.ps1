$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root 'runtime'
$LogsDir = Join-Path $Root 'logs'
$VenvDir = Join-Path $RuntimeDir 'qwen-transcript-venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$PythonFile = Join-Path $RuntimeDir 'QWEN_TRANSCRIPT_PYTHON.txt'
$ModelRoot = Join-Path $RuntimeDir 'qwen-asr-models'
$ModelDir = Join-Path $ModelRoot 'Qwen3-ASR-1.7B'
$ModelFile = Join-Path $RuntimeDir 'QWEN_TRANSCRIPT_MODEL.txt'
$DownloadDir = Join-Path $RuntimeDir 'qwen-downloads'
$LogFile = Join-Path $LogsDir 'qwen-transcript-install.log'
$ErrorFile = Join-Path $LogsDir 'qwen-transcript-install-error.txt'
$Downloader = Join-Path $PSScriptRoot 'download_qwen_model.py'
$TorchWheel = Join-Path $DownloadDir 'torch-2.9.1+cu128-cp312-cp312-win_amd64.whl'
$TorchUrl = 'https://mirrors.aliyun.com/pytorch-wheels/cu128/torch-2.9.1%2Bcu128-cp312-cp312-win_amd64.whl'
$TorchSha256 = '3a01f0b64c10a82d444d9fd06b3e8c567b1158b76b2764b8f51bfd8f535064b0'

New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogsDir, $ModelRoot, $DownloadDir | Out-Null
try { Start-Transcript -Path $LogFile -Append -Force | Out-Null } catch { }

function Find-Python312 {
    $uv = Get-Command uv.exe -ErrorAction SilentlyContinue
    if ($uv) {
        $candidate = (& $uv.Source python find 3.12 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or -not $candidate -or -not (Test-Path $candidate)) {
            Write-Host 'Installing a managed Python 3.12 runtime...' -ForegroundColor Cyan
            & $uv.Source python install 3.12
            $candidate = (& $uv.Source python find 3.12 2>$null | Select-Object -First 1)
            if (-not $candidate -or -not (Test-Path $candidate)) {
                throw 'uv could not install Python 3.12.'
            }
        }
        if ($candidate -and (Test-Path $candidate)) { return [string]$candidate }
    }

    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        $candidate = (& $py.Source '-V:3.12' -c 'import sys; print(sys.executable)' 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $candidate -and (Test-Path $candidate)) {
            return [string]$candidate
        }
    }
    return $null
}

function Test-QwenModelReady {
    $firstShard = Join-Path $ModelDir 'model-00001-of-00002.safetensors'
    $secondShard = Join-Path $ModelDir 'model-00002-of-00002.safetensors'
    return (
        (Test-Path (Join-Path $ModelDir 'config.json')) -and
        (Test-Path (Join-Path $ModelDir 'model.safetensors.index.json')) -and
        (Test-Path $firstShard) -and
        (Test-Path $secondShard) -and
        ((Get-Item -LiteralPath $firstShard).Length -gt 3GB) -and
        ((Get-Item -LiteralPath $secondShard).Length -gt 300MB)
    )
}

try {
    foreach ($commandName in @('ffmpeg.exe', 'ffprobe.exe')) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "$commandName was not found on PATH. Install FFmpeg before continuing."
        }
    }
    $freeBytes = (Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($Root).TrimEnd('\').TrimEnd(':'))).Free
    $alreadyInstalled = (Test-Path $VenvPython) -and (Test-QwenModelReady)
    if (-not $alreadyInstalled -and $freeBytes -lt 12GB) {
        throw ('Qwen3-ASR setup needs at least 12 GB free space; only {0:N1} GB is available.' -f ($freeBytes / 1GB))
    }

    $base = Find-Python312
    if (-not $base) { throw 'Python 3.12 was not found. Install uv or Python 3.12 and retry.' }

    if (-not (Test-Path $VenvPython)) {
        Write-Host 'Creating the isolated Qwen3-ASR environment...' -ForegroundColor Cyan
        & $base -m venv $VenvDir
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Qwen3-ASR virtual environment.' }
    }

    # The mainland mirror is substantially more reliable for this 2.9 GB wheel.
    # Clear inherited proxy settings only inside this installer process.
    $env:HTTP_PROXY = $null
    $env:HTTPS_PROXY = $null
    $env:ALL_PROXY = $null
    $env:http_proxy = $null
    $env:https_proxy = $null
    $env:all_proxy = $null
    $env:NO_PROXY = '*'

    & $VenvPython -c "import torch; assert torch.__version__ == '2.9.1+cu128'; assert torch.cuda.is_available()" 2>$null
    $torchReady = ($LASTEXITCODE -eq 0)
    if (-not $torchReady) {
        Write-Host 'Downloading the verified CUDA-enabled PyTorch runtime...' -ForegroundColor Cyan
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if (-not $curl) { throw 'curl.exe is required to download the PyTorch wheel.' }

        $verified = $false
        for ($attempt = 1; $attempt -le 2 -and -not $verified; $attempt++) {
            & $curl.Source --fail --location --retry 5 --retry-delay 2 --continue-at - `
                --noproxy '*' --output $TorchWheel $TorchUrl
            if ($LASTEXITCODE -ne 0) { throw 'PyTorch wheel download failed.' }
            $actualSha256 = (Get-FileHash -LiteralPath $TorchWheel -Algorithm SHA256).Hash.ToLowerInvariant()
            $verified = ($actualSha256 -eq $TorchSha256)
            if (-not $verified) {
                Remove-Item -LiteralPath $TorchWheel -Force
                Write-Host 'PyTorch checksum mismatch; retrying from a clean file...' -ForegroundColor Yellow
            }
        }
        if (-not $verified) { throw 'PyTorch wheel checksum verification failed twice.' }

        & $VenvPython -m pip install --disable-pip-version-check --no-warn-script-location `
            --no-cache-dir $TorchWheel
        if ($LASTEXITCODE -ne 0) { throw 'CUDA-enabled PyTorch installation failed.' }
        Remove-Item -LiteralPath $TorchWheel -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host 'CUDA-enabled PyTorch is already installed; reusing it.' -ForegroundColor Green
    }

    & $VenvPython -c "import qwen_asr, modelscope" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Installing Qwen3-ASR and ModelScope...' -ForegroundColor Cyan
        & $VenvPython -m pip install --disable-pip-version-check --no-warn-script-location `
            'qwen-asr==0.0.6' 'modelscope>=1.31,<2' -i 'https://mirrors.aliyun.com/pypi/simple/'
        if ($LASTEXITCODE -ne 0) { throw 'Qwen3-ASR dependency installation failed.' }
    } else {
        Write-Host 'Qwen3-ASR dependencies are already installed; reusing them.' -ForegroundColor Green
    }

    & $VenvPython -c "import torch, qwen_asr, modelscope; assert torch.cuda.is_available(); print(torch.__version__, torch.cuda.get_device_name(0))"
    if ($LASTEXITCODE -ne 0) { throw 'Qwen3-ASR import or CUDA verification failed.' }

    if (-not (Test-QwenModelReady)) {
        Write-Host 'Downloading Qwen3-ASR-1.7B from ModelScope (one time only)...' -ForegroundColor Cyan
        & $VenvPython $Downloader --model 'Qwen/Qwen3-ASR-1.7B' --output $ModelDir
        if ($LASTEXITCODE -ne 0) { throw 'Qwen3-ASR model download failed.' }
        if (-not (Test-QwenModelReady)) { throw 'Qwen3-ASR model files are incomplete.' }
    } else {
        Write-Host 'Qwen3-ASR model is already present; reusing it.' -ForegroundColor Green
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($PythonFile, $VenvPython + [Environment]::NewLine, $utf8NoBom)
    [System.IO.File]::WriteAllText($ModelFile, $ModelDir + [Environment]::NewLine, $utf8NoBom)
    Remove-Item -LiteralPath $ErrorFile -Force -ErrorAction SilentlyContinue

    Write-Host ''
    Write-Host 'Qwen3-ASR accurate transcription installed successfully.' -ForegroundColor Green
    Write-Host 'Run START.cmd after configuring your OpenAI Secure MCP Tunnel.'
    exit 0
}
catch {
    $message = @(
        'Qwen3-ASR setup failed.',
        ('Time: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')),
        ('Error: ' + $_.Exception.Message),
        '',
        'Full log: logs\qwen-transcript-install.log'
    ) -join [Environment]::NewLine
    $message | Set-Content -LiteralPath $ErrorFile -Encoding UTF8
    Write-Host $message -ForegroundColor Red
    exit 1
}
finally {
    try { Stop-Transcript | Out-Null } catch { }
}
