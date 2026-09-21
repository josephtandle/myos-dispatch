# Claude subscription connection

## What / why

Connect the existing Claude Max subscription to foreground Dispatch text execution and an explicit, bounded fallback. Distinguish Desktop-host authentication from reusable CLI authentication.

## Approach

Add oauth-claude.js for tool-free CLI execution and per-call subscription auth verification. Extend registry selection for the live-verified exact Sonnet identity in cheap_routing, default_automation and planning. Integrate only foreground OAuth, preserving explicit pins and API behavior. Do not reuse Desktop IPC tokens; use the official CLI subscription login instead.

## Acceptance criteria

- Official CLI reports claude.ai auth; a real tool-free structured canary succeeds with exact model identity.
- CLI strips inherited Desktop, API and alternate endpoint credentials; tools, MCP and recursive fanout are disabled.
- An eligible registered Claude candidate can execute explicitly and as an unsupported-model fallback without changing API plans or retrying quota/auth failures.
- Tests prove missing auth, stale eligibility, malformed output and model mismatch fail closed.
- Qwen RAM and backoff remain protected; report measured capacity and pressure rather than equating free pages with total available capacity.

## The check

Focused fail-first tests, complete isolated Node 24 suite, independent review, then installed foreground Claude and registry readback.

## Out of scope

API upgrade, private bot changes, bypassing memory pressure, account changes, paid credits and new scheduled jobs. Larger local-model policy changes require measured quality and latency evidence.
