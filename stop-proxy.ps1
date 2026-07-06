$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$escapedRoot = [Regex]::Escape($Root)

$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -like "*node.exe" -and
  $_.CommandLine -match "server\.js" -and
  $_.CommandLine -match $escapedRoot
}

if (!$procs) {
  Write-Output "codex-glm-proxy is not running"
  exit 0
}

$procs | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
  Write-Output "stopped codex-glm-proxy pid=$($_.ProcessId)"
}
