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
  if ($node -and (Test-Path $Settings)) {
    & $node (Join-Path $RepoDir "scripts\register-hook.js") --settings $Settings --remove
    Ok "Stripped MyOS Dispatch hook + env key from $Settings"
    $bak = Get-ChildItem "$Settings.bak-*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($bak) { Info "A timestamped backup remains for full restore: $($bak.FullName)" }
  } else {
    Info "No node or no settings.json; nothing to strip."
  }
  if (Test-Path $IndexPath) { Remove-Item $IndexPath -Force; Ok "Removed generated index $IndexPath" }
  Info "Repo dir ($RepoDir) and node_modules were left in place. Remove manually if desired."
  Step "Uninstall complete."
  exit 0
}

# --- 1. Preflight ----------------------------------------------------------
Step "1/6  Preflight checks"
$NodeBin = Resolve-Node
if (-not $NodeBin) { Die "Node.js >= 20 is required but not found. Install from https://nodejs.org/ or 'winget install OpenJS.NodeJS.LTS'." }
$NodeMajor = [int](& $NodeBin -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 20) { Die "Node.js >= 20 required (found $(& $NodeBin -v))." }
Ok "node $(& $NodeBin -v) ($NodeBin)"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die "npm is required but not found." }
Ok "npm $(npm -v)"
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
  if ($WithExtras) { npm install } else { npm install --omit=optional }
} finally { Pop-Location }
Ok "Dependencies installed under $RepoDir\node_modules"

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
Ok "Index written to $IndexPath"

# --- 5. Register the Claude Code hook --------------------------------------
Step "5/6  Registering the Claude Code dispatch hook"
$HookRegistered = $false
if ($NoHook) {
  Info "-NoHook set; skipping settings.json registration."
} else {
  New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
  # register-hook.js backs up (timestamped) before every write — add and remove —
  # so no separate backup step is needed here.
  if (-not (Test-Path $Settings)) {
    Info "No existing settings.json; a minimal one will be created."
  }

  $regArgs = @((Join-Path $RepoDir "scripts\register-hook.js"), "--settings", $Settings, "--node", $NodeBin, "--hook", $HookPath, "--home", $HomeRoot, "--surface", "claude")
  if ($WithPretool) { $regArgs += "--with-pretool" }

  & $NodeBin @regArgs --dry-run
  $proceed = $true
  if (-not $Yes) {
    $reply = Read-Host "`nApply this merge to $Settings? [y/N]"
    if ($reply -notin @("y","Y","yes","YES")) { Warn "Aborted at hook registration. Nothing was written."; $proceed = $false }
  }
  if ($proceed) {
    & $NodeBin @regArgs
    Ok "Hook merged (idempotent; unrelated settings untouched)."
    $HookRegistered = $true
  }
}

# --- 6. Smoke test ---------------------------------------------------------
Step "6/6  Smoke test"
$env:MYOS_HOME_ROOT = $HomeRoot
$smoke = '{"prompt":"test","hookEventName":"UserPromptSubmit"}' | & $NodeBin $HookPath --surface=claude
if ($smoke -match '"additionalContext"') {
  Ok "Hook emitted hookSpecificOutput.additionalContext"
} else {
  # Auto-revert: if we just wrote a hook, strip it so a failed install never
  # leaves a broken hook wired into settings.json.
  if ($HookRegistered) {
    Warn "Smoke test failed — auto-reverting the hook just added…"
    try {
      & $NodeBin (Join-Path $RepoDir "scripts\register-hook.js") --settings $Settings --remove
      Ok "Reverted the MyOS Dispatch hook (settings.json restored; a timestamped backup also remains)."
    } catch {
      Warn "Auto-revert reported an issue — inspect $Settings and its .bak-* backups."
    }
  }
  Die "Smoke test failed — hook did not emit additionalContext. Output: $smoke"
}

Step "MyOS Dispatch installed."
Write-Host @"

  Repo:        $RepoDir
  Data home:   $HomeRoot  (MYOS_HOME_ROOT)
  Index:       $IndexPath
  Claude hook: $(if ($NoHook) { 'not registered (-NoHook)' } else { $Settings })

  Next steps:
    - Restart Claude Code so it reloads settings.json.
    - Re-run with -IndexDir <your projects dir> to index your work.
    - Uninstall any time: powershell -File bin\install.ps1 -Uninstall

"@
