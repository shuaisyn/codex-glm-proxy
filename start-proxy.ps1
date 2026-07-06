param(
  [int]$Port = 3017,
  [string]$ProviderId = "5672307d-a380-433f-9a28-23c6b2ba95ea",
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

$env:GLM_PROXY_PORT = [string]$Port
$env:XF_PROVIDER_ID = $ProviderId

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
