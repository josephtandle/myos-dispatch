#!/usr/bin/env bash
#
# MyOS Dispatch installer (macOS / Linux)
#
# SAFE BY DESIGN:
#   - Never overwrites your ~/.claude/settings.json. It backs it up first,
#     then JSON-MERGES a single hook entry with node (idempotent).
#   - Never global-pips or clobbers your language runtimes.
#   - Scoped: writes generated state only under $MYOS_HOME_ROOT.
#   - Reversible: `--uninstall` strips the hook, removes generated state,
#     and leaves your timestamped backups in place.
#
# Usage:
#   bash bin/install.sh [options]
#
# Options:
#   --yes                 Non-interactive; skip the confirm before writing settings.
#   --with-pretool        Also register a PreToolUse(Bash) hook (default: UserPromptSubmit only).
#   --with-extras         Build optional deps too (better-sqlite3 native build).
#   --with-graphify       Install the optional graphify code-intel tool (pipx preferred).
#   --with-gitnexus       Verify the optional gitnexus code-intel tool (npx, no global install).
#   --index-dir <path>    Directory to scan for the new user's projects (recipes/skills/workflows).
#   --no-hook             Skip Claude settings.json hook registration entirely.
#   --uninstall           Reverse the install.
#   -h, --help            Show this help.
#
# Environment overrides:
#   MYOS_DISPATCH_DIR     Install/repo dir (default: the dir this script lives in).
#   MYOS_HOME_ROOT        Where Dispatch reads config and writes state
#                         (default: $HOME/.myos-dispatch).

set -euo pipefail

# --------------------------------------------------------------------------
# Resolve paths
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${MYOS_DISPATCH_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
HOME_ROOT="${MYOS_HOME_ROOT:-$HOME/.myos-dispatch}"
WORKSPACE_DIR="$HOME_ROOT/workspace"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
HOOK_PATH="$REPO_DIR/bin/myos-dispatch-hook"
INDEX_PATH="$WORKSPACE_DIR/capabilities-index.json"

# --------------------------------------------------------------------------
# Flags
# --------------------------------------------------------------------------
ASSUME_YES=0
WITH_PRETOOL=0
WITH_EXTRAS=0
WITH_GRAPHIFY=0
WITH_GITNEXUS=0
NO_HOOK=0
DO_UNINSTALL=0
INDEX_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=1 ;;
    --with-pretool) WITH_PRETOOL=1 ;;
    --with-extras) WITH_EXTRAS=1 ;;
    --with-graphify) WITH_GRAPHIFY=1 ;;
    --with-gitnexus) WITH_GITNEXUS=1 ;;
    --no-hook) NO_HOOK=1 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    --index-dir) INDEX_DIR="${2:-}"; shift ;;
    --index-dir=*) INDEX_DIR="${1#--index-dir=}" ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'Unknown option: %s (try --help)\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

# --------------------------------------------------------------------------
# Pretty output
# --------------------------------------------------------------------------
info()  { printf '  \033[36m•\033[0m %s\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

resolve_node() { command -v node 2>/dev/null || true; }

# --------------------------------------------------------------------------
# Uninstall
# --------------------------------------------------------------------------
uninstall() {
  step "Uninstalling MyOS Dispatch"
  local node_bin; node_bin="$(resolve_node)"
  if [ -n "$node_bin" ] && [ -f "$SETTINGS" ]; then
    "$node_bin" "$REPO_DIR/scripts/register-hook.js" --settings "$SETTINGS" --remove || warn "hook removal reported an issue"
    ok "Stripped MyOS Dispatch hook + env key from $SETTINGS"
    local latest_bak
    latest_bak="$(ls -1t "$SETTINGS".bak-* 2>/dev/null | head -n1 || true)"
    [ -n "$latest_bak" ] && info "A timestamped backup remains for full restore: $latest_bak"
  else
    info "No node or no settings.json; nothing to strip."
  fi
  if [ -f "$INDEX_PATH" ]; then
    rm -f "$INDEX_PATH"
    ok "Removed generated index $INDEX_PATH"
  fi
  info "Repo dir ($REPO_DIR) and node_modules were left in place. Remove manually if desired."
  step "Uninstall complete."
  exit 0
}

[ "$DO_UNINSTALL" -eq 1 ] && uninstall

# --------------------------------------------------------------------------
# 1. Preflight
# --------------------------------------------------------------------------
step "1/6  Preflight checks"

NODE_BIN="$(resolve_node)"
[ -n "$NODE_BIN" ] || fail "Node.js >= 20 is required but not found. Install via nvm (https://github.com/nvm-sh/nvm) or 'brew install node'."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js >= 20 required (found $("$NODE_BIN" -v)). Upgrade via nvm or brew."
fi
ok "node $("$NODE_BIN" -v) ($NODE_BIN)"

command -v npm >/dev/null 2>&1 || fail "npm is required but not found."
ok "npm $(npm -v)"
command -v git >/dev/null 2>&1 || warn "git not found — fine for local installs, needed only for updates."

# Optional tooling (warn, never fail)
command -v python3 >/dev/null 2>&1 && ok "python3 $(python3 --version 2>&1 | awk '{print $2}') (optional)" || warn "python3 not found (optional; needed only for --with-graphify)"
command -v pipx    >/dev/null 2>&1 && ok "pipx present (optional, preferred for graphify)" || info "pipx not found (optional)"
command -v rg      >/dev/null 2>&1 && ok "ripgrep present (optional, speeds up search lanes)" || info "ripgrep not found (optional)"
command -v sqlite3 >/dev/null 2>&1 && ok "sqlite3 present (optional, for sqlite data sources)" || info "sqlite3 not found (optional)"
if command -v claude >/dev/null 2>&1; then ok "claude CLI present (optional, for background workers)";
elif command -v codex >/dev/null 2>&1; then ok "codex CLI present (optional, for background workers)";
else info "no agent CLI (claude/codex) found (optional)"; fi

[ -f "$HOOK_PATH" ] || fail "Hook not found at $HOOK_PATH — run this from inside the myos-dispatch repo."

# --------------------------------------------------------------------------
# 2. Install node dependencies (scoped to repo)
# --------------------------------------------------------------------------
step "2/6  Installing node dependencies (scoped to repo, never global)"
cd "$REPO_DIR"
if [ "$WITH_EXTRAS" -eq 1 ]; then
  info "Building optional deps too (better-sqlite3 native build)…"
  npm install
else
  npm install --omit=optional
fi
ok "Dependencies installed under $REPO_DIR/node_modules"

# --------------------------------------------------------------------------
# 3. Optional component bootstrap (opt-in, degrade gracefully)
# --------------------------------------------------------------------------
step "3/6  Optional components"
if [ "$WITH_GRAPHIFY" -eq 1 ]; then
  if command -v pipx >/dev/null 2>&1; then
    pipx install graphifyy >/dev/null 2>&1 && ok "graphify installed via pipx" || warn "pipx install graphifyy failed; skipping (optional)"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m pip install --user graphifyy >/dev/null 2>&1 && ok "graphify installed via pip --user" || warn "pip --user install failed; skipping (optional)"
  else
    warn "Neither pipx nor python3 found; skipping graphify (optional)."
  fi
else
  info "graphify: skipped (pass --with-graphify to enable optional code-intel)"
fi

if [ "$WITH_GITNEXUS" -eq 1 ]; then
  if command -v npx >/dev/null 2>&1; then
    if npx --yes gitnexus --version >/dev/null 2>&1; then ok "gitnexus reachable via npx (ephemeral, no global install)";
    else warn "npx gitnexus --version did not succeed; it will still be fetched on first use (optional)."; fi
  else
    warn "npx not found; skipping gitnexus check (optional)."
  fi
else
  info "gitnexus: skipped (pass --with-gitnexus to verify optional code-intel)"
fi

# --------------------------------------------------------------------------
# 4. Build the NEW USER's capability index (never ship anyone else's)
# --------------------------------------------------------------------------
step "4/6  Building your capability index"
mkdir -p "$WORKSPACE_DIR"
GEN_ARGS=(--out "$INDEX_PATH")
if [ -n "$INDEX_DIR" ]; then
  [ -d "$INDEX_DIR" ] || fail "--index-dir '$INDEX_DIR' is not a directory."
  GEN_ARGS+=(--dir "$INDEX_DIR")
  info "Scanning $INDEX_DIR for recipes / skills / workflows…"
else
  info "No --index-dir given; scaffolding an empty (but valid) index."
  GEN_ARGS+=(--dir "$WORKSPACE_DIR")
fi
MYOS_HOME_ROOT="$HOME_ROOT" "$NODE_BIN" "$REPO_DIR/scripts/generate-index.js" "${GEN_ARGS[@]}"
ok "Index written to $INDEX_PATH"

# --------------------------------------------------------------------------
# 5. Register the Claude Code hook (the careful part)
# --------------------------------------------------------------------------
step "5/6  Registering the Claude Code dispatch hook"
if [ "$NO_HOOK" -eq 1 ]; then
  info "--no-hook set; skipping settings.json registration."
else
  mkdir -p "$CLAUDE_DIR"
  # register-hook.js backs up (timestamped) before every write — add and remove —
  # so no separate backup step is needed here.
  if [ ! -f "$SETTINGS" ]; then
    info "No existing settings.json; a minimal one will be created."
  fi

  REG_ARGS=(--settings "$SETTINGS" --node "$NODE_BIN" --hook "$HOOK_PATH" --home "$HOME_ROOT" --surface claude)
  [ "$WITH_PRETOOL" -eq 1 ] && REG_ARGS+=(--with-pretool)

  # Show the planned merge and confirm (unless --yes).
  "$NODE_BIN" "$REPO_DIR/scripts/register-hook.js" "${REG_ARGS[@]}" --dry-run
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf '\nApply this merge to %s? [y/N] ' "$SETTINGS"
    reply=""
    if [ -r /dev/tty ]; then read -r reply </dev/tty || true; else read -r reply || true; fi
    case "$reply" in
      y|Y|yes|YES) ;;
      *) warn "Aborted at hook registration. Nothing was written to settings.json."; NO_HOOK=1 ;;
    esac
  fi
  if [ "$NO_HOOK" -ne 1 ]; then
    "$NODE_BIN" "$REPO_DIR/scripts/register-hook.js" "${REG_ARGS[@]}"
    ok "Hook merged (idempotent; unrelated settings untouched)."
  fi
fi

# --------------------------------------------------------------------------
# 6. Smoke test
# --------------------------------------------------------------------------
step "6/6  Smoke test"
SMOKE_OUT="$(printf '%s' '{"prompt":"test","hookEventName":"UserPromptSubmit"}' | MYOS_HOME_ROOT="$HOME_ROOT" "$NODE_BIN" "$HOOK_PATH" --surface=claude 2>/dev/null || true)"
if printf '%s' "$SMOKE_OUT" | grep -q '"additionalContext"'; then
  ok "Hook emitted hookSpecificOutput.additionalContext"
else
  # Auto-revert: if we just wrote a hook, strip it so a failed install never
  # leaves a broken hook wired into settings.json.
  if [ "$NO_HOOK" -ne 1 ]; then
    warn "Smoke test failed — auto-reverting the hook just added…"
    if "$NODE_BIN" "$REPO_DIR/scripts/register-hook.js" --settings "$SETTINGS" --remove; then
      ok "Reverted the MyOS Dispatch hook (settings.json restored; a timestamped backup also remains)."
    else
      warn "Auto-revert reported an issue — inspect $SETTINGS and its .bak-* backups."
    fi
  fi
  fail "Smoke test failed — hook did not emit additionalContext. Output was: $SMOKE_OUT"
fi

step "MyOS Dispatch installed."
cat <<EOF

  Repo:        $REPO_DIR
  Data home:   $HOME_ROOT  (MYOS_HOME_ROOT)
  Index:       $INDEX_PATH
  Claude hook: $([ "$NO_HOOK" -eq 1 ] && echo 'not registered (--no-hook)' || echo "$SETTINGS")

  Next steps:
    • Restart Claude Code so it reloads settings.json.
    • Re-run this installer with --index-dir <your projects dir> to index your work.
    • Uninstall any time: bash bin/install.sh --uninstall

EOF
