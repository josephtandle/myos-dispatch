# Changelog

All notable changes to MyOS Dispatch are documented here.

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
