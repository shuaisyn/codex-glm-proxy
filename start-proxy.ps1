param(
  [int]$Port = 3017,
  [string]$ProviderId = "5672307d-a380-433f-9a28-23c6b2ba95ea",
  [string]$ProvidersFile = "",
  [ValidateSet('version1', 'version2')]
  [string]$Profile = 'version1',
  [string]$Node = "C:\Program Files\nodejs\node.exe"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Health = "http://127.0.0.1:$Port/health?provider=$ProviderId"

try {
  $r = Invoke-RestMethod -Uri $Health -TimeoutSec 2
  if ($r.ok) {
    Write-Output "codex-glm-proxy already running on $Port"
    exit 0
  }
} catch {}

if (!(Test-Path $Node)) {
  $Node = "node"
}

function Set-EnvIfMissing([string]$Name, [string]$Value) {
  if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) {
    return
  }
  [Environment]::SetEnvironmentVariable($Name, $Value)
}

$env:GLM_PROXY_PORT = [string]$Port
$env:XF_PROVIDER_ID = $ProviderId

switch ($Profile) {
  "version1" {
    # 兼容版：参数偏保守，兼顾上手体验
    Set-EnvIfMissing -Name "XF_CHAT_BUSY_RETRY_MAX" -Value "5"
    Set-EnvIfMissing -Name "XF_CHAT_STEADY_RETRY_DELAY_MS" -Value "10000"
    Set-EnvIfMissing -Name "XF_CHAT_DIAGNOSTIC_EVERY" -Value "5"
    Set-EnvIfMissing -Name "XF_UPSTREAM_TIMEOUT_MS" -Value "25000"
    Set-EnvIfMissing -Name "XF_MAX_JSON_BODY_BYTES" -Value "2097152"
    Set-EnvIfMissing -Name "XF_CHAT_PANEL_DIAGNOSTICS" -Value "1"
  }
  "version2" {
    # 稳健版：更偏向高可用与观测
    Set-EnvIfMissing -Name "XF_CHAT_BUSY_RETRY_MAX" -Value "7"
    Set-EnvIfMissing -Name "XF_CHAT_DIAGNOSTIC_EVERY" -Value "3"
    Set-EnvIfMissing -Name "XF_CHAT_STEADY_RETRY_DELAY_MS" -Value "8000"
    Set-EnvIfMissing -Name "XF_UPSTREAM_TIMEOUT_MS" -Value "35000"
    Set-EnvIfMissing -Name "XF_MAX_JSON_BODY_BYTES" -Value "4194304"
    Set-EnvIfMissing -Name "XF_CHAT_PANEL_DIAGNOSTICS" -Value "1"
  }
}

if (-not [string]::IsNullOrWhiteSpace($ProvidersFile)) {
  $env:GLM_PROVIDERS_JSON = (Resolve-Path $ProvidersFile).Path
} else {
  $env:GLM_PROVIDERS_JSON = (Join-Path $Root "providers.json")
}

Write-Output "start-proxy profile=$Profile port=$Port provider=$ProviderId"
Write-Output "read providers: $env:GLM_PROVIDERS_JSON"
Write-Output "chat retry max: $env:XF_CHAT_BUSY_RETRY_MAX, stable delay: $env:XF_CHAT_STEADY_RETRY_DELAY_MS, upstream timeout: $env:XF_UPSTREAM_TIMEOUT_MS"

$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$OutLog = Join-Path $LogDir "codex-glm-proxy.out.log"
$ErrLog = Join-Path $LogDir "codex-glm-proxy.err.log"

$Server = Join-Path $Root "server.js"

Start-Process -FilePath $Node `
  -ArgumentList "`"$Server`"" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog

Start-Sleep -Seconds 2
$r = Invoke-RestMethod -Uri $Health -TimeoutSec 5
if (!$r.ok) {
  throw "codex-glm-proxy did not become healthy"
}

Write-Output "codex-glm-proxy started on $Port"
