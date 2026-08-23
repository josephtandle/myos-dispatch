"use strict";

function buildIntentHorizonPolicy(input = {}, options = {}) {
  const env = options.env || process.env;
  const goalScale = Number(input.goalScale || 0);
  const missingTaskClass = !String(input.taskClass || "").trim();
  const blockedBy = Array.isArray(input.blockedBy) ? [...new Set(input.blockedBy)] : [];
  const hardGated = blockedBy.length > 0;
  const enabled = String(env.MYOS_INTENT_HORIZON_ENABLED ?? "1") !== "0"
    && input.trustClass === "interactive"
    && input.actionType === "write"
    && !missingTaskClass
    && !hardGated
    && goalScale >= 3;

  const scaleFour = goalScale >= 4;
  return {
    version: "intent-horizon-v1",
    taskClass: missingTaskClass ? null : String(input.taskClass).trim(),
    enabled,
    stopReason: hardGated ? "hard_gate" : missingTaskClass ? "missing_task_class" : null,
    blockedBy,
    budget: {
      maxContinuationAttempts: Number(input.maxContinuationAttempts || 8),
      maxWallTimeMs: Number(input.maxWallTimeMs || 15 * 60 * 1000),
    },
    sweep: {
      required: enabled,
      maxCandidates: scaleFour ? 8 : 4,
      maxAutoApply: scaleFour ? 4 : 2,
      maxCausalDepth: 2,
      maxRuns: 1,
    },
    ledger: {
      itemTypes: ["required", "verification", "repair", "upgrade"],
      statuses: ["pending", "active", "completed", "blocked", "declined"],
    },
    scoring: {
      minimumQualifiedScore: 7,
      maximumScore: 10,
      dimensions: {
        intentImpact: 3,
        evidenceStrength: 2,
        verificationStrength: 2,
        scopeFit: 2,
        reversibility: 1,
      },
    },
    verification: {
      acceptedTypes: [...BINARY_VERIFICATION_TYPES].sort(),
      required: true,
    },
    exploration: {
      surfaces: [
        "call_graph",
        "tests",
        "config",
        "docs",
        "error_handling",
        "security",
        "performance",
        "user_visible_behavior",
      ],
      routedProjectOnly: true,
    },
    constraints: {
      isolatedWorktreeRequired: true,
      plannedFileAllowlistRequired: true,
      upgradesMaySpawnSweep: false,
    },
    hardStops: [
      "auth_required",
      "destructive_action",
      "live_production_mutation",
      "external_send",
      "material_ambiguity",
      "protected_surface",
    ],
  };
}

const BINARY_VERIFICATION_TYPES = new Set([
  "artifact_assertion",
  "behavior_probe",
  "build_exit_zero",
  "lint_exit_zero",
  "test_exit_zero",
]);

const BLOCKER_REASON_MAP = Object.freeze({
  auth_sensitive: "auth_required",
  interactive_auth_action: "auth_required",
  destructive_or_approval_sensitive: "destructive_action",
  user_visible_send: "external_send",
  payment_or_account_mutation: "new_authority_required",
  protected_surface_write: "protected_surface",
});

function boundedScore(value, max) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(score)));
}

function evaluateUpgradeCandidate(candidate = {}) {
  const reasons = [];
  if (candidate.requiresNewAuthority) reasons.push("new_authority_required");
  if (candidate.requiresAuth) reasons.push("auth_required");
  if (candidate.destructiveAction) reasons.push("destructive_action");
  if (candidate.externalSend) reasons.push("external_send");
  if (candidate.materialAmbiguity) reasons.push("material_ambiguity");
  if (candidate.liveProductionMutation) reasons.push("live_production_mutation");
  if (candidate.protectedSurface) reasons.push("protected_surface");
  if (candidate.newDependency && !candidate.dependencyAuditPassed) reasons.push("dependency_audit_required");
  if (candidate.newDependency && !candidate.dependencyRollbackDefined) reasons.push("dependency_rollback_required");
  if (!candidate.ownershipPathMatch) reasons.push("outside_ownership");
  if (!candidate.reversible) reasons.push("not_reversible");
  if (Number(candidate.causalDepth) > 2) reasons.push("causal_depth_exceeded");
  if (!BINARY_VERIFICATION_TYPES.has(candidate.verificationType)) reasons.push("missing_binary_verification");
  for (const blocker of Array.isArray(candidate.blockedBy) ? candidate.blockedBy : []) {
    reasons.push(BLOCKER_REASON_MAP[blocker] || "hard_gate");
  }

  const score = boundedScore(candidate.intentImpact, 3)
    + boundedScore(candidate.evidenceStrength, 2)
    + boundedScore(candidate.verificationStrength, 2)
    + boundedScore(candidate.scopeFit, 2)
    + (candidate.reversible ? 1 : 0);
  if (score < 7) reasons.push("score_below_threshold");

  return {
    qualified: reasons.length === 0,
    score,
    reasons: [...new Set(reasons)],
  };
}

function decideIntentHorizonContinuation(state = {}) {
  const policy = state.policy || {};
  if (!policy.enabled) {
    return { continue: false, reason: policy.stopReason || "intent_horizon_disabled" };
  }
  const ledger = Array.isArray(state.ledger) ? state.ledger : [];
  const incompleteItems = ledger.filter((item) => ["pending", "active"].includes(item && item.status));
  if (
    Number(state.attempts || 0) >= Number(policy.budget.maxContinuationAttempts)
    || Number(state.elapsedMs || 0) >= Number(policy.budget.maxWallTimeMs)
  ) {
    return {
      continue: false,
      reason: "budget_exhausted",
      incompleteItemIds: incompleteItems.map((item) => item.id).filter(Boolean),
    };
  }
  const pendingCore = incompleteItems.find((item) =>
    ["required", "verification", "repair"].includes(item && item.type)
    && ["pending", "active"].includes(item && item.status)
  );
  if (pendingCore) {
    return { continue: true, reason: "pending_core_work", itemId: pendingCore.id || null };
  }
  if (Number(state.sweepRuns || 0) < policy.sweep.maxRuns) {
    return { continue: true, reason: "exploratory_sweep_required" };
  }
  return { continue: false, reason: "done_verified" };
}

function selectUpgradeCandidates(candidates, policy = {}) {
  if (!policy.enabled || !Array.isArray(candidates)) return [];
  return candidates
    .slice(0, policy.sweep.maxCandidates)
    .map((candidate, index) => ({ candidate, index, evaluation: evaluateUpgradeCandidate(candidate) }))
    .filter((entry) => entry.evaluation.qualified)
    .sort((left, right) => right.evaluation.score - left.evaluation.score || left.index - right.index)
    .slice(0, policy.sweep.maxAutoApply)
    .map((entry) => ({ ...entry.candidate, intentHorizonScore: entry.evaluation.score }));
}

function classifyIntentHorizonHealthEvent(state = {}) {
  const ledger = Array.isArray(state.ledger) ? state.ledger : [];
  const pendingCore = ledger.filter((item) =>
    ["required", "verification", "repair"].includes(item && item.type)
    && ["pending", "active"].includes(item && item.status)
  );
  if (state.terminalReason === "done_verified" && pendingCore.length > 0) {
    return {
      type: "intent_horizon_diagnosis_only_completion",
      severity: "error",
      itemIds: pendingCore.map((item) => item.id).filter(Boolean),
    };
  }

  const skippedQualifiedUpgrades = ledger.filter((item) =>
    item && item.type === "upgrade"
    && item.qualified === true
    && ["pending", "active"].includes(item.status)
  );
  if (
    state.terminalReason === "done_verified"
    && Number(state.sweepRuns || 0) > 0
    && skippedQualifiedUpgrades.length > 0
  ) {
    return {
      type: "intent_horizon_qualified_upgrade_skipped",
      severity: "warning",
      itemIds: skippedQualifiedUpgrades.map((item) => item.id).filter(Boolean),
    };
  }

  if (state.terminalReason === "budget_exhausted") {
    const incomplete = ledger.filter((item) => ["pending", "active"].includes(item && item.status));
    return {
      type: "intent_horizon_budget_exhausted",
      severity: "warning",
      itemIds: incomplete.map((item) => item.id).filter(Boolean),
    };
  }

  return null;
}

module.exports = {
  buildIntentHorizonPolicy,
  classifyIntentHorizonHealthEvent,
  decideIntentHorizonContinuation,
  evaluateUpgradeCandidate,
  selectUpgradeCandidates,
};
