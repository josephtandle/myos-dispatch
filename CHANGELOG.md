# Changelog

All notable changes to MyOS Dispatch are documented here.

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
