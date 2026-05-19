param(
  [string]$Python = "",
  [string]$RepoUrl = "https://github.com/FunAudioLLM/CosyVoice.git",
  [string]$ModelId = "iic/CosyVoice2-0.5B",
  [string]$PipIndexUrl = "https://mirrors.aliyun.com/pypi/simple/"
)

$ErrorActionPreference = "Stop"

function Resolve-PythonCommand([string]$RequestedPython) {
  $candidates = @()
  if ($RequestedPython.Trim()) {
    $candidates += $RequestedPython
  }

  $candidates += @(
    "py -3.10",
    "py -3.11",
    "python"
  )

  foreach ($candidate in $candidates) {
    $parts = $candidate -split " "
    $command = $parts[0]
    $args = @($parts | Select-Object -Skip 1)

    try {
      & $command @($args + @("--version")) | Out-Host
      if ($LASTEXITCODE -eq 0) {
        return [pscustomobject]@{
          Command = $command
          Args = $args
        }
      }
    } catch {
      continue
    }
  }

  throw @"
No usable Python runtime was found.
Install Python 3.10 first, then rerun:
  winget install Python.Python.3.10
  powershell.exe -ExecutionPolicy Bypass -File .\scripts\setup-cosyvoice.ps1
"@
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$modelsDir = Join-Path $projectRoot "models"
$repoDir = Join-Path $modelsDir "CosyVoice"
$venvDir = Join-Path $repoDir ".venv"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"

New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

if (-not (Test-Path $repoDir)) {
  git clone --recursive $RepoUrl $repoDir
} else {
  Push-Location $repoDir
  git pull
  git submodule update --init --recursive
  Pop-Location
}

if (-not (Test-Path $pythonExe)) {
  $pythonCommand = Resolve-PythonCommand $Python
  $pythonCommandName = $pythonCommand.Command
  $pythonArgs = @($pythonCommand.Args) + @("-m", "venv", $venvDir)
  Invoke-Checked $pythonCommandName $pythonArgs
}

if (Test-Path $pythonExe) {
  & $pythonExe --version | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Existing CosyVoice virtual environment is broken. Recreating it..."
    Remove-Item -LiteralPath $venvDir -Recurse -Force
    $pythonCommand = Resolve-PythonCommand $Python
    $pythonCommandName = $pythonCommand.Command
    $pythonArgs = @($pythonCommand.Args) + @("-m", "venv", $venvDir)
    Invoke-Checked $pythonCommandName $pythonArgs
  }
}

if (-not (Test-Path $pythonExe)) {
  throw "Failed to create CosyVoice virtual environment at $venvDir"
}

Invoke-Checked $pythonExe @(
  "-m", "pip", "install",
  "-i", $PipIndexUrl,
  "--trusted-host", "mirrors.aliyun.com",
  "--upgrade", "pip", "setuptools==70.2.0", "wheel"
)
Invoke-Checked $pythonExe @("-m", "pip", "install", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu128")

$requirementsPath = Join-Path $repoDir "requirements.txt"
$filteredRequirementsPath = Join-Path $env:TEMP "auto-speech-cosyvoice-requirements.txt"
Get-Content $requirementsPath |
  Where-Object { $_ -notmatch "^(openai-whisper|torch==|torchaudio==)" } |
  Set-Content $filteredRequirementsPath -Encoding utf8

Invoke-Checked $pythonExe @(
  "-m", "pip", "install",
  "-i", $PipIndexUrl,
  "--trusted-host", "mirrors.aliyun.com",
  "-r", $filteredRequirementsPath
)
Invoke-Checked $pythonExe @(
  "-m", "pip", "install",
  "-i", $PipIndexUrl,
  "--trusted-host", "mirrors.aliyun.com",
  "openai-whisper==20231117",
  "--no-build-isolation"
)
Invoke-Checked $pythonExe @(
  "-m", "pip", "install",
  "-i", $PipIndexUrl,
  "--trusted-host", "mirrors.aliyun.com",
  "huggingface_hub"
)
Invoke-Checked $pythonExe @(
  "-m", "pip", "install",
  "-i", $PipIndexUrl,
  "--trusted-host", "mirrors.aliyun.com",
  "torchcodec"
)
Invoke-Checked $pythonExe @("-c", "from modelscope import snapshot_download; snapshot_download('$ModelId', local_dir=r'$repoDir\pretrained_models\CosyVoice2-0.5B')")

Write-Host "CosyVoice is ready at $repoDir"
