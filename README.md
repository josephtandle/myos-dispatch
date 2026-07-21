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
- **Provider-agnostic**: Claude, Codex, Gemini and others follow the same route.

---

## Prerequisites

- **Node.js >= 20** (required). The core has **no native build step**.
- Optional, all degrade gracefully if absent:
  - **ripgrep** (`rg`) — faster search lanes
  - **sqlite3** — for `sqlite`-mode data sources (`better-sqlite3` is an
    *optional* dependency; install with `--with-extras`)
  - **graphify** / **gitnexus** — optional per-repo code intelligence
  - an **agent CLI** (`claude` or `codex`) — only needed for background workers

---

## Install

### macOS / Linux

```sh
bash bin/install.sh                       # interactive (prompts before touching settings.json)
bash bin/install.sh --yes                 # non-interactive
bash bin/install.sh --index-dir ~/code    # scan your projects to build a useful index
```

Useful flags:

| Flag | Effect |
|------|--------|
| `--yes` | Skip the confirm before writing `settings.json`. |
| `--index-dir <path>` | Scan a directory for recipes/skills/workflows to build **your** index. |
| `--with-pretool` | Also register a `PreToolUse(Bash)` hook (default: `UserPromptSubmit` only). |
| `--with-extras` | Build optional deps too (`better-sqlite3` native build). |
| `--with-graphify` | Install optional graphify (`pipx` preferred, never global `pip`). |
| `--with-gitnexus` | Verify optional gitnexus via `npx` (ephemeral, no global install). |
| `--no-hook` | Install everything except the `settings.json` hook. |
| `--uninstall` | Reverse the install. |

### Windows (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File bin\install.ps1 -Yes -IndexDir C:\Users\me\code
powershell -ExecutionPolicy Bypass -File bin\install.ps1 -Uninstall
```

Same behavior as the shell installer (backup + JSON-merge + idempotent);
Mac-only bits (launchd, mlx, bash wrappers) are skipped.

### What the installer does to `settings.json`

It **never overwrites** `~/.claude/settings.json`. It:

1. **Backs it up** first to `settings.json.bak-<timestamp>`.
2. Reads the existing JSON and **merges** a single `UserPromptSubmit` hook entry
   (using the resolved absolute `node` path and the absolute hook path), plus one
   `env.MYOS_HOME_ROOT` key — using **node**, not `jq`, for portability.
3. Is **idempotent**: re-running strips any prior MyOS Dispatch entry (matched by
   a stable marker) before re-adding, so it never duplicates and never touches
   your `model`, `theme`, permissions, or other hooks.
4. **Prints the planned merge and asks for confirmation** unless you pass
   `--yes`.

### Uninstall

```sh
bash bin/install.sh --uninstall           # macOS / Linux
```

Surgically removes the MyOS Dispatch hook and its `env` key **by marker**
(leaving every unrelated setting and any other hooks in place), removes the
generated index, and leaves your timestamped `settings.json` backups for a full
manual restore if you want one.

### One-liner (optional)

```sh
git clone https://github.com/<you>/myos-dispatch && bash myos-dispatch/bin/install.sh --index-dir "$PWD"
```

---

## Configuration

### The single relocation variable: `MYOS_HOME_ROOT`

Everything Dispatch reads as operator config and writes as runtime state lives
under **`MYOS_HOME_ROOT`** (default `~/.myos-dispatch`). The router reads your
capability index from `$MYOS_HOME_ROOT/workspace/capabilities-index.json`. The
installer sets this key in `settings.json` so the hook always resolves the same
root. Point it anywhere:

```sh
MYOS_HOME_ROOT=/path/to/dispatch-home bash bin/install.sh --index-dir ~/code
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
| `MYOS_PARALLELIZATION_VERSION` / `_AUTO_PROMOTE` | Pin / disable fan-out stage promotion. |
| `MYOS_DISPATCH_HEALTH_VERSION` / `_AUTO_PROMOTE` / `_AUTO_REPAIR` | Dispatcher-health self-promotion controls. |
| `MYOS_TYPED_EVIDENCE_SHADOW_VERSION` / `_AUTO_PROMOTE` | Typed-evidence shadow-routing controls. |

Keep real secrets in your local environment only; `.env.example` ships
placeholders.

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

---

## License

See [LICENSE](./LICENSE).
