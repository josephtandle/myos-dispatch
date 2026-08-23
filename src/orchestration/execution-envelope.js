"use strict";

const { buildIntentFidelityPolicy } = require("./intent-fidelity");
const { buildIntentHorizonPolicy } = require("./intent-horizon");

const ORCHESTRATION_VERSION = "myos-orchestration-gold-v1";

const AGENT_PROFILES = Object.freeze({
  context: Object.freeze({
    id: "myos_code_mapper",
    fallback: "explorer",
    contract: "Map the real execution surface and return evidence without editing.",
  }),
  capability: Object.freeze({
    id: "myos_code_mapper",
    fallback: "explorer",
    contract: "Inspect the existing capability and identify exact coverage and gaps.",
  }),
  scout: Object.freeze({
    id: "myos_code_mapper",
    fallback: "explorer",
    contract: "Investigate one bounded lane and return the smallest implementation path.",
  }),
  decompose: Object.freeze({
    id: "myos_lane_lead",
    fallback: "default",
    contract: "Split the request into independent lanes, dependencies, and one critical path.",
  }),
  verify: Object.freeze({
    id: "myos_test_planner",
    fallback: "explorer",
    contract: "Define or execute bounded verification without changing the implementation.",
  }),
  acceptance: Object.freeze({
    id: "myos_test_planner",
    fallback: "explorer",
    contract: "Translate the objective into binary acceptance checks and failure signals.",
  }),
  safety: Object.freeze({
    id: "myos_impact_reviewer",
    fallback: "explorer",
    contract: "Inspect blast radius, hard gates, rollback, and unsafe authority expansion.",
  }),
  docs: Object.freeze({
    id: "myos_docs_researcher",
    fallback: "explorer",
    contract: "Verify current APIs and product behavior from primary documentation.",
  }),
  implement: Object.freeze({
    id: "worker",
    fallback: "worker",
    contract: "Implement only inside the assigned isolated worktree and ownership scope.",
  }),
  review: Object.freeze({
    id: "myos_fresh_eyes",
    fallback: "explorer",
    contract: "Review the finished change independently for correctness and regressions.",
  }),
});

const SCHEDULE_RE = /\b(schedule|scheduled|recurring|every day|daily|weekly|monthly|cron|launchd|rrule|heartbeat|monitor|watchdog)\b/i;
const REUSABLE_RE = /\b(reusable|repeat|recurring|standardize|package|skill|plugin|playbook|workflow)\b/i;

function normalizeText(value) {
  if (Array.isArray(value)) return value.map(normalizeText).join(" ");
  if (value && typeof value === "object") {
    return normalizeText(value.text || value.prompt || value.command || value.query || "");
  }
  return String(value || "").replace(/\s+/g, " ").trim();
}

function roleProfileForTask(task = {}) {
  const role = String(task.role || task.kind || "context").toLowerCase();
  const writable = task.mode === "workspace_write";
  if (writable) return AGENT_PROFILES.implement;
  if (role === "acceptance") return AGENT_PROFILES.acceptance;
  if (role === "decompose") return AGENT_PROFILES.decompose;
  if (role === "safety" || role === "impact") return AGENT_PROFILES.safety;
  if (role === "verify" || role === "test") return AGENT_PROFILES.verify;
  if (role === "docs" || role === "documentation") return AGENT_PROFILES.docs;
  if (role === "capability") return AGENT_PROFILES.capability;
  if (role === "scout") return AGENT_PROFILES.scout;
  if (role === "review") return AGENT_PROFILES.review;
  return AGENT_PROFILES.context;
}

function hasExplicitGoalMutationIntent(text) {
  const normalized = normalizeText(text).toLowerCase();
  const informational = /^(?:please\s+)?(?:explain|describe|show\s+me\s+how|tell\s+me\s+how|what|why|how|should\s+i|would\s+i|could\s+i)\b/i;
  if (informational.test(normalized)) return false;
  const mutation = /\b(?:create|start|set|track|persist|make)\b.{0,48}\b(?:persisted\s+)?goal\b/i;
  if (!mutation.test(normalized)) return false;
  const negated = /\b(?:do\s+not|don't|never|without|avoid)\b.{0,64}\b(?:create|start|set|track|persist|make)\b.{0,48}\bgoal\b/i;
  return !negated.test(normalized);
}

function buildGoalPolicy(text, basePlan = {}) {
  const goalScale = Number(basePlan.goalScale || 0) || null;
  const explicit = hasExplicitGoalMutationIntent(text);
  return {
    goalScale,
    goalMode: basePlan.goalMode || null,
    persistedGoalMutation: explicit ? "explicit_only" : "forbidden",
    persistenceOwner: goalScale === 4 ? "omx" : explicit ? "codex" : "none",
    continuationOwner: explicit ? "codex" : goalScale >= 3 ? "myos_ralph" : "none",
    sidecarsMayMutateRootGoal: false,
    tokenBudgetSource: "user_explicit_only",
    requiresVerificationBeforeComplete: goalScale >= 3,
    stopRules: Array.isArray(basePlan.stopRules) ? basePlan.stopRules : [],
  };
}

function buildExecutionEnvelope(input, basePlan = {}, options = {}) {
  const text = normalizeText(input);
  const env = options.env || process.env;
  const disabled = String(env.MYOS_ORCHESTRATION_GOLD_ENABLED ?? "1") === "0";
  const unattended = String(env.MYOS_INITIATOR || "").toLowerCase() === "unattended";
  const scheduleIntent = SCHEDULE_RE.test(text) || unattended;
  const actionType = String(basePlan.actionType || "read").toLowerCase();
  const blockedReasons = Array.isArray(options.blockedReasons) ? options.blockedReasons : [];
  const goalBlockedReasons = Array.isArray(basePlan.blockedBy) ? basePlan.blockedBy : [];
  const allBlockedReasons = [...new Set([...blockedReasons, ...goalBlockedReasons])];
  const writeRequested = actionType === "write";
  const reusable = REUSABLE_RE.test(text) || scheduleIntent;
  const featureEnabled = (key) => !disabled && String(env[key] ?? "1") !== "0";
  const intentHorizon = buildIntentHorizonPolicy({
    goalScale: basePlan.goalScale,
    actionType,
    trustClass: scheduleIntent ? "scheduled_read" : "interactive",
    taskClass: basePlan.taskClass || options.taskClass,
    blockedBy: allBlockedReasons,
    maxWallTimeMs: options.maxWallTimeMs,
    maxContinuationAttempts: options.maxContinuationAttempts,
  }, { env });
  const intentFidelity = buildIntentFidelityPolicy({
    text,
    trustClass: scheduleIntent ? "scheduled_read" : "interactive",
    taskClass: basePlan.taskClass || options.taskClass,
    blockedBy: allBlockedReasons,
  }, { env });

  return {
    version: ORCHESTRATION_VERSION,
    level: "gold",
    enabled: !disabled,
    trustClass: scheduleIntent ? "scheduled_read" : "interactive",
    sideEffectClass: writeRequested ? "patch_only" : "none",
    approvalMode: scheduleIntent ? "never_inside_deny_by_default_envelope" : "inherit_parent",
    hardGates: {
      blockedReasons: [...new Set(blockedReasons)],
      authorityCanOnlyDecrease: true,
      protectedSurfaceRequired: true,
      browserPreflightRequired: true,
      externalMutationRequiresHumanTurn: true,
    },
    features: {
      scheduledTasks: {
        selected: scheduleIntent && featureEnabled("MYOS_SCHEDULED_DISPATCH_ENABLED"),
        maturity: "canary",
        mode: "report_or_propose_only",
        mutationAllowed: false,
        manualTrialRequired: true,
        sourceOfTruth: "versioned_schedule_spec",
        killSwitch: "MYOS_SCHEDULED_DISPATCH_ENABLED=0",
      },
      customAgents: {
        selected: featureEnabled("MYOS_BACKGROUND_AGENTS_ENABLED"),
        maturity: "gold_contract_advisory_native_binding",
        nativeThreadsReadOnlyOnly: true,
        writableOwner: "isolated_sidecar_runner",
        roleRegistry: Object.keys(AGENT_PROFILES),
        killSwitch: "MYOS_BACKGROUND_AGENTS_ENABLED=0",
      },
      goalMode: buildGoalPolicy(text, basePlan),
      intentFidelity,
      intentHorizon,
      skillsAndPlugins: {
        selected: reusable && featureEnabled("MYOS_CODEX_PLUGIN_ROUTING_ENABLED"),
        maturity: "gold_inventory_canary_execution",
        routingAuthority: "myos_capability_index",
        installedPluginMetadataIsAdvisory: true,
        preferExistingCapability: true,
        packageRepeatedWorkAs: reusable ? "skill_or_plugin" : "none",
        pluginHooksMayNotWeakenHardGates: true,
        killSwitch: "MYOS_CODEX_PLUGIN_ROUTING_ENABLED=0",
      },
      worktrees: {
        selected: writeRequested && featureEnabled("MYOS_WRITABLE_SIDECARS_ENABLED"),
        maturity: "gold_contract_canary_execution",
        isolation: "detached_ephemeral",
        oneWriterPerOwnershipPath: true,
        nativeThreadWritesAllowed: false,
        durablePatchRequired: true,
        sharedCheckoutMustRemainUnchanged: true,
        applyPolicy: "review_only",
        killSwitch: "MYOS_WRITABLE_SIDECARS_ENABLED=0",
      },
    },
    filesystemProfile: writeRequested ? "isolated_git_worktree" : "read_only",
    networkPolicy: "disabled_unless_manifest_allowlisted",
    pluginAndConnectorAllowlist: [],
    goalBudget: {
      maxWallTimeMs: Number(options.maxWallTimeMs || 15 * 60 * 1000),
      maxContinuationAttempts: Number(options.maxContinuationAttempts || 8),
      permissionEscalationAllowed: false,
    },
    artifactPolicy: {
      persistOutsideEphemeralWorktree: true,
      hashRequired: true,
      ownershipValidationRequired: true,
    },
    rollbackPolicy: {
      failClosed: true,
      independentFeatureKillSwitches: true,
      autoPauseOnHardGateViolation: true,
    },
  };
}

function buildTaskExecutionEnvelope(baseEnvelope = {}, task = {}) {
  const profile = roleProfileForTask(task);
  const writable = task.mode === "workspace_write";
  const scheduled = baseEnvelope.trustClass === "scheduled_read";
  return {
    version: baseEnvelope.version || ORCHESTRATION_VERSION,
    trustClass: scheduled ? "scheduled_read" : writable ? "sidecar_worktree" : "sidecar_read",
    filesystemProfile: writable ? "isolated_git_worktree" : "read_only",
    networkPolicy: "disabled",
    pluginAndConnectorAllowlist: [],
    sideEffectClass: writable ? "patch_only" : "none",
    approvalMode: "never_inside_deny_by_default_envelope",
    agentProfile: profile.id,
    fallbackAgentProfile: profile.fallback,
    roleContract: profile.contract,
    goalMutationAllowed: false,
    authorityCanOnlyDecrease: true,
  };
}

function compactExecutionEnvelope(envelope = {}) {
  return {
    version: envelope.version || ORCHESTRATION_VERSION,
    level: envelope.level || "gold",
    enabled: envelope.enabled !== false,
    trustClass: envelope.trustClass || "interactive",
    sideEffectClass: envelope.sideEffectClass || "none",
    filesystemProfile: envelope.filesystemProfile || "read_only",
    networkPolicy: envelope.networkPolicy || "disabled",
    features: envelope.features || {},
    hardGates: envelope.hardGates || {},
    rollbackPolicy: envelope.rollbackPolicy || {},
  };
}

module.exports = {
  AGENT_PROFILES,
  ORCHESTRATION_VERSION,
  buildExecutionEnvelope,
  buildGoalPolicy,
  buildTaskExecutionEnvelope,
  compactExecutionEnvelope,
  hasExplicitGoalMutationIntent,
  roleProfileForTask,
};
