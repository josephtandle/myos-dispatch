# MyOS Dispatch Orchestration Gold

This rollout folds five current Codex orchestration capabilities into MyOS Dispatch without making Codex the routing authority.

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

## Rollout and rollback

The integration is compatibility-first and guarded by independent environment switches:

- `MYOS_ORCHESTRATION_GOLD_ENABLED=0`
- `MYOS_SCHEDULED_DISPATCH_ENABLED=0`
- `MYOS_BACKGROUND_AGENTS_ENABLED=0`
- `MYOS_CODEX_PLUGIN_ROUTING_ENABLED=0`
- `MYOS_WRITABLE_SIDECARS_ENABLED=0`

Scheduled mutation and external sends remain disabled until a separate audited canary proves sandboxing, repository targeting, idempotency, and delivery safety. `compile-schedule-spec.js` validates and compiles the contract but does not register or launch an operating-system or Codex schedule.

Generic repository prompts without a routed project or explicit scope remain read-only. Passing browser-hook working-directory context into the core planner touches a high-risk routing seam and is deferred to a separate shadow rollout.
