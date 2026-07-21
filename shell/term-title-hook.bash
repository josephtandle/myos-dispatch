# MyOS Dispatch — terminal tab title precmd integration (bash).
#
# Bash equivalent of shell/term-title-hook.zsh: re-asserts the title
# bin/myos-title-hook last wrote for this tty, on every interactive prompt,
# via PROMPT_COMMAND. Installed by bin/install.sh --with-shell-title, which
# appends a single `source` line for this file to your ~/.bashrc.
#
# Safe to source multiple times: guards against appending itself to
# PROMPT_COMMAND more than once.

_myos_dispatch_term_title() {
  local home_root="${MYOS_HOME_ROOT:-$HOME/.myos-dispatch}"
  local tty title_file title
  tty="$(basename "$(tty 2>/dev/null)" 2>/dev/null)"
  [ -n "$tty" ] || return 0
  title_file="$home_root/state/term-title/$tty"
  [ -s "$title_file" ] || return 0
  title="$(cat "$title_file")"
  [ -n "$title" ] || return 0
  printf '\033]0;%s\007' "$title"
}

case "$PROMPT_COMMAND" in
  *_myos_dispatch_term_title*) ;;
  "") PROMPT_COMMAND="_myos_dispatch_term_title" ;;
  *) PROMPT_COMMAND="${PROMPT_COMMAND%;}; _myos_dispatch_term_title" ;;
esac
