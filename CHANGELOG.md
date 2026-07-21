# Changelog

All notable changes to MyOS Dispatch are documented here.

## v3.3.0 — 2026-07-22

### Added

- **Optional shell-title hook (`--with-shell-title`).** Registers two new
  Claude Code hooks — `SessionStart` and `Stop` — via a new
  `bin/myos-title-hook` + `scripts/register-title-hook.js`, following the
  same safety contract as the existing dispatch-hook registration (never
  overwrites settings.json, idempotent by marker, backed up, atomic write,
  `--dry-run`/`--remove`). On session start the terminal tab renames to the
  current project (git repo root basename, or the bare cwd basename); after
  every turn it updates to `<name>: <recap>`, prefixed with the session's
  explicit `/rename` name if one was set, else the project name, followed by
  a short cleaned-up excerpt of Claude's last message. macOS/Linux only
  (zsh or bash, whichever `$SHELL` reports); the installer appends one
  marker-wrapped `source` line to `~/.zshrc`/`~/.bashrc` pointing at the new
  `shell/term-title-hook.{zsh,bash}`, and `--uninstall` reverses it the same
  way. The `/rename` lookup reads an empirically-observed, undocumented
  `custom-title` transcript record; on any lookup failure it falls back to
  the project name rather than erroring.

## v3.2.1 — 2026-07-21

### Fixed

- **Test runs no longer pollute live dispatch telemetry.**
  `appendDispatcherEvent` honors a new `MYOS_DISPATCHER_EVENTS_FILE`
  override, and the dispatcher test files pin it (plus the existing
  `MYOS_DISPATCH_HEALTH_STATE_FILE`) to temp paths. Previously a test run
  appended fixture events to the real `dispatcher-events.jsonl` and fed
  them into the dispatcher-health loop.

## v3.2.0 — 2026-07-21

### Added

- **Install-time model detection, local catalog, and task-class assignment.**
  A new step at the end of `install.sh` / `install.ps1` runs
  `scripts/setup-model-catalog.js`, which detects what you actually have
  (provider CLIs such as `codex`, `claude`, and `gemini`; API keys in your
  environment, recorded as booleans only, never values; local runtimes such
  as `ollama` and `mlx_whisper`), writes
  `<MYOS_HOME_ROOT>/config/model-catalog.local.json`, and makes a best-guess
  assignment of the eight canonical task classes to the cheapest suitable
  model you have, preferring signed-in CLIs over API keys.
- **Post-install report.** The installer explains in plain language what
  MyOS Dispatch is, lists the models it identified as available on the
  machine, shows the best-guess task-class assignments with a one-line
  reason each, and closes with an invitation to change any of them. The
  unified install prompt instructs the installing agent to present this
  report and apply requested changes to the `overrides` section.
- **Runtime honoring.** `resolveExecutionPlan()` consults the local catalog:
  `overrides` win outright, auto assignments are preferred ahead of the
  shipped policy, and invalid, unassigned, missing, or corrupt entries fall
  back silently to previous behavior. Re-running the setup script refreshes
  assignments without touching overrides.

### Notes

- Detection stores availability booleans only; no secret values are read
  into the catalog or printed.
- The privacy-trimmed install from v3.1.0 still works, including the new
  setup script, with `src/runtime`, `src/background`, and
  `bin/myos-sidecar.js` deleted.

## v3.1.0 — 2026-07-21

### Fixed

- **`MYOS_BACKGROUND_AGENTS_ENABLED=0` is now enforced in code.** Before this
  release the background-agent kill switch existed in the README and in plan
  metadata (`execution.disableEnv`) but no execution path ever read it: setting
  it to `0` changed nothing. It is now enforced at all three layers:
  - the parallelization planner emits zero background lanes
    (`mode: none`, reason `background_agents_disabled_by_env`,
    `execution.enabledByDefault: false`);
  - the dispatch hook's injected context replaces the fan-out mandate with an
    explicit instruction not to spawn background subagents;
  - the sidecar runner (`startBackgroundTasks` and `runBackgroundTask`)
    refuses to execute tasks regardless of what a caller passes in options.
  The runner's existing propagation of `=0` into sidecar child environments
  now actually blocks nested runs. Regression tests cover the planner and
  runner layers.

  Credit: found by a workshop participant's pre-install audit of `e4d94e4`,
  which correctly reported that the documented switch was not enforced
  anywhere in the code.

### Added

- **Privacy-trimmed install.** The hook's require chain no longer loads
  `src/background/` or `src/runtime/` (the shared env predicates moved to
  `src/env-context.js`). Installs handling confidential data can delete the
  optional capability code entirely and keep a fully working router:

  ```bash
  rm -rf src/runtime src/background bin/myos-sidecar.js
  ```

  This removes the remote-transcription (scp) path, the keychain reader, the
  LLM provider client, and the sidecar runner from disk. Documented in the
  README under Safety.

- `CHANGELOG.md` (this file).

### Changed

- README: the `MYOS_BACKGROUND_AGENTS_ENABLED` row now describes the
  enforced three-layer behavior, and the Safety section documents the
  privacy-trimmed install.

## v3.0.0 — 2026-07-15

- Initial public release, matching the live workspace dispatch generation.
  Routing hook in sync with live (paths genericized for distribution).
