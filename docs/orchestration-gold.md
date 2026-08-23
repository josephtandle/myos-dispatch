# MyOS Dispatch Orchestration Gold

This rollout folds seven current orchestration capabilities into MyOS Dispatch without making any provider the routing authority.

## 1. Scheduled dispatch

Scheduled runs use a typed `ScheduleSpec`. The gold canary accepts only `report` and `propose` actions, forces `MYOS_INITIATOR=unattended`, disables background and writable sidecars, and rejects external mutation. MyOS does not create or modify an operating-system schedule from this contract.

## 2. Custom parallel agents

Dispatch emits a named, read-only Codex agent profile for every native research, decomposition, documentation, safety, review, and verification lane. Native Codex threads never receive writable tasks. The `sync-codex-agents.js` script copies only `myos-*.toml` profiles and records hashes in a MyOS-owned manifest. Profile selection is advisory until Codex exposes a supported native-thread profile-binding API.

## 3. Goal continuity

Goal persistence remains explicit-only. Goal Scale 3 and 4 describe execution semantics but do not silently create a Codex persisted goal. Sidecars cannot create, update, complete, pause, resume, or budget a root goal. Codex continuation is used only when the user explicitly created a persisted goal; MyOS owns ordinary Ralph persistence and OMX owns the Scale 4 ledger.

## 4. Skills and plugins

The capability index can include enabled Codex plugins with `--include-codex-plugins`. Plugin records are advisory and lower-priority than MyOS recipes, project routing, compliance gates, and deterministic handlers. Browser plugins still require MyOS browser preflight; Google work still routes local-first; background Codex sidecars run with `--ignore-user-config`. This inventory is not promoted into the live index yet: persisted plugin records require index regeneration to remove, so immediate runtime rollback remains a prerequisite for promotion.

## 5. Worktree isolation

Writable parallel work is runner-owned, repository-scoped, and limited to one writer for an ownership root. Verification remains independently read-only. Changes are staged so new files are included, checked against ownership paths, emitted as a durable binary patch outside the temporary worktree, hashed with SHA-256, and then the worktree is removed.

## 6. Intent Fidelity

Every interactive route receives the same provider-neutral Intent Fidelity contract in Claude Code and Codex. The latest explicit instruction outranks an earlier interpretation, an inferred preference, and stale session context. A correction is applied without defending or re-litigating the superseded interpretation.

When a safe path exists, the orchestrator makes the smallest reasonable reversible assumption, executes the next step, verifies it, and reports afterward. It asks at most one targeted question only when material ambiguity has no reversible safe path. Recommendations, policy recaps, and permission-seeking cannot replace safe in-scope action.

The contract does not weaken authority boundaries. For authentication, destructive actions, external sends, live production mutation, protected surfaces, and material ambiguity, the orchestrator completes safe prework, names the exact gate, and requests only the minimum unblock. Route logs preserve the policy and correction signal for parity and health analysis.

## 7. Intent Horizon

Actionable interactive work at Goal Scale 3 or 4 receives the same provider-neutral Intent Horizon contract in Claude Code and Codex. The orchestrator must finish and verify the requested outcome, repair related failures it can safely fix, then run exactly one exploratory upgrade sweep across the routed project and its direct call-graph neighborhood.

The sweep is intentionally aggressive and finite. Scale 3 can score four candidates and implement the best two. Scale 4 can score eight and implement the best four. Candidates must remain inside causal depth two, match the assigned ownership path, be reversible, and have binary verification. New authority, live production mutation, external sends, destructive actions, protected surfaces, and unaudited dependencies fail closed. An upgrade may create a required repair, but it cannot start another upgrade sweep.

The machine contract includes required, verification, repair, and upgrade ledger item types; explicit continuation and stop reasons; a ten-point candidate rubric; accepted binary verification types; bounded attempt and wall-time budgets; and health classifications for diagnosis-only completion, skipped qualified upgrades, and budget exhaustion. Route logs preserve the contract for later compliance analysis.

## Rollout and rollback

The integration is compatibility-first and guarded by independent environment switches:

- `MYOS_ORCHESTRATION_GOLD_ENABLED=0`
- `MYOS_SCHEDULED_DISPATCH_ENABLED=0`
- `MYOS_BACKGROUND_AGENTS_ENABLED=0`
- `MYOS_CODEX_PLUGIN_ROUTING_ENABLED=0`
- `MYOS_WRITABLE_SIDECARS_ENABLED=0`
- `MYOS_INTENT_FIDELITY_ENABLED=0`
- `MYOS_INTENT_HORIZON_ENABLED=0`

Scheduled mutation and external sends remain disabled until a separate audited canary proves sandboxing, repository targeting, idempotency, and delivery safety. `compile-schedule-spec.js` validates and compiles the contract but does not register or launch an operating-system or Codex schedule.

Generic repository prompts without a routed project or explicit scope remain read-only. Passing browser-hook working-directory context into the core planner touches a high-risk routing seam and is deferred to a separate shadow rollout.
