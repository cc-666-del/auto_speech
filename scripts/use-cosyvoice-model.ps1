$ErrorActionPreference = "Stop"

$configPath = Join-Path $PSScriptRoot "..\model_service\model_config.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$config.activeAdapter = "cosyvoice"
$config | ConvertTo-Json -Depth 8 | Set-Content $configPath -Encoding utf8

Write-Host "Active model adapter: cosyvoice"
