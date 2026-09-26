# Jev calibrated decisions

The hook checks tier-0 before loading routing indexes. For remaining events, it starts one bounded Jev request from raw inputs before computing rules, then attaches comparisons to the completed rules result. UserPromptSubmit and the plain-text `--render-route` path use the prompt pack. Bash PreToolUse uses `resolveToolSafetyPlan`, avoiding recipe, capability, project and shadow planning on the common path. Other tools and events retain their existing paths. Direct synchronous hook imports remain compatible; the CLI owns the asynchronous step.

Tool safety preserves the goal classifier's approval predicate, planner blocker order and existing sidecar-policy labels. Protected-project write labels depend on project ownership: write-like commands check the protected subset of the project index and matching commands retain the full planner as a compatibility fallback. This exception prevents removing a legacy safety gate. Tool route-log records retain safety labels and the Jev summary schema; unrelated routing metadata now reflects a safety-only plan (`route.branch: "tool_safety"`) rather than an inferred prompt route.

Exact recipe wins skip project and capability scoring. Plans retain their already-collected signals under a non-enumerable `_dispatchSignals` property. Fastpaths still need capability lanes for the printed route and project evidence for typed-evidence authority and follow-up hints, so those consumers retain scoring. Removing it unconditionally would change routing. Capability and fastpath phrase regexes are cached per process.

The optional model is `jev-1.13.0`. Prompt requests default to a 1500 ms total timeout; tool requests default to 900 ms. The hook does not retry. Both hook budgets clamp to 200 through 2500 ms. The client bounds all attempts and backoff by its total timeout. Invalid answers, timeouts, unavailable credentials, transport failures, and unexpected attachment errors preserve the legacy plan. Tool authority can add safety labels and cannot remove existing labels. Observation write failures cannot block dispatch.

## Stages and fields

`shadow` records comparisons without changing decisions. `canary` is reserved; no fields today. `authoritative` is effective only for additive `safety.*` and `blockedBy.*` fields explicitly listed in the config file's `authoritativeFields`. All other fields, including goal confidence and fanout aggression, remain shadow-only. Promotion eligibility is reported, never automatically granted by the evaluator.

Prompt fields are intent type, action type, goal scale, correction detection, fanout aggression, and the six blockers: browser control, user-visible send, payment/account mutation, auth sensitive, interactive auth, and destructive/approval sensitive. The pack has 11 questions. Capability lane, project and prompt injection are not asked; the model state contains only redacted prompt text and surface, so no shortlist is needed before transport starts. Goal confidence is derived from the score answer.

The tool pack has 8 questions: the six blockers, approval-sensitive operation, and read-only status. Protected-surface write, description-match and needs-human questions are removed. Existing rules-derived protected-surface labels are retained. All mapped fields default to a 0.9 confidence floor, including derived goal confidence. State `floors` can override individual fields. Noul decisions use 0.5 as their boolean threshold and the larger of p and 1-p as confidence. Score answers are finite zero-based floats in [0, 3]; goal scale is `Math.round(score) + 1`.

Blocker and safety authority only adds positive gates in the authoritative stage. Prompt comparisons remain available in the ledger for grading but cannot override the planner. Mapped fields accept dotted paths: correction uses `parallelizationPlan.executionEnvelope.features.intentFidelity.correctionDetected`, aggression uses `parallelizationPlan.aggression`, and a lane field in an existing/custom pack can use `route.lane`. The ledger's `legacy` keys and comparison metrics use those mapped paths. Old top-level correction/aggression metrics are not combined with the corrected series.

## Configuration and observations

- `TYPESAFE_API_KEY`: optional TypeSafe credential, resolved by the existing client from the environment or workspace env file.
- `MYOS_JEV_ENABLED=0`: bypasses Jev and preserves legacy behavior; prompt context adds only `[Jev] skipped: disabled`. The hidden `--no-jev` hook flag does the same.
- `MYOS_JEV_PROMPT_SAMPLE`: prompt fraction in [0, 1], default 0.2. Invalid or empty values use the default. The first 32 bits of the full prompt SHA-256 hash choose the sample, so identical prompts agree. Any configured non-`safety.*` authoritative field bypasses sampling, even when the stage is currently shadow. Tools are never sampled.
- `MYOS_JEV_STAGE`: `shadow`, `canary`, or `authoritative`, overriding the saved stage. Invalid values fall back to shadow.
- `MYOS_JEV_TIMEOUT_MS`: prompt total timeout, default 1500 ms, clamped to [200, 2500].
- `MYOS_JEV_TOOL_TIMEOUT_MS`: tool total timeout, default 900 ms, clamped to [200, 2500].
- `MYOS_JEV_HOOK_METRICS=1`: opt into best-effort atomic metrics writes; default off.
- `MYOS_JEV_LOG_TEXT=1`: explicitly opts into prompt/command text in the shadow ledger. Text is omitted by default.
- `MYOS_HOME_ROOT`: observation root, defaulting to `~/.myos-dispatch` for Jev observations.

The ledger is `<root>/logs/jev-shadow.jsonl`. Above 50 MB it rotates by atomic rename to `jev-shadow.<YYYYMMDD-HHMMSS>.jsonl` before append. Config `{stage, authoritativeFields, floors, promotionNote}` is read-only at `<root>/state/jev-shadow-state.json`. An unreadable config forces shadow for that event, records `configUnreadable`, and is never rewritten. Optional metrics live at `<root>/state/jev-shadow-metrics.json` and use same-directory temporary files plus atomic rename. Invalid metrics are not rewritten that event. Legacy config metrics supply the initial metrics until a separate file exists. Concurrent metric updates can be lost; the evaluator derives calibration and eligibility from model ledger rows across active and rotated files. Ledger entries contain hashes, lengths, incumbent values, typed answers, stage, engine, latency, tokens, and model. Opt-in hook metrics accumulate only real Jev answers, never rules self-agreement. Reliability bins measure agreement with the incumbent, not correctness against ground truth.

Model prompt, command, and description text is redacted for common credentials before pack construction. Shadow tool checks flush legacy labels immediately, finish observation work within the tool budget plus a 25 ms timeout-ledger continuation allowance, then exit explicitly. Authoritative tool checks await the result before output.

The existing hook route log adds a compact `jev` summary with stage, engine, skipped reason, agreement counts, latency, input tokens, and model; it contains no answer payload or text. Prompt records also include intent/action, goal scale/mode/confidence, fanout aggression/depth, plan/approval flags, and blockers for every install.

Prompt route context has one Jev status line after the Intent Fidelity/Horizon lines. A skipped decision shows its reason code. Tool safety context adds `jev=k/n` only for a completed model decision; skipped nontrivial tool checks add nothing and reads with no safety labels stay silent. Sampled-out prompts keep the normal routing block and route-log record with `[Jev] skipped: sampled_out` and no model ledger row.

## Tier-0

Trivial prompts are exactly the case-insensitive acknowledgement set `ok`, `okay`, `yes`, `no`, `thanks`, `thank you`, `go`, `go ahead`, `continue`, `keep going`, `do it`, `sure`, `great`, `nice`, `cool`, `got it`, `k`, `y`, `n` (trailing punctuation ignored), a bare HTTP(S) URL, or text starting with `<` or `[`. Word count is never a triviality test. Short directives such as "red lighting" and "mute Mac studio" still route normally. The existing `h` ping shortcut is unchanged.

Commands must be simple allow-listed pipelines after removing `cd X &&` and `export X=Y &&` prefixes. Allowed verbs are `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find`, `pwd`, `echo`, `which`, `wc`, `stat`, `du`, `df`, `ps`, `sysctl`, `uname`, `date`, `whoami`, `id`; env-free `git status|log|diff|show|branch|rev-parse`; and exact `node --version`, `npm --version`, `python3 --version`. Redirects, substitutions, backticks, command separators, sudo, rm, xargs, -exec, tee, curl and ssh disqualify the command. Ambiguous shell syntax and known write/execute flags such as `find -delete`, `git branch -D`, `git diff --output`, `rg --pre`, and loader-related export prefixes also take the normal safety path. Quoted flags receive the same checks.

Tier-0 events skip indexes, shadow planning and Jev, print `[Jev] skipped: tier0_trivial`, and retain one route-log row with `branch: "tier0"`. Tool events still apply the existing opt-in RTK rewrite.

## Efficiency

Measured in this isolated worktree on 2026-09-26, fresh Node process per event, `--surface=test`, fanout disabled, isolated empty indexes. Both runs classified (never executed) the first 20 rows of each named research corpus: `p0001` through `p0020` from `PROMPT-CORPUS-2026-09-26.jsonl`, and `tsc-0001` through `tsc-0020` from `TOOL-SAFETY-CORPUS-2026-09-26.jsonl`. Jev was enabled in authoritative stage, using a controlled 400 ms in-process transport stub with valid typed answers. The baseline ran before edits; the after run used default prompt sampling. There were 40 stub calls before and 24 after (4 prompts, 20 tools); 16 prompts were sampled out and none of these corpus rows hit tier-0.

| Event | Before p50 wall | After p50 wall | Events per run |
|---|---:|---:|---:|
| Prompt | 507.5 ms | 79.4 ms | 20 |
| Tool | 483.6 ms | 498.2 ms | 20 |

The after run additionally measured safety rules at 2.29 ms p50, 2.89 ms max for 20 tools; prompt rules were 7.35 ms p50. Timings use the mean of the two middle observations. The tool wall-time sample did not improve; with empty indexes, startup variance and the fixed stub dominate. These are controlled local measurements, not live Jev or production-index results. The network-disabled, no-secret execution envelope prevented reproducing the report's live transport and installed indexes; production's reported roughly 100 ms rules cost and the under-15 ms target still need validation on that install. The original report's live p50s were 646 ms for prompts and 634 ms for tools; do not compare those directly with this stub run.

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
