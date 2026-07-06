# Dispatch Engine Consolidation Contract

## Scope

This consolidation covers the staged self-promotion state machines in:

| File | Purpose | State file env override | Stage/version env override | Auto-promote env override | Quarantine |
|---|---|---|---|---|---|
| `agents/shared/typed-evidence-shadow-policy.js` | Replay-gated typed-evidence shadow promotion | `MYOS_TYPED_EVIDENCE_SHADOW_STATE_FILE` | `MYOS_TYPED_EVIDENCE_SHADOW_VERSION` | `MYOS_TYPED_EVIDENCE_SHADOW_AUTO_PROMOTE` | No |
| `agents/shared/dispatcher-health-version-policy.js` | Dispatcher health promotion and safe quarantine bookkeeping | `MYOS_DISPATCH_HEALTH_STATE_FILE` | `MYOS_DISPATCH_HEALTH_VERSION` | `MYOS_DISPATCH_HEALTH_AUTO_PROMOTE` | Yes |
| `agents/shared/parallelization-version-policy.js` | Parallelization promotion and health quarantine bookkeeping | `MYOS_PARALLELIZATION_STATE_FILE` | `MYOS_PARALLELIZATION_VERSION` | `MYOS_PARALLELIZATION_AUTO_PROMOTE` | Yes |

## Shared Primitive Inventory

| Primitive shape | Typed evidence | Dispatcher health | Parallelization |
|---|---|---|---|
| `POLICY_VERSION` | `myos-typed-evidence-shadow-self-promotion-v1` | `myos-dispatcher-health-self-promotion-v1` | `myos-parallelization-auto-promotion-v2` |
| `VERSION_STAGES` / stage registry | `v1 -> v2 -> v3` | `v1 -> v2 -> v3` | `writable_sidecars_v1`, `v2 -> v3 -> v4` |
| `normalizeStageId(value)` | Yes | Yes | Yes |
| `stageFor(value)` / `get*Stage(...)` | `stageFor`, `getTypedEvidenceShadowStage` | `stageFor`, `getDispatcherHealthStage` | `stageFor`, `getParallelizationStage` |
| Default state file resolver | `defaultStateFile()` + `resolveStateFile()` | `DEFAULT_STATE_FILE` + `resolveStateFile()` | `DEFAULT_STATE_FILE` + `resolveStateFile()` |
| Read/write state | `readTypedEvidenceShadowState`, `writeTypedEvidenceShadowState` | `readDispatcherHealthState`, `writeDispatcherHealthState` | `readVersionState`, `writeVersionState` |
| Compact state view | `compactTypedEvidenceShadowState` | `compactDispatcherHealthVersionState` | `compactParallelizationVersionState` |
| Promotion eligibility | `isEligibleForPromotion(stage, metrics, options)` | `isEligibleForDispatcherHealthPromotion(stage, metrics, state, options)` | `isEligibleForPromotion(stage, metrics, options)` |
| Promotion application | internal `applyPromotionIfEligible(...)` | inside `applyDispatcherHealthMetricEvent(...)` | inside `recordParallelizationRun(...)` |
| Quarantine helpers | none | `activeQuarantines`, protected quarantine gate | `activeQuarantines`, `isParallelizationTargetQuarantined` |

## Per-Subsystem Differences

### Typed Evidence Shadow

- Stages:
  - `v1`: observe and replay-gated comparison
  - `v2`: safe read-only data/reference authoritative canary
  - `v3`: expanded read-only project/capability canary
- Promotion thresholds:
  - `v1 -> v2`: replay corpus thresholds (`minReplayCases`, pass rates, safe canary count, zero dangerous mismatches)
  - `v2 -> v3`: live authoritative thresholds (`minLiveComparisons`, `minAuthoritativeUses`, `minSuccessfulAuthoritativeUses`, max failure rate, zero dangerous mismatches)
- State file path:
  - `~/.myos/workspace/agents/shared/data/typed-evidence-shadow-state.json`
- Quarantine:
  - None

### Dispatcher Health

- Stages:
  - `v1`: observe, repair actions, and safe quarantines
  - `v2`: allowlisted low-risk auto-repair
  - `v3`: reserved
- Promotion thresholds:
  - `v1 -> v2`: observed event count, repair actions created, validated repairs, zero unsafe quarantine incidents, zero rollback-required repairs, and no protected active quarantines
- State file path:
  - `~/.myos/workspace/agents/shared/data/dispatcher-health-state.json`
- Quarantine:
  - Present
  - Protected quarantines must block promotion

### Parallelization

- Stages:
  - `writable_sidecars_v1`: provider-affine writable git-worktree sidecars
  - `v2`: read-only sidecars
  - `v3`: safe verification sidecars
  - `v4`: bounded implementation slice planning
- Promotion thresholds:
  - `v2 -> v3`: successful runs, completed tasks, zero failure rate
  - `v3 -> v4`: successful runs, completed tasks, useful tasks, zero failure rate, required capability evidence
  - Later-stage promotion may also use clean-streak evidence
- State file path:
  - `~/.myos/workspace/agents/shared/data/parallelization-version-state.json`
- Quarantine:
  - Present
  - Timeout failures are task-kind-only, threshold `4`, quarantine `1h`
  - Non-timeout failures default to threshold `2`, quarantine `6h`

## Preserved Public APIs

### `typed-evidence-shadow-policy.js`

Exports preserved verbatim:

- `DEFAULT_REPLAY_CORPUS_FILE`
- `POLICY_VERSION`
- `VERSION_STAGES`
- `compactTypedEvidenceShadowState`
- `decideTypedEvidenceShadowAuthority`
- `evaluateTypedEvidenceReplayCases`
- `getTypedEvidenceShadowStage`
- `isRiskyAuthoritativePrompt`
- `isSafeAuthoritativeShadow`
- `loadTypedEvidenceReplayCorpus`
- `normalizeStageId`
- `readTypedEvidenceShadowState`
- `recordTypedEvidenceReplayEvaluation`
- `recordTypedEvidenceShadowLiveComparison`
- `routeSnapshot`
- `stageFor`
- `writeTypedEvidenceShadowState`

### `dispatcher-health-version-policy.js`

Exports preserved verbatim:

- `DEFAULT_STATE_FILE`
- `POLICY_VERSION`
- `VERSION_STAGES`
- `activeQuarantines`
- `applyDispatcherHealthMetricEvent`
- `compactDispatcherHealthVersionState`
- `defaultHealthState`
- `getDispatcherHealthStage`
- `isEligibleForDispatcherHealthPromotion`
- `normalizeDispatcherHealthState`
- `normalizeStageId`
- `readDispatcherHealthState`
- `stageFor`
- `writeDispatcherHealthState`

### `parallelization-version-policy.js`

Exports preserved verbatim:

- `DEFAULT_STATE_FILE`
- `POLICY_VERSION`
- `VERSION_STAGES`
- `classifyFailure`
- `compactParallelizationHealth`
- `compactParallelizationVersionState`
- `getParallelizationStage`
- `isEligibleForPromotion`
- `isParallelizationTargetQuarantined`
- `normalizeStageId`
- `readVersionState`
- `recordParallelizationRun`
- `summarizeRunResults`
- `updateParallelizationHealth`
- `writeVersionState`

## Shared Engine Config Surface

`agents/shared/staged-promotion-policy.js` exposes one generic factory:

- `createStagedPromotionPolicy(config)`

Config fields:

- `policyVersion`
- `stages`
- `defaultStage`
- `defaultStateFile`
- `stateFileEnvVar`
- `stageOverrideEnvVar`
- `autoPromoteEnvVar`
- `defaultState()`
- `normalizeState(value)`
- `compactState(state)`
- `isEligibleForPromotion(stage, metrics, state, options)`
- `buildPromotionEvidence(metrics, state, stage, nextStage, options)`
- `normalizeHealthState(health)` for quarantine-aware policies
- `promotionHistoryLimit` optional, default `25`

Factory output primitives:

- `normalizeStageId`
- `stageFor`
- `resolveStateFile`
- `readState`
- `writeState`
- `getStage`
- `applyPromotionIfEligible`
- `activeQuarantines`
- `hasProtectedActiveQuarantine`
- `isTargetQuarantined`
- `healthKey`
- `parseTime`
- `isExpired`
