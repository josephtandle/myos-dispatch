# MyOS Dispatch

**A standalone routing and execution core for agentic systems.** MyOS Dispatch
turns an operator request (a prompt or a shell command) into an *execution plan*
before any model work happens. It applies hard safety gates, gathers cheap typed
evidence, selects a capability and execution lane, plans safe parallel fan-out,
sets a goal scale, and resolves a model/runtime — provider-agnostically.

It ships as a **Claude Code (and Codex) hook**: on every prompt it injects a
compact routing brief so the agent starts each turn with a deliberate route
instead of guessing.

---

## How it decides (evaluation order)

Every request is resolved through the same ordered pass:

1. **Hard gates** — protected surfaces, browser preflight, auth, destructive
   actions, compliance lanes. These can stop or block a route outright.
2. **Typed evidence** — cheap hints from the capability index, project index,
   fastpaths, and configured data sources.
3. **Owner / context route** — which project, surface, and data domain the
   request belongs to.
4. **Execution lane** — a deterministic **recipe**, a reusable **workflow**, or
   an adaptive **worker/skill** lane for novel or compositional work.
5. **Parallelization pass** — fan out first: dispatch the maximum *safe*
   read-only background work at the start of the turn, then work the critical
   path while it runs. Breadth over depth.
6. **Goal scale** — infer the completion posture (from a one-shot answer up to
   durable, checkpointed multi-goal execution).
7. **Model / runtime** — resolve the lowest-cost model that can reliably finish
   each bounded subtask, only when the lane actually needs model work.

The hook emits this as `hookSpecificOutput.additionalContext` (full or compact),
so it works with any harness that supports `UserPromptSubmit` / `PreToolUse`
hooks.

## Key features

- **Capability routing** over a generated `capabilities-index.json`
  (recipes, skills, workflows, agents).
- **Parallelization planner** with staged, evidence-gated auto-promotion and a
  health/quarantine loop.
- **Goal-scale inference** for persistent, verify-and-retry execution.
- **Pluggable data sources** — add your own lookup files/DBs via a JSON config,
  no code changes.
- **Typed-evidence shadow routing** and **dispatcher-health** self-promotion
  state machines (all observe-only by default; see the `MYOS_*` toggles).
- **Setup previews** for Claude and Codex hooks, plus a read-only local model report.
- **Exact model management** with explicit add/select and catalog-only undo; see
  [models](docs/models.md).
- **Claude-to-Codex coauthoring** through `myos-writer`: one bounded interactive
  task, owned paths, an exact model, and a retained hash-pinned patch that requires
  independent review. See [coauthoring](docs/coauthoring.md). The writer requires
  macOS, Linux, or WSL; Windows-native writable execution is refused.
- **Provider-agnostic**: Claude, Codex, Gemini and others follow the same route.

---

## Prerequisites

- **Node.js >= 20** (required). The core has **no native build step**.
- Optional, all degrade gracefully if absent:
  - **ripgrep** (`rg`) — faster search lanes
  - **sqlite3** — for `sqlite`-mode data sources (`better-sqlite3` is an
    *optional* dependency; install with `--with-extras`)
  - **graphify** / **gitnexus** — optional per-repo code intelligence
  - an **agent CLI** (`claude` or `codex`) — required for that host integration or its workers

---

## Install

Get the source from [the canonical repository](https://github.com/josephtandle/myos-dispatch)
or its [latest release](https://github.com/josephtandle/myos-dispatch/releases/latest).
Keep it in a permanent directory: registered hooks use absolute paths. Do not run
the installer from a temporary download folder. Keep existing checkouts and their
local changes; use a separate directory when trying a release.

### macOS / Linux / WSL (Bash)

With Git and Node.js 20+ installed:

```sh
git clone https://github.com/josephtandle/myos-dispatch.git "$HOME/myos-dispatch"
cd "$HOME/myos-dispatch"
bash "bin/install.sh" --runtime codex
```

Review the printed hook merge before accepting; `--yes` explicitly accepts it
without the interactive prompt. The registrar uses `--dry-run` for this preview.

Choose `--runtime claude`, `--runtime codex`, or `--runtime both`. The default is
`claude` for compatibility. Restart the selected host. **In Codex, open `/hooks`,
review the Dispatch commands, and trust them before use.** Registration does not
establish host trust. Changed commands need review again. See the
[official hook documentation](https://learn.chatgpt.com/docs/hooks).

WSL uses Linux paths, Linux CLIs, and the WSL home directory. A Windows-native
installation has separate profiles and must use the PowerShell installer below.

Useful options:

| Bash flag | Effect |
| --- | --- |
| `--runtime claude\|codex\|both` | Register only the selected hosts. |
| `--yes` | Apply the previewed hook merge without a prompt. |
| `--index-dir "$HOME/code"` | Build a capability index from your projects. |
| `--with-pretool` | Add PreToolUse (Claude: Bash; Codex: all supported tools). Reinstalls retain it. |
| `--with-extras` | Install the optional SQLite native dependency. Core needs only Node built-ins. |
| `--with-graphify`, `--with-gitnexus` | Opt into optional code intelligence tools. |
| `--with-shell-title`, `--with-rabbit-hole` | Optional Claude integrations; require runtime claude or both. |
| `--no-hook` | Skip host registration. |
| `--uninstall` | Remove Dispatch registration for the selected runtime; retain backups and source. |

### Windows native (PowerShell)

```powershell
git clone https://github.com/josephtandle/myos-dispatch.git "$env:USERPROFILE\myos-dispatch"
Set-Location "$env:USERPROFILE\myos-dispatch"
& ".\bin\install.ps1" -Runtime codex
```

Use `-Runtime claude`, `codex`, or `both`. Optional project indexing uses
`-IndexDir "C:\path to your projects"`. Follow your organization's script execution
policy. This installer does not disable it. Windows execution has not been
verified by the macOS implementation run; a native Windows rehearsal is required.
The `myos-writer` command requires WSL on Windows; native hook registration does
not enable native writable workers.

### What gets registered and verified

Claude uses `~/.claude/settings.json`: UserPromptSubmit and optional PreToolUse,
plus the Dispatch child data-home setting. Codex uses `~/.codex/hooks.json`, or
`hooks.json` under your configured `CODEX_HOME`: SessionStart, UserPromptSubmit,
and optional PreToolUse. A Node wrapper sets the data home for the Codex hook
process; it does not add invented host configuration or edit `config.toml`.

The registrar validates JSON, merges only Dispatch entries by its stable marker,
preserves unrelated hooks/model/team settings, backs up changed files, and writes
atomically. Reinstalling the same registration does not rewrite it. A failed
installation restores prior hook-file bytes when they have not changed meanwhile;
concurrent changes cause rollback to refuse instead of overwriting them.

Installer output separates **direct binary smoke success**, **saved registration**,
and **unverified host execution/trust**. It does not authenticate you. If an older
Codex version has no `/hooks`, upgrade using its official installation guidance or
use direct invocation; automatic host integration is not established there:

```sh
printf '%s' '{"prompt":"hello","hook_event_name":"UserPromptSubmit"}' | node "bin/myos-dispatch-hook" --surface=codex
```

The final model report is read-only. A detected CLI is not proof of OAuth login.
Normal status commands (`codex login status`, `claude auth status --json`) establish
only the reported login method; errors and unsupported status interfaces stay
unknown. No model request is sent. See [model management](docs/models.md) for
explicit setup, exact model add/select, and catalog-only undo.

### Shell-title hook (optional)

`--with-shell-title` registers two more Claude Code hooks (`SessionStart`, `Stop`)
that keep your terminal tab title honest without you touching it:

- **On session start:** the tab renames to the current project (the git repo's
  root directory name, or the bare directory name outside a repo).
- **After every turn** (whenever Claude finishes responding): the tab updates to
  `<name>: <recap>` — `<name>` is the session's explicit name if you set one with
  `/rename`, else the project name; `<recap>` is a short, cleaned-up excerpt of
  Claude's own last message, so a row of open tabs tells you at a glance what
  each one just did.

This is macOS/Linux only, and only wired up for **zsh** or **bash** (whichever
`$SHELL` reports at install time) — there's no Windows terminal-title equivalent
here. The installer appends exactly one idempotent, marker-wrapped `source` line
to your `~/.zshrc` or `~/.bashrc` pointing at `shell/term-title-hook.zsh` or
`shell/term-title-hook.bash`; `--uninstall` strips it the same way it strips the
hook itself. Open a new terminal tab (or restart your shell) after installing —
an *already-running* shell has the old precmd function loaded in memory and
won't pick up the change until it's re-sourced or restarted.

The `/rename` lookup reads a `custom-title` record from the session's own
transcript file. That isn't an officially documented Claude Code field — it was
found empirically. If a future Claude Code release changes that internal
format, the hook doesn't error: it just falls back to the project name.

### Rabbit-hole self-check hook (optional)

Rabbit Hole (see the `rabbit-hole` Claude Code skill, if you use one like it) is
meant to be a lightweight focus/fatigue guard for long human-driven sessions —
but as advisory-only guidance, nothing ever forces the assistant to actually
pause and run that check. In practice, across a long session, it can simply
never come up.

`--with-rabbit-hole` registers a `UserPromptSubmit` hook
(`bin/myos-rabbithole-hook`) that fixes that gap deterministically, without
adding any new judgment of its own:

- **It never talks to you directly.** It only injects private
  `additionalContext` for the assistant's *next* turn — a reminder to go
  re-run its own self-check and apply its own existing thresholds. Whether
  anything actually gets said to you stays entirely the assistant's call,
  exactly as before.
- **Drift check:** fires at most once every `MYOS_RABBITHOLE_DRIFT_INTERVAL_MIN`
  (default 45) minutes of elapsed session time, with the same interval as a
  cooldown — so back-to-back messages can never trigger it twice.
- **Lateness check:** fires **once per session**, the first prompt that lands
  during the configured late-hour window (default 23:00–05:00, your machine's
  own local clock — nothing timezone-specific is hardcoded).
- Configurable via env vars: `MYOS_RABBITHOLE_DRIFT_INTERVAL_MIN`,
  `MYOS_RABBITHOLE_LATE_HOUR_START`, `MYOS_RABBITHOLE_LATE_HOUR_END`, or
  disable entirely with `MYOS_RABBITHOLE_DISABLE=1`.
- Per-session state lives at `<MYOS_HOME_ROOT>/state/rabbit-hole/<session_id>.json`;
  `--uninstall` removes it along with the hook registration.

### Uninstall

```sh
bash "bin/install.sh" --runtime both --uninstall  # macOS / Linux / WSL
```

Surgically removes the MyOS Dispatch hook and its `env` key, the shell-title
hooks + their `~/.zshrc`/`~/.bashrc` source line if present, and the
rabbit-hole hook + its session state if present — all **by marker** (leaving
every unrelated setting and any other hooks in place) — removes the generated
index, and leaves your timestamped `settings.json` and shell rc backups for a
full manual restore if you want one.

### One-liner (optional)

```sh
git clone https://github.com/josephtandle/myos-dispatch.git "myos-dispatch"
bash "myos-dispatch/bin/install.sh" --runtime codex --index-dir "$PWD"
```

---

## Configuration

### The single relocation variable: `MYOS_HOME_ROOT`

Everything Dispatch reads as operator config and writes as runtime state lives
under **`MYOS_HOME_ROOT`** (default `~/.myos-dispatch`). The router reads your
capability index from `$MYOS_HOME_ROOT/workspace/capabilities-index.json`. The
installer sets this key in Claude settings or in the Codex hook child environment
so the hook resolves the same root. Point it anywhere:

```sh
MYOS_HOME_ROOT="/path/to/dispatch-home" bash "bin/install.sh" --runtime codex --index-dir "$HOME/code"
```

Rebuild the index any time:

```sh
node scripts/generate-index.js --dir ~/code --out "$MYOS_HOME_ROOT/workspace/capabilities-index.json"
```

`generate-index.js` scans for `*.recipe.json`, `SKILL.md` frontmatter,
`*.workflow.json`, and `agent-registry.json`, and writes an index in the schema
the router expects. An empty or absent target yields a valid empty index — it
never fails.

### Pluggable data sources: `config/data-sources.json`

Add your own lookup files or read-only SQLite databases without touching code.
Copy `config/data-sources.example.json` to `config/data-sources.json` (or point
`MYOS_DATA_SOURCES_CONFIG` at your file) and add entries:

```json
{
  "version": 1,
  "dataSources": [
    {
      "id": "contacts",
      "label": "My contacts",
      "mode": "content",
      "base": "myos-home",
      "path": "data/contacts.md",
      "matchTerms": ["contact", "phone", "email of"],
      "maxChars": 3000
    }
  ]
}
```

- `mode`: `content` (read a text file), `sqlite` (read-only query), or `pointer`.
- `base`: `workspace`, `myos-home`, or `cwd`; or use an absolute `path`, or the
  `<workspace>/…` / `<myos-home>/…` placeholders.
- A source is selected only when the query matches its `matchTerms` and none of
  its `excludeTerms`. With an empty config nothing is selected, so routing is
  unaffected.

### `MYOS_*` toggles

Copy `.env.example` to your own local `.env`. Common toggles:

| Variable | Purpose |
|----------|---------|
| `MYOS_HOME_ROOT` | Root for config + runtime state (see above). |
| `MYOS_DISPATCH_HOOK_SURFACE` | `claude` / `codex` — labels the route. |
| `MYOS_DISPATCH_HOOK_CONTEXT` | `full` / `compact` / `none` route verbosity. |
| `MYOS_DATA_SOURCES_CONFIG` | Path to your data-sources JSON. |
| `MYOS_BACKGROUND_AGENTS_ENABLED` | `0` is the background kill switch: the planner emits no fan-out lanes, the hook tells the model not to spawn background subagents, and the sidecar runner refuses to execute tasks. |
| `MYOS_INTENT_FIDELITY_ENABLED` | `0` disables the interactive latest-intent, reversible-assumption, and execute-before-report contract. Hard gates are preserved whether this feature is enabled or disabled. |
| `MYOS_INTENT_HORIZON_ENABLED` | `0` disables the bounded post-verification upgrade sweep for actionable interactive Goal Scale 3 and 4 work. |
| `MYOS_PARALLELIZATION_VERSION` / `_AUTO_PROMOTE` | Pin / disable fan-out stage promotion. |
| `MYOS_DISPATCH_HEALTH_VERSION` / `_AUTO_PROMOTE` / `_AUTO_REPAIR` | Dispatcher-health self-promotion controls. |
| `MYOS_TYPED_EVIDENCE_SHADOW_VERSION` / `_AUTO_PROMOTE` | Typed-evidence shadow-routing controls. |

Keep real secrets in your local environment only; `.env.example` ships
placeholders.

> **Before you push this (or any) project to a git remote:** make sure `.env`
> is git-ignored so you never commit real secrets. This repo already ships a
> `.gitignore` that ignores `.env` and `.env.*` (while keeping `.env.example`).
> If you start your own repo from this setup, create a `.gitignore` containing
> `.env` **before your first `git add` / `git push`** — once a secret lands in
> git history, removing it requires a history rewrite and a force-push, and
> everyone with a clone has to re-clone.

---

## Smoke test

```sh
echo '{"prompt":"test","hookEventName":"UserPromptSubmit"}' \
  | node bin/myos-dispatch-hook --surface=claude
```

You should see JSON containing `hookSpecificOutput.additionalContext` with a
`[MyOS Dispatch route]` block. Run the test suite with:

```sh
npm test
```

---

## Safety

This installer is built to be safe on a machine that is not yours:

- **Idempotent** — re-running updates in place; no duplicate hook entries, no
  duplicated env keys or PATH lines.
- **Backs up before it touches shared config** — `settings.json` is copied to a
  timestamped `.bak-*` before any merge, and only the `hooks` object and one
  `env` key are changed. Your `model`, `theme`, permissions, and other hooks are
  preserved byte-for-byte.
- **Never global-installs into your runtimes** — node deps install into the
  repo's own `node_modules`; graphify uses `pipx` (or `pip --user`), never a
  global `pip`; gitnexus runs via ephemeral `npx`.
- **Scoped** — generated state is written only under `MYOS_HOME_ROOT`.
- **Reversible** — `--uninstall` strips the hook by a stable marker and removes
  the generated index, leaving unrelated settings and your backups intact.
- **Ships no operator data** — the capability index, fastpaths, and project
  routing are generated for *you*; only empty example schemas are in the repo.

### Privacy-trimmed install

The repo ships more than the router: `src/runtime/` can call LLM provider
APIs and read named keychain entries when *you* configure keys, and
`src/background/` plus `bin/myos-sidecar.js` implement the optional sidecar
runner. None of that is loaded or executed by the installed hook, and
`MYOS_BACKGROUND_AGENTS_ENABLED=0` hard-disables background fan-out at the
planner, hook, and runner layers. If "off by default" is not a strong enough
promise for your machine (confidential client data, regulated work), delete
the capability code entirely — the router does not need it:

```bash
rm -rf src/runtime src/background bin/myos-sidecar.js
```

The hook, routing, capability index, and fastpaths all keep working. Verify
with the smoke test above.

---

## License

See [LICENSE](./LICENSE).
