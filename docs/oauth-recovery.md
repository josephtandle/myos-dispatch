# OAuth execution and recovery

This upgrade belongs to MyOS Dispatch, not Codex. API routing and private bot execution remain separate. OAuth is an authentication mode, not a guarantee of zero account-credit usage.

## Default task classes

| Class | Primary | Explicit fallback | Effort |
| --- | --- | --- | --- |
| cheap_routing | Warm, eligible local Qwen, then Luna | Terra | low |
| default_automation | Terra | Sol | medium |
| heavy_synthesis | Sol | Astra | high |
| task_class_is_elite | Astra | Sol | high |
| planning | Sol | Astra | medium |

These names refer to exact registered IDs: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-astra`. Explicit model pins, intent routes and host lane assignments retain priority. The active user-selected agent remains the orchestrator. This policy does not itself launch a team.

Only unsupported-model failures permit a cloud fallback, within the original request deadline. Auth, quota, interruption and unknown failures are terminal. Writers and explicit model pins are not retried. Before a queued default is used, current registry visibility, auth, freshness and quarantine are checked again.

## Discovery and repair

Run `myos-oauth-doctor scan` or `node bin/myos-oauth-doctor.js scan`; use `status` for a read-only report. Failures trigger a coalesced scan with a one-minute cooldown. There is no weekly job. `MYOS_OAUTH_RECOVERY=0` disables registry integration. Registry and local registration paths can be overridden with `MYOS_OAUTH_REGISTRY` and `MYOS_OAUTH_LOCAL_PROVIDER_CONFIG`.

Codex discovery uses the official app-server `initialize` and paginated `model/list` metadata methods, never an inference turn. A cache fallback retains its original timestamp. Records older than seven days are ineligible. Unknown newly discovered models are registered, but are not assigned task classes automatically without evaluation. Removed models retain history but become invisible.

The registry distinguishes discovery, successful requested-model invocation and task-quality validation. CLI success is not independent provider attestation of model identity. Raw prompts, credentials and stderr are not persisted in recovery state.

Claude CLI aliases are inventory, not proof of account entitlement. Claude must report subscription authentication before it can be considered available. Antigravity model metadata alone does not establish its authentication or billing provenance. Neither is silently substituted for Codex. Text-only OAuth routes do not pretend to provide audio transcription or speaker diarization.

## Local Qwen

Qwen is for bounded, tool-free text routing, not repository authoring or orchestration. The existing registration validator restricts it to loopback, complete offline weights and approved task classes. Tools, media, explicit pins, intents and unbounded requests are excluded.

OAuth defaults to warm-first: a cold or memory-blocked model falls through promptly to OAuth. Deliberate cold starts require `allowLocalColdStart: true` and at least 75 seconds remaining, and still obey the existing memory-pressure/backoff loader. Weights stay on external storage. No permanent residency or login autostart is installed.

## Operational limits

Registry writes are atomic with revision checks and a last-good snapshot. macOS uses native dead-owner-aware locks; other platforms fail conservatively on stale locks and require operator recovery. Metadata and inference processes have bounded time/output budgets. Native Windows inference requires WSL for owned-process cleanup.

Model discovery reference: [official Codex app-server documentation](https://developers.openai.com/codex/app-server).
