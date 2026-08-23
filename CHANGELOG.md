# Changelog

All notable changes to MyOS Dispatch are documented here.

## Unreleased

### Added

- **Intent Horizon:** actionable interactive Goal Scale 3 and 4 routes now carry a provider-neutral, machine-bounded completion contract. After the requested outcome verifies, Claude Code and Codex run one exploratory sweep, score a finite candidate set, and implement the strongest safe upgrades within ownership, reversibility, authority, causal-depth, and binary-verification gates. The contract has a kill switch, explicit budgets and stop reasons, route-log evidence, and health classifications for diagnosis-only completion, skipped qualified upgrades, and exhaustion.

## v3.6.0 - 2026-08-23

### Added

- **Capability adoption telemetry.** Every task-dispatcher outcome now persists the compact branch, lane, and capability ID supplied by its precomputed Dispatch plan in `outcome.dispatchPlan`. Direct callers without a precomputed plan remain explicitly unattributed. This closes the gap between capability selection and the append-only event ledger, so downstream usefulness loops can measure actual adoption without changing route scoring, health classification, quarantine, or promotion behavior.

## v3.5.3 - 2026-08-22

### Added

- **FastPath hit telemetry.** Hook route records include the matched FastPath IDs needed by the lifecycle loop.
- **Goal policy single source of truth.** Goal-scale defaults load from the canonical policy file instead of drifting across callers.

### Fixed

- **Route-context deduplication.** Repeated hook context is emitted once per turn and suppressed when the block is unchanged.

## v3.5.2 - 2026-08-21

### Fixed

- **Background provider mismatch (reported by Nicola Harvey).** The fan-out availability gate checked one command while the sidecar spawned another: on a Claude Code surface the gate ran `which claude` and the sidecar defaulted to `codex`, so a machine with `claude` and no `codex` passed the gate and every lane failed with `spawn codex ENOENT`. Both now use one resolver that returns the first installed provider (`codex`, `claude`, `antigravity`, `gemini`), and the hook passes it to the sidecar explicitly. With no provider installed, lanes are advised only, as before background execution existed.

### Added

- **`docs/BACKGROUND-WORKERS.md`** documenting what background scouts run on, the preference order, how to pin a provider, how to disable fan-out, and that scouts are read-only and capped.

## v3.5.1 - 2026-08-20

### Fixed

- **Sidecar summaries are sanitized.** The first live auto-fanout run injected worker terminal escape sequences into a prompt as lane findings. OSC/CSI sequences and control bytes are stripped, with a `result ready (see file)` fallback when nothing legible remains.
- **`GITNEXUS_VERSION` pins the gitnexus check.** The installer verified an unpinned `npx gitnexus` while the All Sorted lockfile pins a version.

## v3.5.0 - 2026-08-20

### Added

- **Fan-out now executes.** For Goal Scale 3+ routes, up to three read-only lanes are spawned in the background through `bin/myos-sidecar.js` at prompt time; their results are injected into the next prompt's route context with one-line summaries. Previously every lane was advisory text: 5,243 routes had advised 22,572 lanes with zero executed. Safety: read-only lanes only, six per session-hour, `MYOS_AUTO_FANOUT=0` opts out, `MYOS_BACKGROUND_AGENTS_ENABLED=0` still disables everything, and any failure degrades silently to the previous advice-only behaviour.
- **Compliance measurement.** Each route records how many lanes were auto-dispatched and how many Agent tool calls the transcript actually shows, so advised-versus-executed is continuously logged.

## v3.4.3 - 2026-08-20

### Fixed

- **Trivial-goal fanout clamp:** Goal Scale 1 and 2 no longer emit a sidecar fanout plan. The parallelization plan was built before the goal scale was resolved, so a status question such as "is everything ok" still produced five read-only lanes. Scales 3 and 4 are unchanged, and an explicit `MYOS_PARALLELIZATION_AGGRESSION` override still wins.
- **Fresh-clone test fixture:** `register-hook`'s durable-settings fixture was created under `__dirname`, which is ephemeral when the repository itself is cloned into a temp path. Two guard tests failed from such a clone while passing from a home checkout.

## v3.4.2 - 2026-08-20

### Fixed

- **RTK grep rewrite safety:** Reject the `grep` -> `rtk grep` rewrite when grep reads stdin or sits in a pipeline. The rewrite is only applied when a real path operand exists, with correct handling of option-taking flags, quoted operands, and the `--` terminator.

## v3.4.1 - 2026-08-16

### Fixed

- **External Git repository routing:** Propagate index `scan_dir` through candidates and resolve relative `source_path` against it.
- **YAML block scalar parsing:** Parse exact YAML block scalars `|` (literal) and `>` (folded) with CRLF, common indentation, folding, and paragraph breaks.
- **Goal Scale 4 fan-out posture:** Do not let planner-generated fanout independently promote simple actionable work to Goal Scale 4; replay "draft a bug report" as Scale 3 and "is everything ok" at most Scale 2.
- **Alumni project capture:** Suppress generic single-word alumni project capture while preserving explicit Alumni Circle matches.

## v3.4.0 — 2026-07-22

### Added

- **Optional rabbit-hole self-check hook (`--with-rabbit-hole`).** Registers
  a new `UserPromptSubmit` hook (`bin/myos-rabbithole-hook` +
  `scripts/register-rabbithole-hook.js`, same safety contract as the other
  two hook registrars — idempotent by marker, backed up, atomic write,
  `--dry-run`/`--remove`) that closes a real gap: Rabbit Hole-style focus/
  fatigue guidance is advisory-only, so nothing was ever forcing the
  assistant to actually pause and run that self-check during a long
  session — in practice it can simply never come up. The hook never
  messages the user directly; it only injects private `additionalContext`
  reminding the assistant to re-run its own judgment, on two independent,
  cheap, deterministic cooldowns: a drift check (at most once per
  `MYOS_RABBITHOLE_DRIFT_INTERVAL_MIN`, default 45 minutes) and a lateness
  check (once per session, first prompt inside the configured late-hour
  window, default 23:00–05:00 local system time). Coexists cleanly with the
  dispatch hook on the same `UserPromptSubmit` event. Disable with
  `MYOS_RABBITHOLE_DISABLE=1`.

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
