"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createStagedPromotionPolicy } = require("./staged-promotion-policy");
const { resolveWorkspacePath } = require("../myos-compat");

const POLICY_VERSION = "myos-parallelization-auto-promotion-v2";
const DEFAULT_STAGE = "writable_sidecars_v1";
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 2;
const DEFAULT_QUARANTINE_MS = 6 * 60 * 60 * 1000;
// Timeouts are a budget problem, not a provider fault: they get a higher
// threshold, a shorter quarantine, and never quarantine a whole provider.
const TIMEOUT_FAILURE_THRESHOLD = 4;
const TIMEOUT_QUARANTINE_MS = 60 * 60 * 1000;
const DEFAULT_STATE_FILE = resolveWorkspacePath("agents", "shared", "data", "parallelization-version-state.json");

const VERSION_STAGES = Object.freeze([
  Object.freeze({
    id: "writable_sidecars_v1",
    planVersion: "myos-parallelization-writable-v1",
    label: "provider-affine writable git-worktree sidecars",
    nextStage: null,
    autoPromote: false,
    capabilities: Object.freeze({
      readOnlySidecars: true,
      safeVerificationExecution: "provider_affine",
      boundedImplementationSlices: "writable_git_worktree",
      writableGitWorktrees: true,
    }),
    promotionCriteria: null,
  }),
  Object.freeze({
    id: "v2",
    planVersion: "myos-parallelization-v2",
    label: "read-only sidecars",
    nextStage: "v3",
    autoPromote: true,
    capabilities: Object.freeze({
      readOnlySidecars: true,
      safeVerificationExecution: false,
      boundedImplementationSlices: false,
      writableGitWorktrees: false,
    }),
    promotionCriteria: Object.freeze({
      minSuccessfulRuns: 5,
      minCompletedTasks: 10,
      maxFailureRate: 0,
    }),
  }),
  Object.freeze({
    id: "v3",
    planVersion: "myos-parallelization-v3",
    label: "safe verification sidecars",
    nextStage: "v4",
    autoPromote: true,
    capabilities: Object.freeze({
      readOnlySidecars: true,
      safeVerificationExecution: "allowlisted_only",
      boundedImplementationSlices: false,
      writableGitWorktrees: false,
    }),
    promotionCriteria: Object.freeze({
      minSuccessfulRuns: 10,
      minCompletedTasks: 25,
      minUsefulTasks: 15,
      maxFailureRate: 0,
      requiredCapability: "safeVerificationExecution",
    }),
  }),
  Object.freeze({
    id: "v4",
    planVersion: "myos-parallelization-v4",
    label: "bounded implementation slice planning",
    nextStage: null,
    autoPromote: false,
    capabilities: Object.freeze({
      readOnlySidecars: true,
      safeVerificationExecution: "allowlisted_only",
      boundedImplementationSlices: "plan_only",
      writableGitWorktrees: false,
    }),
    promotionCriteria: null,
  }),
]);

function defaultState() {
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    activeStage: DEFAULT_STAGE,
    stages: {},
    health: defaultHealthState(),
    promotions: [],
    updatedAt: null,
  };
}

function resolveStateFile(options = {}) {
  return options.stateFile || process.env.MYOS_PARALLELIZATION_STATE_FILE || DEFAULT_STATE_FILE;
}

function normalizeMetricState(metrics = {}) {
  return {
    observedRuns: Number(metrics.observedRuns || 0),
    successfulRuns: Number(metrics.successfulRuns || 0),
    failedRuns: Number(metrics.failedRuns || 0),
    completedTasks: Number(metrics.completedTasks || 0),
    failedTasks: Number(metrics.failedTasks || 0),
    skippedTasks: Number(metrics.skippedTasks || 0),
    usefulTasks: Number(metrics.usefulTasks || 0),
    cleanStreakRuns: Number(metrics.cleanStreakRuns || 0),
    cleanStreakCompletedTasks: Number(metrics.cleanStreakCompletedTasks || 0),
    cleanStreakCapabilities:
      metrics.cleanStreakCapabilities && typeof metrics.cleanStreakCapabilities === "object"
        ? { ...metrics.cleanStreakCapabilities }
        : {},
    providers: metrics.providers && typeof metrics.providers === "object" ? { ...metrics.providers } : {},
    capabilities: metrics.capabilities && typeof metrics.capabilities === "object" ? { ...metrics.capabilities } : {},
    firstRunAt: metrics.firstRunAt || null,
    lastRunAt: metrics.lastRunAt || null,
    lastFailureAt: metrics.lastFailureAt || null,
  };
}

function defaultHealthState() {
  return {
    failures: {},
    quarantines: {},
    repairActions: [],
  };
}

function normalizeHealthState(health = {}) {
  const failures = {};
  for (const [key, value] of Object.entries(health.failures || {})) {
    failures[key] = {
      key,
      type: value.type || key.split(":")[0] || "unknown",
      value: value.value || key.split(":").slice(1).join(":") || "",
      count: Number(value.count || 0),
      lastReason: value.lastReason || "unknown",
      lastFailureAt: value.lastFailureAt || null,
      firstFailureAt: value.firstFailureAt || value.lastFailureAt || null,
    };
  }
  const quarantines = {};
  for (const [key, value] of Object.entries(health.quarantines || {})) {
    quarantines[key] = {
      key,
      type: value.type || key.split(":")[0] || "unknown",
      value: value.value || key.split(":").slice(1).join(":") || "",
      reason: value.reason || "repeated_background_failure",
      createdAt: value.createdAt || null,
      until: value.until || null,
      repairActionId: value.repairActionId || null,
    };
  }
  return {
    failures,
    quarantines,
    repairActions: Array.isArray(health.repairActions) ? health.repairActions.slice(-50) : [],
  };
}

function normalizeVersionState(value = {}) {
  const activeStage = normalizeStageId(value.activeStage) || DEFAULT_STAGE;
  const stages = {};
  for (const stage of VERSION_STAGES) {
    stages[stage.id] = normalizeMetricState(value.stages?.[stage.id]);
  }
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    activeStage,
    stages,
    health: normalizeHealthState(value.health),
    promotions: Array.isArray(value.promotions) ? value.promotions.slice(-25) : [],
    updatedAt: value.updatedAt || null,
  };
}

function getCriteria(stage, options = {}) {
  const override = options.criteriaOverrides?.[stage.id] || {};
  return {
    ...(stage.promotionCriteria || {}),
    ...override,
  };
}

function failureRate(metrics = {}) {
  const total = Number(metrics.completedTasks || 0) + Number(metrics.failedTasks || 0);
  if (total <= 0) return 0;
  return Number(metrics.failedTasks || 0) / total;
}

function parseTime(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function isExpired(value, now) {
  if (!value?.until) return false;
  return parseTime(value.until) <= parseTime(now || new Date().toISOString());
}

function healthKey(type, value) {
  return `${type}:${String(value || "unknown").toLowerCase()}`;
}

function classifyFailure(result = {}) {
  const text = `${result.summary || ""}\n${result.stderr || ""}`.toLowerCase();
  if (/timed out|timeout|sigterm/.test(text)) return "timeout";
  if (/auth|oauth|token|credential|api key|permission denied|unauthorized/.test(text)) return "auth_or_permission";
  if (/enoent|not found|command not found|no such file/.test(text)) return "cli_unavailable";
  if (/rate limit|quota|overloaded|temporarily unavailable|503|429/.test(text)) return "provider_unavailable";
  if (/json|parse|schema|invalid output/.test(text)) return "output_parse";
  return "background_failure";
}

function repairSuggestionFor(reason, target) {
  if (reason === "timeout") return `Review timeout, prompt scope, and model choice for ${target}.`;
  if (reason === "auth_or_permission") return `Check credentials and permission-mode configuration for ${target}.`;
  if (reason === "cli_unavailable") return `Verify the CLI is installed and on PATH for ${target}.`;
  if (reason === "provider_unavailable") return `Check provider status or route ${target} to a fallback model.`;
  if (reason === "output_parse") return `Tighten output parsing or prompt schema for ${target}.`;
  return `Inspect repeated background-agent failure for ${target}.`;
}

function makeRepairAction({ key, type, value, reason, now, evidence }) {
  return {
    id: `parallelization-repair-${type}-${String(value || "unknown").replace(/[^a-z0-9_-]+/gi, "-")}-${Date.parse(now) || Date.now()}`,
    status: "open",
    type,
    value,
    reason,
    createdAt: now,
    suggestedAction: repairSuggestionFor(reason, `${type}:${value}`),
    evidence,
    key,
  };
}

function activeQuarantines(health = {}, now = new Date().toISOString()) {
  return stagedPromotionPolicy.activeQuarantines(health, now);
}

function isParallelizationTargetQuarantined(state = {}, type, value, options = {}) {
  return stagedPromotionPolicy.isTargetQuarantined(state, type, value, options);
}

function isEligibleForPromotion(stage, metrics, options = {}) {
  if (!stage?.nextStage || !stage.autoPromote) return false;
  const criteria = getCriteria(stage, options);
  const totalCapabilityCount = Number(metrics.capabilities?.[criteria.requiredCapability] || 0);
  const cleanCapabilityCount = Number(metrics.cleanStreakCapabilities?.[criteria.requiredCapability] || 0);
  if (criteria.requiredCapability && totalCapabilityCount <= 0 && cleanCapabilityCount <= 0) {
    return false;
  }
  if (criteria.minUsefulTasks && Number(metrics.usefulTasks || 0) < Number(criteria.minUsefulTasks)) {
    return false;
  }
  const cumulativeEligible = (
    Number(metrics.successfulRuns || 0) >= Number(criteria.minSuccessfulRuns || 0) &&
    Number(metrics.completedTasks || 0) >= Number(criteria.minCompletedTasks || 0) &&
    failureRate(metrics) <= Number(criteria.maxFailureRate || 0)
  );
  if (cumulativeEligible) return true;

  return (
    Number(metrics.cleanStreakRuns || 0) >= Number(criteria.minSuccessfulRuns || 0) &&
    Number(metrics.cleanStreakCompletedTasks || 0) >= Number(criteria.minCompletedTasks || 0)
  );
}

function summarizeRunResults(results = []) {
  const executed = results.filter((result) => result?.runner && ["completed", "failed"].includes(result.status));
  const completed = executed.filter((result) => result.status === "completed");
  const failed = executed.filter((result) => result.status === "failed");
  const skipped = executed.filter((result) => result.status === "skipped");
  const providers = {};
  const capabilities = {};
  for (const result of executed) {
    if (!result.runner) continue;
    providers[result.runner] = Number(providers[result.runner] || 0) + 1;
    for (const capability of [result.capabilityEvidence, result.capability].flat().filter(Boolean)) {
      capabilities[capability] = Number(capabilities[capability] || 0) + 1;
    }
  }
  const useful = completed.filter((result) => (
    (Array.isArray(result.findings) && result.findings.length > 0) ||
    (Array.isArray(result.changedFiles) && result.changedFiles.length > 0)
  ));
  return {
    executedTasks: executed.length,
    completedTasks: completed.length,
    failedTasks: failed.length,
    skippedTasks: skipped.length,
    usefulTasks: useful.length,
    providers,
    capabilities,
    successfulRun: executed.length > 0 && failed.length === 0,
  };
}

function recordHealthFailure(health, target, result, options = {}) {
  const now = options.now || new Date().toISOString();
  const reason = classifyFailure(result);
  const isTimeout = reason === "timeout";
  if (isTimeout && target.type === "provider") return null;
  const threshold = isTimeout
    ? Number(options.timeoutFailureThreshold || TIMEOUT_FAILURE_THRESHOLD)
    : Number(options.healthFailureThreshold || DEFAULT_HEALTH_FAILURE_THRESHOLD);
  const quarantineMs = isTimeout
    ? Number(options.timeoutQuarantineMs || TIMEOUT_QUARANTINE_MS)
    : Number(options.quarantineMs || DEFAULT_QUARANTINE_MS);
  const key = healthKey(target.type, target.value);
  const previous = health.failures[key] || {
    key,
    type: target.type,
    value: target.value,
    count: 0,
    firstFailureAt: now,
  };
  const failure = {
    ...previous,
    count: Number(previous.count || 0) + 1,
    lastReason: reason,
    lastFailureAt: now,
  };
  health.failures[key] = failure;

  if (failure.count < threshold || health.quarantines[key]) return null;

  const repairAction = makeRepairAction({
    key,
    type: target.type,
    value: target.value,
    reason,
    now,
    evidence: {
      failureCount: failure.count,
      taskId: result.taskId || null,
      taskKind: result.taskKind || null,
      runner: result.runner || null,
      summary: String(result.summary || result.stderr || "").slice(0, 300),
    },
  });
  health.repairActions = [...health.repairActions, repairAction].slice(-50);
  health.quarantines[key] = {
    key,
    type: target.type,
    value: target.value,
    reason,
    createdAt: now,
    until: new Date((Date.parse(now) || Date.now()) + quarantineMs).toISOString(),
    repairActionId: repairAction.id,
  };
  return repairAction;
}

function clearHealthSuccess(health, target, options = {}) {
  const key = healthKey(target.type, target.value);
  delete health.failures[key];
  const now = options.now || new Date().toISOString();
  health.repairActions = health.repairActions.map((action) => (
    action.key === key && action.status === "open"
      ? { ...action, status: "resolved", resolvedAt: now, resolution: "target_completed_cleanly" }
      : action
  ));
}

function updateParallelizationHealth(state, results = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const normalized = normalizeVersionState(state);
  const health = normalizeHealthState(normalized.health);
  health.quarantines = activeQuarantines(health, now);
  const repairActions = [];

  for (const result of results) {
    if (!result?.runner || result.status === "planned") continue;
    const targets = [
      { type: "provider", value: result.runner },
      result.taskKind ? { type: "taskKind", value: result.taskKind } : null,
    ].filter(Boolean);

    if (result.status === "completed") {
      for (const target of targets) clearHealthSuccess(health, target, { now });
      continue;
    }

    if (result.status !== "failed") continue;
    for (const target of targets) {
      const repairAction = recordHealthFailure(health, target, result, {
        ...options,
        now,
      });
      if (repairAction) repairActions.push(repairAction);
    }
  }

  normalized.health = health;
  return {
    state: normalized,
    health: compactParallelizationHealth(health, { now }),
    repairActions,
  };
}

function recordParallelizationRun(plan = {}, results = [], options = {}) {
  const env = options.env || process.env;
  const summary = summarizeRunResults(results);
  const now = options.now || new Date().toISOString();
  const state = normalizeVersionState(readVersionState(options));
  const healthUpdate = updateParallelizationHealth(state, results, { ...options, now });
  state.health = healthUpdate.state.health;
  state.updatedAt = now;

  if (env.MYOS_PARALLELIZATION_AUTO_PROMOTE === "0" || options.enabled === false) {
    writeVersionState(state, options);
    return {
      state: compactParallelizationVersionState(state),
      health: compactParallelizationHealth(state.health, { now }),
      repairActions: healthUpdate.repairActions,
      promoted: null,
      skippedReason: "auto_promotion_disabled",
    };
  }

  if (!summary.executedTasks) {
    writeVersionState(state, options);
    return {
      state: compactParallelizationVersionState(state),
      health: compactParallelizationHealth(state.health, { now }),
      repairActions: healthUpdate.repairActions,
      promoted: null,
      skippedReason: "no_executed_background_tasks",
    };
  }

  const stage = stageFor(plan.promotion?.activeStage || plan.version || state.activeStage);
  const metrics = normalizeMetricState(state.stages[stage.id]);
  metrics.observedRuns += 1;
  metrics.successfulRuns += summary.successfulRun ? 1 : 0;
  metrics.failedRuns += summary.failedTasks > 0 ? 1 : 0;
  metrics.completedTasks += summary.completedTasks;
  metrics.failedTasks += summary.failedTasks;
  metrics.skippedTasks += summary.skippedTasks;
  metrics.usefulTasks += summary.usefulTasks;
  if (summary.failedTasks > 0) {
    metrics.cleanStreakRuns = 0;
    metrics.cleanStreakCompletedTasks = 0;
    metrics.cleanStreakCapabilities = {};
  } else if (summary.executedTasks > 0) {
    metrics.cleanStreakRuns += 1;
    metrics.cleanStreakCompletedTasks += summary.completedTasks;
    for (const [capability, count] of Object.entries(summary.capabilities)) {
      metrics.cleanStreakCapabilities[capability] =
        Number(metrics.cleanStreakCapabilities[capability] || 0) + Number(count || 0);
    }
  }
  metrics.firstRunAt = metrics.firstRunAt || now;
  metrics.lastRunAt = now;
  metrics.lastFailureAt = summary.failedTasks > 0 ? now : metrics.lastFailureAt;
  for (const [provider, count] of Object.entries(summary.providers)) {
    metrics.providers[provider] = Number(metrics.providers[provider] || 0) + Number(count || 0);
  }
  for (const [capability, count] of Object.entries(summary.capabilities)) {
    metrics.capabilities[capability] = Number(metrics.capabilities[capability] || 0) + Number(count || 0);
  }

  state.stages[stage.id] = metrics;
  // The active stage only moves via promotion (below) or explicit migration;
  // a run recorded under a pinned/older stage must not regress global state.

  let promoted = null;
  if (isEligibleForPromotion(stage, metrics, options)) {
    const nextStage = stageFor(stage.nextStage);
    state.activeStage = nextStage.id;
    promoted = {
      from: stage.id,
      to: nextStage.id,
      at: now,
      policyVersion: POLICY_VERSION,
      evidence: {
        successfulRuns: metrics.successfulRuns,
        completedTasks: metrics.completedTasks,
        failedTasks: metrics.failedTasks,
        failureRate: failureRate(metrics),
        cleanStreakRuns: metrics.cleanStreakRuns,
        cleanStreakCompletedTasks: metrics.cleanStreakCompletedTasks,
        capabilities: metrics.capabilities,
      },
    };
    state.promotions = [...state.promotions, promoted].slice(-25);
  }

  writeVersionState(state, options);
  return {
    state: compactParallelizationVersionState(state),
    health: compactParallelizationHealth(state.health, { now }),
    repairActions: healthUpdate.repairActions,
    promoted,
    skippedReason: null,
  };
}

function compactParallelizationHealth(health = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const normalized = normalizeHealthState(health);
  const quarantines = activeQuarantines(normalized, now);
  return {
    status: Object.keys(quarantines).length ? "degraded" : "healthy",
    activeQuarantines: Object.values(quarantines),
    openRepairActions: normalized.repairActions.filter((action) => action.status === "open").slice(-10),
  };
}

function compactParallelizationVersionState(state = {}) {
  const normalized = normalizeVersionState(state);
  const activeStage = stageFor(normalized.activeStage);
  const nextStage = activeStage.nextStage ? stageFor(activeStage.nextStage) : null;
  const metrics = normalized.stages[activeStage.id] || normalizeMetricState();
  return {
    policyVersion: POLICY_VERSION,
    activeStage: activeStage.id,
    activeVersion: activeStage.planVersion,
    nextStage: nextStage?.id || null,
    nextVersion: nextStage?.planVersion || null,
    autoPromote: Boolean(activeStage.autoPromote && activeStage.nextStage),
    criteria: activeStage.promotionCriteria,
    evidence: {
      observedRuns: metrics.observedRuns,
      successfulRuns: metrics.successfulRuns,
      failedRuns: metrics.failedRuns,
      completedTasks: metrics.completedTasks,
      failedTasks: metrics.failedTasks,
      usefulTasks: metrics.usefulTasks,
      failureRate: failureRate(metrics),
      cleanStreakRuns: metrics.cleanStreakRuns,
      cleanStreakCompletedTasks: metrics.cleanStreakCompletedTasks,
      cleanStreakCapabilities: metrics.cleanStreakCapabilities,
      providers: metrics.providers,
      capabilities: metrics.capabilities,
    },
    health: compactParallelizationHealth(normalized.health),
    lastPromotion: normalized.promotions.at(-1) || null,
  };
}

const stagedPromotionPolicy = createStagedPromotionPolicy({
  policyVersion: POLICY_VERSION,
  stages: VERSION_STAGES,
  defaultStage: DEFAULT_STAGE,
  resolveStateFile,
  defaultStateFile: DEFAULT_STATE_FILE,
  stateFileEnvVar: "MYOS_PARALLELIZATION_STATE_FILE",
  stageOverrideEnvVar: "MYOS_PARALLELIZATION_VERSION",
  autoPromoteEnvVar: "MYOS_PARALLELIZATION_AUTO_PROMOTE",
  defaultState,
  normalizeState: normalizeVersionState,
  compactState: compactParallelizationVersionState,
  normalizeHealthState,
  isEligibleForPromotion: (stage, metrics, _state, options) => isEligibleForPromotion(stage, metrics, options),
  buildPromotionEvidence: (metrics) => ({
    successfulRuns: metrics.successfulRuns,
    completedTasks: metrics.completedTasks,
    failedTasks: metrics.failedTasks,
    failureRate: failureRate(metrics),
    cleanStreakRuns: metrics.cleanStreakRuns,
    cleanStreakCompletedTasks: metrics.cleanStreakCompletedTasks,
    capabilities: metrics.capabilities,
  }),
});

function normalizeStageId(value) {
  return stagedPromotionPolicy.normalizeStageId(value);
}

function stageFor(value) {
  return stagedPromotionPolicy.stageFor(value);
}

function readVersionState(options = {}) {
  return stagedPromotionPolicy.readState(options);
}

function writeVersionState(state, options = {}) {
  return stagedPromotionPolicy.writeState(state, options);
}

function getParallelizationStage(options = {}) {
  return stagedPromotionPolicy.getStage(options);
}

module.exports = {
  DEFAULT_STATE_FILE,
  POLICY_VERSION,
  VERSION_STAGES,
  classifyFailure,
  compactParallelizationHealth,
  compactParallelizationVersionState,
  getParallelizationStage,
  isEligibleForPromotion,
  isParallelizationTargetQuarantined,
  normalizeStageId,
  readVersionState,
  recordParallelizationRun,
  summarizeRunResults,
  updateParallelizationHealth,
  writeVersionState,
};
