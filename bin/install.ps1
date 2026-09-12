<#
.SYNOPSIS
  MyOS Dispatch installer (Windows PowerShell).

.DESCRIPTION
  Functional equivalent of bin/install.sh for Windows.

  SAFE BY DESIGN:
    - Never overwrites %USERPROFILE%\.claude\settings.json. It backs it up
      first, then JSON-MERGES a single hook entry with node (idempotent).
    - Never global-installs into your language runtimes.
    - Scoped: writes generated state only under $env:MYOS_HOME_ROOT.
    - Reversible with -Uninstall.

  Skips Mac-only bits (no launchd, no mlx, no bash hooks).

.PARAMETER Runtime
  claude (default), codex, or both. Codex requires review in /hooks.
.PARAMETER Yes
  Non-interactive; skip the confirm before writing settings.json.
.PARAMETER WithPretool
  Also register a PreToolUse(Bash) hook.
.PARAMETER WithExtras
  Build optional deps too (better-sqlite3 native build).
.PARAMETER WithGraphify
  Install optional graphify (pipx preferred, else pip --user).
.PARAMETER WithGitnexus
  Verify optional gitnexus via npx (no global install).
.PARAMETER IndexDir
  Directory to scan for the new user's projects.
.PARAMETER NoHook
  Skip settings.json hook registration.
.PARAMETER Uninstall
  Reverse the install.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File bin\install.ps1 -Yes -IndexDir C:\Users\me\projects
#>

[CmdletBinding()]
param(
  [ValidateSet("claude", "codex", "both")]
  [string]$Runtime = "claude",
  [switch]$Yes,
  [switch]$WithPretool,
  [switch]$WithExtras,
  [switch]$WithGraphify,
  [switch]$WithGitnexus,
  [string]$IndexDir = "",
  [switch]$NoHook,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "  * $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Step($m) { Write-Host "`n$m" -ForegroundColor White }
function Die($m)  { Write-Host "  [x] $m" -ForegroundColor Red; exit 1 }

# --- Resolve paths ---------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir   = if ($env:MYOS_DISPATCH_DIR) { $env:MYOS_DISPATCH_DIR } else { (Resolve-Path (Join-Path $ScriptDir "..")).Path }
$HomeRoot  = if ($env:MYOS_HOME_ROOT) { $env:MYOS_HOME_ROOT } else { Join-Path $env:USERPROFILE ".myos-dispatch" }
$WorkspaceDir = Join-Path $HomeRoot "workspace"
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$Settings  = Join-Path $ClaudeDir "settings.json"
$CodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$CodexSettings = Join-Path $CodexDir "hooks.json"
$Runtimes = if ($Runtime -eq "both") { @("claude", "codex") } else { @($Runtime) }
$HookPath  = Join-Path $RepoDir "bin\myos-dispatch-hook"
$IndexPath = Join-Path $WorkspaceDir "capabilities-index.json"

function Resolve-Node {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

# --- Uninstall -------------------------------------------------------------
if ($Uninstall) {
  Step "Uninstalling MyOS Dispatch"
  $node = Resolve-Node
  foreach ($surface in $Runtimes) {
    $target = if ($surface -eq "codex") { $CodexSettings } else { $Settings }
    if ($node -and (Test-Path $target)) {
      & $node (Join-Path $RepoDir "scripts\register-hook.js") --settings $target --surface $surface --remove
      if ($LASTEXITCODE -ne 0) { Die "Hook removal failed for $surface; inspect $target." }
      Ok "Removed $surface Dispatch registration; timestamped backups retained."
    }
  }
  if (Test-Path $IndexPath) { Remove-Item $IndexPath -Force; Ok "Removed generated index $IndexPath" }
  Info "Repo dir ($RepoDir) and node_modules were left in place. Remove manually if desired."
  Step "Uninstall complete."
  exit 0
}

# --- 1. Preflight ----------------------------------------------------------
Step "1/6  Preflight checks"
Info "Windows native profiles selected. WSL uses its own Linux HOME and bash installer."
$NodeBin = Resolve-Node
if (-not $NodeBin) { Die "Node.js >= 20 is required but not found. Install from https://nodejs.org/ or 'winget install OpenJS.NodeJS.LTS'." }
$NodeMajor = [int](& $NodeBin -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 20) { Die "Node.js >= 20 required (found $(& $NodeBin -v))." }
Ok "node $(& $NodeBin -v) ($NodeBin)"

if ($WithExtras -and -not (Get-Command npm -ErrorAction SilentlyContinue)) { Die "npm is required for -WithExtras." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Warn "git not found — needed only for updates." }

foreach ($pair in @(@("python","python3 (optional; for --with-graphify)"), @("pipx","pipx (optional, preferred for graphify)"), @("rg","ripgrep (optional)"), @("sqlite3","sqlite3 (optional)"))) {
  if (Get-Command $pair[0] -ErrorAction SilentlyContinue) { Ok "$($pair[1]) present" } else { Info "$($pair[1]) not found" }
}
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "claude CLI present (optional)" }
elseif (Get-Command codex -ErrorAction SilentlyContinue) { Ok "codex CLI present (optional)" }
else { Info "no agent CLI (claude/codex) found (optional)" }

if (-not (Test-Path $HookPath)) { Die "Hook not found at $HookPath — run this from inside the myos-dispatch repo." }

# --- 2. Node deps (scoped) -------------------------------------------------
Step "2/6  Installing node dependencies (scoped to repo, never global)"
Push-Location $RepoDir
try {
  if ($WithExtras) { npm install; if ($LASTEXITCODE -ne 0) { Die "Dependency installation failed." } }
  else { Info "Core uses Node built-ins; no dependency installation required." }
} finally { Pop-Location }
Ok "Core ready (optional dependency install only with -WithExtras)."

# --- 3. Optional components ------------------------------------------------
Step "3/6  Optional components"
if ($WithGraphify) {
  if (Get-Command pipx -ErrorAction SilentlyContinue) {
    try { pipx install graphifyy | Out-Null; Ok "graphify installed via pipx" } catch { Warn "pipx install failed; skipping (optional)" }
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    try { python -m pip install --user graphifyy | Out-Null; Ok "graphify installed via pip --user" } catch { Warn "pip --user install failed; skipping (optional)" }
  } else { Warn "Neither pipx nor python found; skipping graphify (optional)." }
} else { Info "graphify: skipped (pass -WithGraphify to enable)" }

if ($WithGitnexus) {
  if (Get-Command npx -ErrorAction SilentlyContinue) {
    try { npx --yes gitnexus --version | Out-Null; Ok "gitnexus reachable via npx (ephemeral, no global install)" }
    catch { Warn "npx gitnexus check did not succeed; fetched on first use (optional)." }
  } else { Warn "npx not found; skipping gitnexus check (optional)." }
} else { Info "gitnexus: skipped (pass -WithGitnexus to verify)" }

# --- 4. Build the new user's index -----------------------------------------
Step "4/6  Building your capability index"
New-Item -ItemType Directory -Force -Path $WorkspaceDir | Out-Null
$genArgs = @((Join-Path $RepoDir "scripts\generate-index.js"), "--out", $IndexPath)
if ($IndexDir) {
  if (-not (Test-Path $IndexDir -PathType Container)) { Die "-IndexDir '$IndexDir' is not a directory." }
  $genArgs += @("--dir", $IndexDir)
  Info "Scanning $IndexDir for recipes / skills / workflows…"
} else {
  Info "No -IndexDir given; scaffolding an empty (but valid) index."
  $genArgs += @("--dir", $WorkspaceDir)
}
$env:MYOS_HOME_ROOT = $HomeRoot
& $NodeBin @genArgs
if ($LASTEXITCODE -ne 0) { Die "Index generation failed." }
Ok "Index written to $IndexPath"

# --- 5. Register selected hosts --------------------------------------------
Step "5/7  Registering selected runtime hooks"
$Transactions = @()
$PreviousFanout = $env:MYOS_AUTO_FANOUT
$PreviousBackground = $env:MYOS_BACKGROUND_AGENTS_ENABLED
try {
  if ($NoHook) {
    Info "-NoHook set; skipping host registration."
  } else {
    # Validate all hosts before writing either one.
    foreach ($surface in $Runtimes) {
      $target = if ($surface -eq "codex") { $CodexSettings } else { $Settings }
      $regArgs = @((Join-Path $RepoDir "scripts\register-hook.js"), "--settings", $target, "--node", $NodeBin, "--hook", $HookPath, "--home", $HomeRoot, "--surface", $surface)
      if ($WithPretool) { $regArgs += "--with-pretool" }
      & $NodeBin @regArgs --dry-run
      if ($LASTEXITCODE -ne 0) { throw "Hook validation failed for $surface." }
    }
    $proceed = $Yes
    if (-not $Yes) { $proceed = (Read-Host "Apply these hook merges? [y/N]") -in @("y", "Y", "yes", "YES") }
    if ($proceed) {
      foreach ($surface in $Runtimes) {
        $target = if ($surface -eq "codex") { $CodexSettings } else { $Settings }
        $transaction = [System.IO.Path]::GetTempFileName()
        $Transactions += @{ Target = $target; Record = $transaction }
        $regArgs = @((Join-Path $RepoDir "scripts\register-hook.js"), "--settings", $target, "--node", $NodeBin, "--hook", $HookPath, "--home", $HomeRoot, "--surface", $surface, "--transaction", $transaction)
        if ($WithPretool) { $regArgs += "--with-pretool" }
        & $NodeBin @regArgs
        if ($LASTEXITCODE -ne 0) { throw "Hook registration failed for $surface." }
        Ok "$surface registration saved: $target; host execution/trust not verified."
      }
    } else { $NoHook = $true }
  }

  Step "6/7  Direct binary smoke tests"
  $env:MYOS_AUTO_FANOUT = "0"
  $env:MYOS_BACKGROUND_AGENTS_ENABLED = "0"
  foreach ($surface in $Runtimes) {
    if ($env:MYOS_TEST_FAIL_SMOKE -eq "1") { throw "Smoke test failed (injected)." }
    $smoke = '{"prompt":"test","hookEventName":"UserPromptSubmit"}' | & $NodeBin $HookPath "--surface=$surface"
    if ($LASTEXITCODE -ne 0 -or ($smoke -join "`n") -notmatch '"additionalContext"') { throw "Smoke test failed for $surface." }
    Ok "$surface binary emitted additionalContext (direct invocation)."
  }
} catch {
  foreach ($transaction in $Transactions) {
    if ((Get-Item $transaction.Record).Length -gt 0) {
      & $NodeBin (Join-Path $RepoDir "scripts\register-hook.js") --settings $transaction.Target --rollback $transaction.Record
      if ($LASTEXITCODE -ne 0) { Warn "Rollback refused; inspect $($transaction.Target) and backups." }
    }
  }
  throw
} finally {
  $env:MYOS_AUTO_FANOUT = $PreviousFanout
  $env:MYOS_BACKGROUND_AGENTS_ENABLED = $PreviousBackground
  foreach ($transaction in $Transactions) { Remove-Item $transaction.Record -ErrorAction SilentlyContinue }
}

# --- 7. Local model catalog report ----------------------------------------
Step "7/7  Building the local model catalog report"
try {
  & $NodeBin (Join-Path $RepoDir "scripts\setup-model-catalog.js") --home $HomeRoot --report
  if ($LASTEXITCODE -ne 0) { throw "Model report failed." }
  Ok "Read-only report complete; run setup-model-catalog.js without --report to save."
} catch {
  Warn "Model catalog report failed; continuing without blocking install."
}

Step "MyOS Dispatch installed."
Write-Host @"

  Repo:        $RepoDir
  Data home:   $HomeRoot  (MYOS_HOME_ROOT)
  Index:       $IndexPath
  Model catalog: $(Join-Path $HomeRoot 'config\model-catalog.local.json')
  Runtimes: $Runtime
  Registration: $(if ($NoHook) { 'not registered (-NoHook)' } else { 'saved; host execution/trust not verified' })

  Next steps:
    - Restart the selected host. In Codex use /hooks to review and trust Dispatch.
    - On older Codex without /hooks, direct invocation is the verified fallback.
    - Re-run with -IndexDir <your projects dir> to index your work.
    - Uninstall any time: powershell -File bin\install.ps1 -Runtime $Runtime -Uninstall

"@
