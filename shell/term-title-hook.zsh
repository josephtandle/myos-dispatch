# MyOS Dispatch — terminal tab title precmd integration (zsh).
#
# Re-asserts the title bin/myos-title-hook last wrote for this tty, on every
# interactive prompt. This is what makes a title set by a Claude Code hook
# SURVIVE past that one write — without this, the shell's own prompt
# rendering (or another program) can otherwise clobber it before you
# notice. Installed by bin/install.sh --with-shell-title, which appends a
# single `source` line for this file to your ~/.zshrc.
#
# Safe to source multiple times; safe if MyOS Dispatch was never installed
# (falls through to a no-op).

_myos_dispatch_term_title() {
  local home_root="${MYOS_HOME_ROOT:-$HOME/.myos-dispatch}"
  local tty="${TTY#/dev/}" title_file title
  [[ -n "$tty" ]] || return 0
  title_file="$home_root/state/term-title/$tty"
  [[ -s "$title_file" ]] || return 0
  title="$(<"$title_file")"
  [[ -n "$title" ]] || return 0
  printf '\033]0;%s\007' "$title"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _myos_dispatch_term_title
