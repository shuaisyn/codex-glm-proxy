param(
  [Parameter(Mandatory = $true)]
  [string]$Workdir,

  [Parameter(Mandatory = $true)]
  [string]$Prompt,

  [string]$CodexCmd = "C:\Users\shuai\AppData\Local\OpenAI\Codex\bin\ea1c60319a1dcb19\codex.exe",
  [int]$Port = 3017,
  [string]$ProviderId = "5672307d-a380-433f-9a28-23c6b2ba95ea"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (!(Test-Path $CodexCmd)) {
  throw "Codex executable not found: $CodexCmd"
}

$resolvedWorkdir = (Resolve-Path -LiteralPath $Workdir).Path
$workspaceRoot = (Resolve-Path -LiteralPath "C:\Users\shuai\Documents\Codex").Path
if ($resolvedWorkdir -eq $workspaceRoot) {
  throw "Refusing to run GLM-5.2 from workspace root. Pass a concrete git repo or existing worktree."
}

$inside = git -C $resolvedWorkdir rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -ne 0 -or $inside.Trim() -ne "true") {
  throw "Workdir is not a git repository: $resolvedWorkdir"
}

git -C $resolvedWorkdir status --short --branch

& (Join-Path $Root "start-proxy.ps1") -Port $Port -ProviderId $ProviderId | Write-Output

$BaseUrl = "http://127.0.0.1:$Port/v1"
$argsList = @(
  "exec",
  "--profile", "glm",
  "--skip-git-repo-check",
  "-C", $resolvedWorkdir,
  "-c", 'model="xopglm52"',
  "-c", "model_providers.xf_maas_coding.base_url=`"$BaseUrl`"",
  "-c", 'model_providers.xf_maas_coding.wire_api="responses"',
  "-c", 'model_reasoning_effort="high"',
  "-c", 'model_supports_reasoning_summaries=true',
  "-c", 'model_reasoning_summary="none"',
  $Prompt
)

& $CodexCmd @argsList
exit $LASTEXITCODE
