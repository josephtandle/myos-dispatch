# Jev calibrated decisions

The hook resolves the existing dispatch plan first. UserPromptSubmit and the plain-text `--render-route` path then submit one bounded prompt pack through the shared Jev step. Bash PreToolUse submits a tool pack after computing existing safety labels. Other tools and events retain their existing paths. Direct synchronous hook imports remain compatible; the CLI owns the asynchronous step.

The optional model is `jev-1.13.0`. Requests default to a 1500 ms attempt timeout and one retry, bounded by the client's overall deadline. Invalid answers, timeouts, unavailable credentials, transport failures, and unexpected attachment errors preserve the legacy plan. Tool authority can add safety labels and cannot remove existing labels. Observation write failures cannot block dispatch.

## Stages and fields

`shadow` records comparisons without changing decisions. `canary` can change only goal confidence and fanout aggression above their confidence floors. `authoritative` additionally requires each field to be listed in the state file's `authoritativeFields`. Promotion eligibility is reported, never automatically granted by the evaluator.

Prompt fields are intent type, action type, goal scale, correction detection, fanout aggression, and the six blockers: browser control, user-visible send, payment/account mutation, auth sensitive, interactive auth, and destructive/approval sensitive. Capability lane and project are included when a shortlist exists. Prompt injection is diagnostic only. Goal confidence is derived from the score answer.

Tool fields cover those six blockers plus protected-surface write, approval-sensitive operation, and read-only status. Description-match and needs-human answers are diagnostic only. All mapped fields default to a 0.9 confidence floor, including derived goal confidence. State `floors` can override individual fields. Noul decisions use 0.5 as their boolean threshold and the larger of p and 1-p as confidence. Score answers are finite zero-based floats in [0, 3]; goal scale is `Math.round(score) + 1`.

Blocker and safety authority only adds positive gates in the authoritative stage. Existing downstream planner structures are retained; promoting a top-level field does not rebuild the parallelization plan. Stage rollout should account for that distinction.

## Configuration and observations

- `TYPESAFE_API_KEY`: optional TypeSafe credential, resolved by the existing client from the environment or workspace env file.
- `MYOS_JEV_ENABLED=0`: bypasses Jev and preserves legacy behavior; prompt context adds only `[Jev] skipped: disabled`. The hidden `--no-jev` hook flag does the same.
- `MYOS_JEV_STAGE`: `shadow`, `canary`, or `authoritative`, overriding the saved stage. Invalid values fall back to shadow.
- `MYOS_JEV_TIMEOUT_MS`: per-attempt timeout, default 1500.
- `MYOS_JEV_LOG_TEXT=1`: explicitly opts into prompt/command text in the shadow ledger. Text is omitted by default.
- `MYOS_HOME_ROOT`: observation root, defaulting to `~/.myos-dispatch` for Jev observations.

The ledger is `<root>/logs/jev-shadow.jsonl`; state is `<root>/state/jev-shadow-state.json`. Ledger entries contain hashes, lengths, incumbent values, typed answers, stage, engine, latency, tokens, and model. State metrics accumulate only real Jev answers, never rules self-agreement. Reliability bins measure agreement with the incumbent, not correctness against ground truth.

The existing hook route log adds a compact `jev` summary with stage, engine, skipped reason, agreement counts, latency, input tokens, and model; it contains no answer payload or text. Prompt records also include intent/action, goal scale/mode/confidence, fanout aggression/depth, plan/approval flags, and blockers for every install.

Prompt route context has one Jev status line after the Intent Fidelity/Horizon lines. A skipped decision shows its reason code. Tool safety context adds `jev=k/n` only for a completed model decision; skipped tool checks add nothing and ordinary reads stay silent.

## Evaluation and smoke checks

`npm run evaluate-jev -- --json` reports the default ledger and state. Options:

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
