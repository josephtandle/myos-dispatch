# Jev calibrated decisions

The hook resolves the existing dispatch plan first. UserPromptSubmit and the plain-text `--render-route` path then submit one bounded prompt pack through the shared Jev step. Bash PreToolUse submits a tool pack after computing existing safety labels. Other tools and events retain their existing paths. Direct synchronous hook imports remain compatible; the CLI owns the asynchronous step.

The optional model is `jev-1.13.0`. Prompt requests default to a 1500 ms total timeout; tool requests default to 900 ms. The hook does not retry. Both hook budgets clamp to 200 through 2500 ms. The client bounds all attempts and backoff by its total timeout. Invalid answers, timeouts, unavailable credentials, transport failures, and unexpected attachment errors preserve the legacy plan. Tool authority can add safety labels and cannot remove existing labels. Observation write failures cannot block dispatch.

## Stages and fields

`shadow` records comparisons without changing decisions. `canary` is reserved; no fields today. `authoritative` is effective only for additive `safety.*` and `blockedBy.*` fields explicitly listed in the config file's `authoritativeFields`. All other fields, including goal confidence and fanout aggression, remain shadow-only. Promotion eligibility is reported, never automatically granted by the evaluator.

Prompt fields are intent type, action type, goal scale, correction detection, fanout aggression, and the six blockers: browser control, user-visible send, payment/account mutation, auth sensitive, interactive auth, and destructive/approval sensitive. Capability lane and project are included when a shortlist exists. Prompt injection is diagnostic only. Goal confidence is derived from the score answer.

Tool fields cover those six blockers plus protected-surface write, approval-sensitive operation, and read-only status. Description-match and needs-human answers are diagnostic only. All mapped fields default to a 0.9 confidence floor, including derived goal confidence. State `floors` can override individual fields. Noul decisions use 0.5 as their boolean threshold and the larger of p and 1-p as confidence. Score answers are finite zero-based floats in [0, 3]; goal scale is `Math.round(score) + 1`.

Blocker and safety authority only adds positive gates in the authoritative stage. Top-level prompt comparisons remain available in the ledger for grading but cannot override the planner.

## Configuration and observations

- `TYPESAFE_API_KEY`: optional TypeSafe credential, resolved by the existing client from the environment or workspace env file.
- `MYOS_JEV_ENABLED=0`: bypasses Jev and preserves legacy behavior; prompt context adds only `[Jev] skipped: disabled`. The hidden `--no-jev` hook flag does the same.
- `MYOS_JEV_STAGE`: `shadow`, `canary`, or `authoritative`, overriding the saved stage. Invalid values fall back to shadow.
- `MYOS_JEV_TIMEOUT_MS`: prompt total timeout, default 1500 ms, clamped to [200, 2500].
- `MYOS_JEV_TOOL_TIMEOUT_MS`: tool total timeout, default 900 ms, clamped to [200, 2500].
- `MYOS_JEV_HOOK_METRICS=1`: opt into best-effort atomic metrics writes; default off.
- `MYOS_JEV_LOG_TEXT=1`: explicitly opts into prompt/command text in the shadow ledger. Text is omitted by default.
- `MYOS_HOME_ROOT`: observation root, defaulting to `~/.myos-dispatch` for Jev observations.

The ledger is `<root>/logs/jev-shadow.jsonl`. Above 50 MB it rotates by atomic rename to `jev-shadow.<YYYYMMDD-HHMMSS>.jsonl` before append. Config `{stage, authoritativeFields, floors, promotionNote}` is read-only at `<root>/state/jev-shadow-state.json`. An unreadable config forces shadow for that event, records `configUnreadable`, and is never rewritten. Optional metrics live at `<root>/state/jev-shadow-metrics.json` and use same-directory temporary files plus atomic rename. Invalid metrics are not rewritten that event. Legacy config metrics supply the initial metrics until a separate file exists. Concurrent metric updates can be lost; the evaluator derives calibration and eligibility from model ledger rows across active and rotated files. Ledger entries contain hashes, lengths, incumbent values, typed answers, stage, engine, latency, tokens, and model. Opt-in hook metrics accumulate only real Jev answers, never rules self-agreement. Reliability bins measure agreement with the incumbent, not correctness against ground truth.

Model prompt, command, and description text is redacted for common credentials before pack construction. Shadow tool checks flush legacy labels immediately, finish observation work within the tool budget, then exit explicitly. Authoritative tool checks await the result before output.

The existing hook route log adds a compact `jev` summary with stage, engine, skipped reason, agreement counts, latency, input tokens, and model; it contains no answer payload or text. Prompt records also include intent/action, goal scale/mode/confidence, fanout aggression/depth, plan/approval flags, and blockers for every install.

Prompt route context has one Jev status line after the Intent Fidelity/Horizon lines. A skipped decision shows its reason code. Tool safety context adds `jev=k/n` only for a completed model decision; skipped tool checks add nothing and ordinary reads stay silent.

## Evaluation and smoke checks

`npm run evaluate-jev -- --json` reports the default ledger directory, including rotations. `--ledger` accepts a file, directory, or quoted glob with `*` and `?`. Options:

```
node scripts/evaluate-jev-shadow.js --ledger /tmp/ledger.jsonl --field goalScale
node scripts/evaluate-jev-shadow.js --prompt-corpus test/fixtures/jev-prompt-corpus-fixture.jsonl --tool-corpus test/fixtures/jev-tool-safety-fixture.json --json
node scripts/evaluate-jev-shadow.js --prompt-corpus /tmp/corpus.jsonl --live --limit 20
```

Prompt rows contain `prompt`, `incumbent`, and optional `truth`. Tool rows contain `command`, `description`, `truth_labels`, and optional `incumbent_labels`. JSONL is supported for both; a JSON array is also accepted for the synthetic tool fixture. Commands are classified, never executed. Offline mode runs the legacy planner and rules engine. Live mode additionally invokes Jev. Corpus observations use a disposable temporary directory and do not contaminate production promotion metrics.

Reports include per-field agreement, available truth accuracy, per-label precision/recall/F1, reliability bins, and eligible fields. Eligibility requires at least 200 samples, 90% agreement, and weighted calibration error at most 0.1. `--field` filters reported fields, `--limit` bounds rows per input, and `--json` emits one object. Reports exit zero; `--strict` exits one when a reported engine regresses against an available incumbent on matched truth examples. Input errors are reported without treating the report as a gate.

`node scripts/jev-smoke.js` sends exactly one live request per pack, without retries, and prints latency, model, usage, request ID, and answer fields. It exits two with a one-line reason when unavailable. It is intentionally outside `npm test`.

## All Sorted installs

Installs without a key use the rules engine and retain pre-Jev routing behavior. They are never prompted to configure it. Only `myos-oauth-doctor status` gives optional setup guidance; per-prompt diagnostics use the required machine reason code `[Jev] skipped: typesafe_key_missing` without a setup nag.
