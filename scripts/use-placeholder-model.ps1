$ErrorActionPreference = "Stop"

$path = "model_service\model_config.json"
$config = Get-Content $path -Raw | ConvertFrom-Json
$config.activeAdapter = "placeholder"
$config | ConvertTo-Json -Depth 8 | Set-Content $path -Encoding UTF8
Write-Host "Active model adapter: placeholder"
