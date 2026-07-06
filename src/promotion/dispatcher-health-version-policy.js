"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createStagedPromotionPolicy } = require("./staged-promotion-policy");
const { resolveWorkspacePath } = require("../myos-compat");

const POLICY_VERSION = "myos-dispatcher-health-self-promotion-v1";
const DEFAULT_STAGE = "v1";
const DEFAULT_STATE_FILE = resolveWorkspacePath("agents", "shared", "data", "dispatcher-health-state.json");

const VERSION_STAGES = Object.freeze([
  Object.freeze({
    id: "v1",
    planVersion: "myos-dispatcher-health-v1",
    label: "observe, repair actions, and safe quarantines",
    nextStage: "v2",
    autoPromote: true,
    capabilities: Object.freeze({
      observe: true,
      repairActions: true,
      safeQuarantine: true,
      lowRiskAutoRepair: false,
    }),
    promotionCriteria: Object.freeze({
      minObservedEvents: 20,
      minRepairActionsCreated: 5,
      minValidatedRepairs: 3,
      maxUnsafeQuarantineIncidents: 0,
      maxRollbackRequiredRepairs: 0,
      requireNoProtectedActiveQuarantines: true,
    }),
  }),
  Object.freeze({
    id: "v2",
    planVersion: "myos-dispatcher-health-v2",
    label: "allowlisted low-risk auto-repair",
    nextStage: "v3",
    autoPromote: false,
    capabilities: Object.freeze({
      observe: true,
      repairActions: true,
      safeQuarantine: true,
      lowRiskAutoRepair: "allowlisted_only",
    }),
    promotionCriteria: null,
  }),
  Object.freeze({
    id: "v3",
    planVersion: "myos-dispatcher-health-v3",
    label: "reserved",
    nextStage: null,
    autoPromote: false,
    capabilities: Object.freeze({
      observe: true,
      repairActions: true,
      safeQuarantine: true,
      lowRiskAutoRepair: "reserved",
    }),
    promotionCriteria: null,
  }),
]);

function defaultMetricState() {
  return {
    observedEvents: 0,
    repairActionsCreated: 0,
    repairActionsResolved: 0,
    validatedRepairs: 0,
    unsafeQuarantineIncidents: 0,
    rollbackRequiredRepairs: 0,
    successfulFallbacks: 0,
    eventTypes: {},
    repairKinds: {},
    firstEventAt: null,
    lastEventAt: null,
  };
}

function defaultHealthState() {
  return {
    failures: {},
    quarantines: {},
    repairActions: [],
    autoRepairs: [],
    unsafeIncidents: [],
  };
}

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
  return options.stateFile || process.env.MYOS_DISPATCH_HEALTH_STATE_FILE || DEFAULT_STATE_FILE;
}

function normalizeCounterMap(value = {}) {
  const out = {};
  for (const [key, count] of Object.entries(value || {})) {
    out[key] = Number(count || 0);
  }
  return out;
}

function normalizeMetricState(metrics = {}) {
  return {
    observedEvents: Number(metrics.observedEvents || 0),
    repairActionsCreated: Number(metrics.repairActionsCreated || 0),
    repairActionsResolved: Number(metrics.repairActionsResolved || 0),
    validatedRepairs: Number(metrics.validatedRepairs || 0),
    unsafeQuarantineIncidents: Number(metrics.unsafeQuarantineIncidents || 0),
    rollbackRequiredRepairs: Number(metrics.rollbackRequiredRepairs || 0),
    successfulFallbacks: Number(metrics.successfulFallbacks || 0),
    eventTypes: normalizeCounterMap(metrics.eventTypes),
    repairKinds: normalizeCounterMap(metrics.repairKinds),
    firstEventAt: metrics.firstEventAt || null,
    lastEventAt: metrics.lastEventAt || null,
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
      protected: Boolean(value.protected),
    };
  }

  const quarantines = {};
  for (const [key, value] of Object.entries(health.quarantines || {})) {
    quarantines[key] = {
      key,
      type: value.type || key.split(":")[0] || "unknown",
      value: value.value || key.split(":").slice(1).join(":") || "",
      reason: value.reason || "repeated_dispatch_health_failure",
      createdAt: value.createdAt || null,
      until: value.until || null,
      repairActionId: value.repairActionId || null,
      protected: Boolean(value.protected),
    };
  }

  return {
    failures,
    quarantines,
    repairActions: Array.isArray(health.repairActions) ? health.repairActions.slice(-100) : [],
    autoRepairs: Array.isArray(health.autoRepairs) ? health.autoRepairs.slice(-50) : [],
    unsafeIncidents: Array.isArray(health.unsafeIncidents) ? health.unsafeIncidents.slice(-50) : [],
  };
}

function normalizeDispatcherHealthState(value = {}) {
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

function parseTime(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function isExpired(value, now) {
  if (!value?.until) return false;
  return parseTime(value.until) <= parseTime(now || new Date().toISOString());
}

function activeQuarantines(health = {}, now = new Date().toISOString()) {
  return stagedPromotionPolicy.activeQuarantines(health, now);
}

function getCriteria(stage, options = {}) {
  const override = options.criteriaOverrides?.[stage.id] || {};
  return {
    ...(stage.promotionCriteria || {}),
    ...override,
  };
}

function isEligibleForDispatcherHealthPromotion(stage, metrics, state, options = {}) {
  if (!stage?.nextStage || !stage.autoPromote) return false;
  const criteria = getCriteria(stage, options);
  if (criteria.requireNoProtectedActiveQuarantines && hasProtectedActiveQuarantine(state.health, options.now)) {
    return false;
  }
  return (
    Number(metrics.observedEvents || 0) >= Number(criteria.minObservedEvents || 0) &&
    Number(metrics.repairActionsCreated || 0) >= Number(criteria.minRepairActionsCreated || 0) &&
    Number(metrics.validatedRepairs || 0) >= Number(criteria.minValidatedRepairs || 0) &&
    Number(metrics.unsafeQuarantineIncidents || 0) <= Number(criteria.maxUnsafeQuarantineIncidents || 0) &&
    Number(metrics.rollbackRequiredRepairs || 0) <= Number(criteria.maxRollbackRequiredRepairs || 0)
  );
}

function applyDispatcherHealthMetricEvent(state, metricEvent = {}, options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date().toISOString();
  const normalized = normalizeDispatcherHealthState(state);
  const stage = stageFor(normalized.activeStage);
  const metrics = normalizeMetricState(normalized.stages[stage.id]);

  if (metricEvent.observed !== false) {
    metrics.observedEvents += Number(metricEvent.observedEvents || 1);
    const type = String(metricEvent.eventType || "unknown");
    metrics.eventTypes[type] = Number(metrics.eventTypes[type] || 0) + 1;
  }
  if (metricEvent.repairActionCreated) {
    const count = Number(metricEvent.repairActionCreated || 0);
    metrics.repairActionsCreated += count;
    const kind = String(metricEvent.repairKind || "unknown");
    metrics.repairKinds[kind] = Number(metrics.repairKinds[kind] || 0) + count;
  }
  if (metricEvent.repairActionResolved) metrics.repairActionsResolved += Number(metricEvent.repairActionResolved || 0);
  if (metricEvent.validatedRepair) metrics.validatedRepairs += Number(metricEvent.validatedRepair || 0);
  if (metricEvent.unsafeQuarantineIncident) metrics.unsafeQuarantineIncidents += Number(metricEvent.unsafeQuarantineIncident || 0);
  if (metricEvent.rollbackRequiredRepair) metrics.rollbackRequiredRepairs += Number(metricEvent.rollbackRequiredRepair || 0);
  if (metricEvent.successfulFallback) metrics.successfulFallbacks += Number(metricEvent.successfulFallback || 0);
  metrics.firstEventAt = metrics.firstEventAt || now;
  metrics.lastEventAt = now;

  normalized.stages[stage.id] = metrics;
  normalized.activeStage = stage.id;
  normalized.updatedAt = now;

  let promoted = null;
  if (env.MYOS_DISPATCH_HEALTH_AUTO_PROMOTE === "0" || options.enabled === false) {
    return { state: normalized, promoted, skippedReason: "auto_promotion_disabled" };
  }

  if (isEligibleForDispatcherHealthPromotion(stage, metrics, normalized, { ...options, now })) {
    const nextStage = stageFor(stage.nextStage);
    normalized.activeStage = nextStage.id;
    promoted = {
      from: stage.id,
      to: nextStage.id,
      at: now,
      policyVersion: POLICY_VERSION,
      evidence: {
        observedEvents: metrics.observedEvents,
        repairActionsCreated: metrics.repairActionsCreated,
        validatedRepairs: metrics.validatedRepairs,
        unsafeQuarantineIncidents: metrics.unsafeQuarantineIncidents,
        rollbackRequiredRepairs: metrics.rollbackRequiredRepairs,
      },
    };
    normalized.promotions = [...normalized.promotions, promoted].slice(-25);
  }

  return { state: normalized, promoted, skippedReason: null };
}

function compactDispatcherHealthVersionState(state = {}) {
  const normalized = normalizeDispatcherHealthState(state);
  const activeStage = stageFor(normalized.activeStage);
  const nextStage = activeStage.nextStage ? stageFor(activeStage.nextStage) : null;
  const metrics = normalizeMetricState(normalized.stages[activeStage.id]);
  return {
    policyVersion: POLICY_VERSION,
    activeStage: activeStage.id,
    activeVersion: activeStage.planVersion,
    nextStage: nextStage?.id || null,
    nextVersion: nextStage?.planVersion || null,
    autoPromote: Boolean(activeStage.autoPromote && activeStage.nextStage),
    capabilities: activeStage.capabilities,
    criteria: activeStage.promotionCriteria,
    evidence: metrics,
    activeQuarantineCount: Object.keys(activeQuarantines(normalized.health)).length,
    protectedActiveQuarantine: hasProtectedActiveQuarantine(normalized.health),
    lastPromotion: normalized.promotions.at(-1) || null,
  };
}

const stagedPromotionPolicy = createStagedPromotionPolicy({
  policyVersion: POLICY_VERSION,
  stages: VERSION_STAGES,
  defaultStage: DEFAULT_STAGE,
  resolveStateFile,
  defaultStateFile: DEFAULT_STATE_FILE,
  stateFileEnvVar: "MYOS_DISPATCH_HEALTH_STATE_FILE",
  stageOverrideEnvVar: "MYOS_DISPATCH_HEALTH_VERSION",
  autoPromoteEnvVar: "MYOS_DISPATCH_HEALTH_AUTO_PROMOTE",
  defaultState,
  normalizeState: normalizeDispatcherHealthState,
  compactState: compactDispatcherHealthVersionState,
  normalizeHealthState,
  isEligibleForPromotion: (stage, metrics, state, options) =>
    isEligibleForDispatcherHealthPromotion(stage, metrics, state, options),
  buildPromotionEvidence: (metrics) => ({
    observedEvents: metrics.observedEvents,
    repairActionsCreated: metrics.repairActionsCreated,
    validatedRepairs: metrics.validatedRepairs,
    unsafeQuarantineIncidents: metrics.unsafeQuarantineIncidents,
    rollbackRequiredRepairs: metrics.rollbackRequiredRepairs,
  }),
});

function normalizeStageId(value) {
  return stagedPromotionPolicy.normalizeStageId(value);
}

function stageFor(value) {
  return stagedPromotionPolicy.stageFor(value);
}

function readDispatcherHealthState(options = {}) {
  return stagedPromotionPolicy.readState(options);
}

function writeDispatcherHealthState(state, options = {}) {
  return stagedPromotionPolicy.writeState(state, options);
}

function getDispatcherHealthStage(options = {}) {
  return stagedPromotionPolicy.getStage(options);
}

function hasProtectedActiveQuarantine(health = {}, now = new Date().toISOString()) {
  return stagedPromotionPolicy.hasProtectedActiveQuarantine(health, now);
}

module.exports = {
  DEFAULT_STATE_FILE,
  POLICY_VERSION,
  VERSION_STAGES,
  activeQuarantines,
  applyDispatcherHealthMetricEvent,
  compactDispatcherHealthVersionState,
  defaultHealthState,
  getDispatcherHealthStage,
  isEligibleForDispatcherHealthPromotion,
  normalizeDispatcherHealthState,
  normalizeStageId,
  readDispatcherHealthState,
  stageFor,
  writeDispatcherHealthState,
};
