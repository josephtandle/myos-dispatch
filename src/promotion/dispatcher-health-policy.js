"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveWorkspacePath } = require("../myos-compat");
const { getDataSourceFastpathTemplate } = require("../data-source-registry");
const {
  DEFAULT_STATE_FILE,
  activeQuarantines,
  applyDispatcherHealthMetricEvent,
  compactDispatcherHealthVersionState,
  getDispatcherHealthStage,
  normalizeDispatcherHealthState,
  readDispatcherHealthState,
  writeDispatcherHealthState,
} = require("./dispatcher-health-version-policy");
const {
  auditFastpathsDoc,
  getFastpathWriteBlockers,
  readJson,
  writeFastpathsWithSnapshot,
} = require("../fastpath-store");

const WORKSPACE_ROOT = resolveWorkspacePath();
const FASTPATHS_FILE = resolveWorkspacePath("DISPATCH-FASTPATHS.json");
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_QUARANTINE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_HIGH_LATENCY_MS = 60_000;
const DEFAULT_HIGH_COST_USD = 0.25;
const REPAIR_ACTION_LIMIT = 100;
const AUTO_REPAIR_LIMIT = 50;

const DEFAULT_PROTECTED_SURFACE_POLICY = Object.freeze({
  lanes: Object.freeze(["user_visible", "protected"]),
  intents: Object.freeze(["auth_user_visible", "mailto", "open_in_user_browser"]),
  keywords: Object.freeze([
    "auth",
    "oauth",
    "login",
    "password",
    "credential",
    "api key",
    "apikey",
    "stripe",
    "payment",
    "checkout",
    "billing",
    "protected surface",
    "user-visible browser",
  ]),
});
const USER_CORRECTION_RE = /\b(mistake|not right|should always|never make this mistake|you missed|you forgot|why did you|wrong database|right database|should not happen|log that mistake)\b/i;
const SAFE_AUTO_QUARANTINE_TYPES = new Set(["recipe", "provider", "taskClass", "dataLookup"]);
const AUTO_REPAIR_KINDS = new Set(["route_correction", "data_lookup_miss", "data_lookup_skipped"]);
const FASTPATH_ROUTE_FIELDS = [
  "recipe_path",
  "handler_path",
  "project_path",
  "reference_path",
  "data_path",
  "route_hint",
  "capability_id",
  "tool_hint",
];
function healthKey(type, value) {
  return `${type}:${String(value || "unknown").toLowerCase()}`;
}

function safeSlug(value) {
  return String(value || "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "unknown";
}

function resolveState(options = {}) {
  return normalizeDispatcherHealthState(options.state || readDispatcherHealthState(options));
}

function normalizeStringList(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
    : [];
}

function protectedSurfacePolicy(options = {}) {
  const override = options.protectedSurfacePolicy && typeof options.protectedSurfacePolicy === "object"
    ? options.protectedSurfacePolicy
    : {};
  return {
    lanes: new Set([
      ...DEFAULT_PROTECTED_SURFACE_POLICY.lanes,
      ...normalizeStringList(override.lanes),
    ]),
    intents: new Set([
      ...DEFAULT_PROTECTED_SURFACE_POLICY.intents,
      ...normalizeStringList(override.intents),
    ]),
    keywords: [
      ...DEFAULT_PROTECTED_SURFACE_POLICY.keywords,
      ...normalizeStringList(override.keywords),
    ],
  };
}

function protectedKeywordRegex(options = {}) {
  const keywords = protectedSurfacePolicy(options).keywords
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return keywords.length > 0 ? new RegExp(`\\b(${keywords.join("|")})\\b`, "i") : /$a/;
}

function isProtectedEvent(event = {}, options = {}) {
  const policy = protectedSurfacePolicy(options);
  if (policy.lanes.has(String(event.lane || "").toLowerCase()) || policy.intents.has(String(event.intent || "").toLowerCase())) {
    return true;
  }
  const text = [
    event.kind,
    event.reason,
    event.targetType,
    event.targetValue,
    event.text,
    event.intent,
    event.lane,
    event.action,
    event.denialReason,
  ].filter(Boolean).join(" ");
  return protectedKeywordRegex(options).test(text) || event.protected === true;
}

function targetFromParts(type, value) {
  return {
    type: type || "unknown",
    value: String(value || "unknown"),
  };
}

function classifyDispatcherOutcome(event = {}, options = {}) {
  const outcome = event.outcome || {};
  const text = String(event.text || event.dispatchText || "");

  if (USER_CORRECTION_RE.test(text)) {
    return {
      kind: "route_correction",
      reason: "user_reported_dispatch_mistake",
      target: targetFromParts("route", event.inferredProject || event.caller || "general"),
      immediateRepair: true,
      protected: isProtectedEvent({ ...event, kind: "route_correction" }, options),
      evidence: {
        text: text.slice(0, 500),
        outcomeType: outcome.type || null,
        inferredProject: event.inferredProject || null,
      },
    };
  }

  if (outcome.type === "error") {
    const recipeId = outcome.recipeId || outcome.fallbackFromRecipeId || null;
    return {
      kind: recipeId ? "recipe_failure" : "route_failure",
      reason: outcome.errorCode || "dispatch_error",
      target: recipeId
        ? targetFromParts("recipe", recipeId)
        : targetFromParts("route", event.route?.lane || event.inferredProject || "unknown"),
      safeFallbackAvailable: Boolean(event.safeFallbackAvailable || outcome.safeFallbackAvailable),
      protected: isProtectedEvent({ ...event, kind: "dispatch_error", reason: outcome.errorCode }, options),
      evidence: {
        errorMessage: String(outcome.errorMessage || "").slice(0, 500),
        candidates: event.candidates || [],
      },
    };
  }

  if (outcome.type === "data_lookup" && (outcome.empty === true || Number(outcome.dataSectionCount || 0) === 0)) {
    return {
      kind: "data_lookup_miss",
      reason: outcome.emptyReason || "empty_data_lookup",
      target: targetFromParts("dataLookup", (outcome.dataSources || []).join(",") || "unknown"),
      protected: isProtectedEvent({ ...event, kind: "data_lookup_miss" }, options),
      evidence: {
        dataSources: outcome.dataSources || [],
        searchScope: outcome.searchScope || null,
        text: text.slice(0, 500),
      },
    };
  }

  if (outcome.type === "data_lookup_skipped") {
    return {
      kind: "data_lookup_skipped",
      reason: outcome.fallbackReason || "data_lookup_skipped",
      target: targetFromParts("dataLookup", (outcome.dataSources || []).join(",") || outcome.routeLane || "unknown"),
      protected: isProtectedEvent({ ...event, kind: "data_lookup_skipped" }, options),
      evidence: {
        routeLane: outcome.routeLane || null,
        dataSources: outcome.dataSources || [],
        text: text.slice(0, 500),
      },
    };
  }

  if (outcome.type === "worker" && outcome.fallbackFromRecipeId) {
    return {
      kind: "recipe_fallback_success",
      reason: "worker_fallback_succeeded",
      target: targetFromParts("recipe", outcome.fallbackFromRecipeId),
      success: true,
      successfulFallback: true,
      evidence: {
        fallbackFromRecipeId: outcome.fallbackFromRecipeId,
        artifactCount: outcome.artifactCount || 0,
      },
    };
  }

  if (["recipe", "worker", "workflow", "data_lookup"].includes(outcome.type)) {
    const recipeId = outcome.recipeId || outcome.workflowId || null;
    return {
      kind: "dispatch_success",
      reason: outcome.type,
      target: recipeId ? targetFromParts("recipe", recipeId) : targetFromParts("route", outcome.type),
      success: true,
      evidence: {
        outcomeType: outcome.type,
        artifactCount: outcome.artifactCount || 0,
      },
    };
  }

  return {
    kind: "dispatcher_event",
    reason: outcome.type || "observed",
    target: targetFromParts("route", event.inferredProject || event.caller || "unknown"),
    success: true,
    evidence: {
      outcomeType: outcome.type || null,
    },
  };
}

function classifyBrowserEvent(event = {}, options = {}) {
  if (event.result !== "denied") {
    return {
      kind: "browser_route_success",
      reason: event.action || "allowed",
      target: targetFromParts("browser", `${event.intent || "unknown"}:${event.lane || "unknown"}`),
      success: true,
      evidence: {
        action: event.action || null,
        lane: event.lane || null,
      },
    };
  }

  return {
    kind: "browser_lane_denial",
    reason: event.denialReason || "browser_denied",
    target: targetFromParts("browser", `${event.intent || "unknown"}:${event.lane || "unknown"}`),
    protected: isProtectedEvent({ ...event, kind: "browser_lane_denial" }, options),
    immediateRepair: false,
    evidence: {
      action: event.action || null,
      lane: event.lane || null,
      intent: event.intent || null,
      url: event.url || null,
    },
  };
}

function classifyUsageEvent(event = {}, options = {}) {
  const latencyMs = Number(event.totalLatencyMs || event.latencyMs || 0);
  const costUsd = Number(event.estimatedCostUsd || 0);
  const fallbackIndex = Number(event.fallbackIndex || 0);
  const targetValue = event.resolvedProviderOrTool || event.resolvedModelOrEngine || event.taskClass || "unknown";
  const targetType = event.resolvedProviderOrTool ? "provider" : event.taskClass ? "taskClass" : "usage";

  if (event.outcome && event.outcome !== "success") {
    return {
      kind: "usage_failure",
      reason: event.issueType || event.outcome || "usage_failure",
      target: targetFromParts(targetType, targetValue),
      protected: isProtectedEvent({ ...event, kind: "usage_failure" }, options),
      evidence: {
        taskClass: event.taskClass || null,
        model: event.resolvedModelOrEngine || null,
        provider: event.resolvedProviderOrTool || null,
        attempts: Array.isArray(event.attempts) ? event.attempts.length : 0,
      },
    };
  }

  if (fallbackIndex > 0) {
    return {
      kind: "usage_fallback",
      reason: "provider_or_model_fallback",
      target: targetFromParts(targetType, targetValue),
      protected: isProtectedEvent({ ...event, kind: "usage_fallback" }, options),
      evidence: {
        fallbackIndex,
        taskClass: event.taskClass || null,
        model: event.resolvedModelOrEngine || null,
        provider: event.resolvedProviderOrTool || null,
      },
    };
  }

  if (
    latencyMs > Number(options.highLatencyMs || DEFAULT_HIGH_LATENCY_MS) ||
    costUsd > Number(options.highCostUsd || DEFAULT_HIGH_COST_USD)
  ) {
    return {
      kind: "cost_latency_outlier",
      reason: latencyMs > Number(options.highLatencyMs || DEFAULT_HIGH_LATENCY_MS)
        ? "high_latency"
        : "high_cost",
      target: targetFromParts(targetType, targetValue),
      protected: isProtectedEvent({ ...event, kind: "cost_latency_outlier" }, options),
      evidence: {
        latencyMs,
        costUsd,
        taskClass: event.taskClass || null,
        model: event.resolvedModelOrEngine || null,
      },
    };
  }

  return null;
}

function classifyHealthControlEvent(event = {}) {
  if (!["repair_validated", "repair_resolved", "repair_rollback_required", "unsafe_quarantine_incident"].includes(event.type)) {
    return null;
  }
  return {
    kind: event.type,
    reason: event.reason || event.type,
    target: targetFromParts(event.targetType || "repairAction", event.repairActionId || event.targetValue || "unknown"),
    control: true,
    repairActionId: event.repairActionId || null,
    evidence: event.evidence || {},
  };
}

function classifyDispatcherHealthEvent(event = {}, options = {}) {
  const control = classifyHealthControlEvent(event);
  if (control) return control;

  if (event.type === "verification_gap") {
    return {
      kind: "verification_gap",
      reason: event.reason || "missing_verification_evidence",
      target: targetFromParts("verification", event.targetValue || event.taskClass || event.route || "unknown"),
      protected: isProtectedEvent({ ...event, kind: "verification_gap" }, options),
      immediateRepair: Boolean(event.immediateRepair),
      evidence: event.evidence || {
        taskClass: event.taskClass || null,
        route: event.route || null,
      },
    };
  }

  const source = event.source || options.source || "dispatcher";
  if (source === "browser") return classifyBrowserEvent(event, options);
  if (source === "usage") return classifyUsageEvent(event, options);
  return classifyDispatcherOutcome(event, options);
}

function repairSuggestionFor(kind, target) {
  if (kind === "route_correction") return `Create or update a dispatch fast path or routing rule for ${target}.`;
  if (kind === "recipe_failure") return `Inspect the recipe route and fallback behavior for ${target}.`;
  if (kind === "data_lookup_miss" || kind === "data_lookup_skipped") return `Update data source selection or lookup order for ${target}.`;
  if (kind === "browser_lane_denial") return `Review browser-route intent classification and add a regression test for ${target}.`;
  if (kind === "verification_gap") return `Add or enforce practical verification evidence for ${target}.`;
  if (kind === "usage_failure" || kind === "usage_fallback") return `Review provider/model fallback routing for ${target}.`;
  if (kind === "cost_latency_outlier") return `Evaluate a cheaper or faster route for ${target}.`;
  return `Inspect repeated dispatcher health issue for ${target}.`;
}

function buildDataLookupFastpathCandidate(action) {
  const dataSources = Array.isArray(action.evidence?.dataSources)
    ? action.evidence.dataSources.filter((value) => typeof value === "string" && value.trim())
    : [];
  if (dataSources.length !== 1) {
    return {
      eligible: false,
      blockedReasons: ["data_lookup_requires_single_source"],
    };
  }

  const source = dataSources[0];
  const template = getDataSourceFastpathTemplate(source);
  if (!template) {
    return {
      eligible: false,
      blockedReasons: ["data_lookup_source_not_allowlisted"],
    };
  }

  return {
    eligible: true,
    candidate: {
      intent: template.intent,
      match_terms: template.match_terms.slice(),
      target_type: "data",
      target_id: template.target_id,
      data_path: template.data_path,
      lookup_order: template.lookup_order.slice(),
      stop_rule: template.stop_rule,
      evidence: [
        `Dispatcher health v2 auto-repair candidate for ${action.kind}:${source}.`,
      ],
    },
    blockedReasons: [],
  };
}

function buildAutoRepairPlan(action, stage, env = process.env) {
  if (env.MYOS_DISPATCH_HEALTH_AUTO_REPAIR === "0") {
    return { eligible: false, blockedReasons: ["auto_repair_disabled"] };
  }
  if (stage.id !== "v2" || stage.capabilities.lowRiskAutoRepair !== "allowlisted_only") {
    return { eligible: false, blockedReasons: ["stage_not_v2"] };
  }
  if (!AUTO_REPAIR_KINDS.has(action.kind)) {
    return { eligible: false, blockedReasons: ["repair_kind_not_allowlisted"] };
  }

  let candidate = action.evidence?.fastpathCandidate || action.autoRepair?.candidate || null;
  let blockedReasons = [];
  if (!candidate && ["data_lookup_miss", "data_lookup_skipped"].includes(action.kind)) {
    const generated = buildDataLookupFastpathCandidate(action);
    if (generated.eligible) {
      candidate = generated.candidate;
    } else {
      blockedReasons = generated.blockedReasons;
    }
  }
  if (!candidate) {
    return { eligible: false, blockedReasons: blockedReasons.length > 0 ? blockedReasons : ["no_fastpath_candidate"] };
  }

  return {
    eligible: true,
    patchType: "fastpath_probation",
    candidate,
    blockedReasons: [],
  };
}

function makeRepairAction(event, options = {}) {
  const now = options.now || new Date().toISOString();
  const key = healthKey(event.target.type, event.target.value);
  const stage = getDispatcherHealthStage({ ...options, state: options.state, env: options.env || process.env });
  const action = {
    id: `dispatcher-health-repair-${safeSlug(event.kind)}-${safeSlug(event.target.value)}-${Date.parse(now) || Date.now()}`,
    status: "open",
    kind: event.kind,
    targetType: event.target.type,
    targetValue: event.target.value,
    reason: event.reason,
    protected: Boolean(event.protected),
    createdAt: now,
    suggestedAction: repairSuggestionFor(event.kind, `${event.target.type}:${event.target.value}`),
    evidence: event.evidence || {},
    key,
  };
  return {
    ...action,
    autoRepair: buildAutoRepairPlan(action, stage, options.env || process.env),
  };
}

function shouldCreateRepairAction(failure, event, options = {}) {
  const threshold = Number(options.failureThreshold || DEFAULT_FAILURE_THRESHOLD);
  return Boolean(event.immediateRepair || Number(failure.count || 0) >= threshold);
}

function shouldQuarantine(event, options = {}) {
  const env = options.env || process.env;
  if (env.MYOS_DISPATCH_HEALTH_AUTO_QUARANTINE === "0") return false;
  if (event.protected) return false;
  if (!SAFE_AUTO_QUARANTINE_TYPES.has(event.target.type)) return false;
  if (event.target.type === "recipe" && !event.safeFallbackAvailable) return false;
  return true;
}

function hasOpenRepairAction(health, key) {
  return (health.repairActions || []).some((action) => action.key === key && action.status === "open");
}

function clearFailure(health, target) {
  delete health.failures[healthKey(target.type, target.value)];
}

function markRepairAction(state, event, status, options = {}) {
  const now = options.now || new Date().toISOString();
  let updated = false;
  const repairActionId = event.repairActionId || event.target.value;
  state.health.repairActions = state.health.repairActions.map((action) => {
    if (action.id !== repairActionId && action.key !== event.target.value) return action;
    updated = true;
    return {
      ...action,
      status,
      resolvedAt: status === "resolved" || status === "validated" ? now : action.resolvedAt || null,
      validationEvidence: event.evidence || action.validationEvidence || null,
    };
  });
  return updated;
}

function recordFailure(state, event, options = {}) {
  const now = options.now || new Date().toISOString();
  const key = healthKey(event.target.type, event.target.value);
  const previous = state.health.failures[key] || {
    key,
    type: event.target.type,
    value: event.target.value,
    count: 0,
    firstFailureAt: now,
  };
  const failure = {
    ...previous,
    count: Number(previous.count || 0) + 1,
    lastReason: event.reason,
    lastFailureAt: now,
    protected: Boolean(event.protected),
  };
  state.health.failures[key] = failure;

  const repairActions = [];
  let repairAction = null;
  if (shouldCreateRepairAction(failure, event, options) && !hasOpenRepairAction(state.health, key)) {
    repairAction = makeRepairAction(event, { ...options, state });
    state.health.repairActions = [...state.health.repairActions, repairAction].slice(-REPAIR_ACTION_LIMIT);
    repairActions.push(repairAction);
  }

  let quarantine = null;
  const threshold = Number(options.failureThreshold || DEFAULT_FAILURE_THRESHOLD);
  if (Number(failure.count || 0) >= threshold && shouldQuarantine(event, options) && !state.health.quarantines[key]) {
    quarantine = {
      key,
      type: event.target.type,
      value: event.target.value,
      reason: event.reason,
      createdAt: now,
      until: new Date((Date.parse(now) || Date.now()) + Number(options.quarantineMs || DEFAULT_QUARANTINE_MS)).toISOString(),
      repairActionId: repairAction?.id || null,
      protected: Boolean(event.protected),
    };
    state.health.quarantines[key] = quarantine;
  }

  return { failure, repairActions, quarantine };
}

function compactDispatcherHealth(health = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const quarantines = activeQuarantines(health, now);
  const openRepairActions = (health.repairActions || [])
    .filter((action) => action.status === "open")
    .slice(-10);
  return {
    status: Object.keys(quarantines).length ? "degraded" : "healthy",
    activeQuarantines: Object.values(quarantines),
    openRepairActions,
    recentAutoRepairs: (health.autoRepairs || []).slice(-10),
  };
}

function recordDispatcherHealthEvent(event = {}, options = {}) {
  const env = options.env || process.env;
  if (env.MYOS_DISPATCH_HEALTH_ENABLED === "0" || options.enabled === false) {
    return { skippedReason: "health_disabled" };
  }

  const now = options.now || new Date().toISOString();
  const state = resolveState(options);
  state.health.quarantines = activeQuarantines(state.health, now);
  const classified = classifyDispatcherHealthEvent(event, options);
  if (!classified) {
    return { skippedReason: "not_health_relevant" };
  }

  const metricEvent = {
    eventType: classified.kind,
    observed: true,
  };
  const repairActions = [];
  let quarantine = null;

  if (classified.control) {
    if (classified.kind === "repair_validated") {
      if (markRepairAction(state, classified, "validated", { now })) {
        metricEvent.validatedRepair = 1;
        metricEvent.repairActionResolved = 1;
      }
    } else if (classified.kind === "repair_resolved") {
      if (markRepairAction(state, classified, "resolved", { now })) {
        metricEvent.repairActionResolved = 1;
      }
    } else if (classified.kind === "repair_rollback_required") {
      metricEvent.rollbackRequiredRepair = 1;
      state.health.unsafeIncidents = [...state.health.unsafeIncidents, { ...classified, at: now }].slice(-50);
    } else if (classified.kind === "unsafe_quarantine_incident") {
      metricEvent.unsafeQuarantineIncident = 1;
      state.health.unsafeIncidents = [...state.health.unsafeIncidents, { ...classified, at: now }].slice(-50);
    }
  } else if (classified.success) {
    clearFailure(state.health, classified.target);
    if (classified.successfulFallback) {
      metricEvent.successfulFallback = 1;
    }
  } else {
    const result = recordFailure(state, classified, options);
    repairActions.push(...result.repairActions);
    quarantine = result.quarantine;
    if (result.repairActions.length > 0) {
      metricEvent.repairActionCreated = result.repairActions.length;
      metricEvent.repairKind = classified.kind;
    }
  }

  const metricUpdate = applyDispatcherHealthMetricEvent(state, metricEvent, {
    ...options,
    now,
    env,
  });
  writeDispatcherHealthState(metricUpdate.state, options);

  return {
    event: classified,
    state: compactDispatcherHealthVersionState(metricUpdate.state),
    health: compactDispatcherHealth(metricUpdate.state.health, { now }),
    repairActions,
    quarantine,
    promoted: metricUpdate.promoted,
    skippedReason: metricUpdate.skippedReason,
  };
}

function isDispatcherTargetQuarantined(type, value, options = {}) {
  const now = options.now || new Date().toISOString();
  const state = resolveState(options);
  return activeQuarantines(state.health, now)[healthKey(type, value)] || null;
}

function normalizeFastpathCandidate(candidate = {}, options = {}) {
  const today = (options.now || new Date().toISOString()).slice(0, 10);
  return {
    ...candidate,
    status: "probation",
    added_at: candidate.added_at || today,
    last_seen_at: candidate.last_seen_at || today,
    hit_count_7d: Number(candidate.hit_count_7d || 1),
    evidence: Array.isArray(candidate.evidence) && candidate.evidence.length > 0
      ? candidate.evidence
      : ["Dispatcher health V2 auto-repair candidate."],
  };
}

function candidatePathExists(relPath, workspaceRoot) {
  if (!relPath || typeof relPath !== "string") return true;
  if (/^[a-z]+:/i.test(relPath)) return true;
  const target = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);
  return fs.existsSync(target);
}

function validateFastpathCandidate(candidate, fastpathsDoc, options = {}) {
  const errors = [];
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  if (!candidate.intent || typeof candidate.intent !== "string") errors.push("intent_required");
  if (!Array.isArray(candidate.match_terms) || candidate.match_terms.length === 0) errors.push("match_terms_required");
  if (!FASTPATH_ROUTE_FIELDS.some((field) => Boolean(candidate[field]))) errors.push("route_field_required");
  if ((fastpathsDoc.fastpaths || []).some((entry) => entry.intent === candidate.intent)) errors.push("duplicate_intent");
  for (const field of ["recipe_path", "handler_path", "project_path", "reference_path", "data_path", "route_hint"]) {
    if (candidate[field] && !candidatePathExists(candidate[field], workspaceRoot)) {
      errors.push(`${field}_missing`);
    }
  }
  const audit = auditFastpathsDoc({
    ...fastpathsDoc,
    fastpaths: [...(fastpathsDoc.fastpaths || []), candidate],
  }, {
    ...options,
    workspaceRoot,
    requireDeterministicDataLookup: candidate.target_type === "data",
  });
  errors.push(...audit.errors);
  return { ok: errors.length === 0, errors, audit };
}

function findRepairAction(state, actionOrId) {
  if (actionOrId && typeof actionOrId === "object") return actionOrId;
  return (state.health.repairActions || []).find((action) => action.id === actionOrId) || null;
}

function applyDispatcherAutoRepair(actionOrId, options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date().toISOString();
  const state = resolveState(options);
  const stage = getDispatcherHealthStage({ ...options, state, env });
  const action = findRepairAction(state, actionOrId);
  if (!action) throw new Error("Unknown dispatcher health repair action");

  const autoRepair = buildAutoRepairPlan(action, stage, env);
  if (!autoRepair.eligible) {
    return { skippedReason: autoRepair.blockedReasons.join(","), action, state: compactDispatcherHealthVersionState(state) };
  }

  if (autoRepair.patchType !== "fastpath_probation") {
    return { skippedReason: "unsupported_auto_repair_patch", action, state: compactDispatcherHealthVersionState(state) };
  }

  const fastpathsFile = options.fastpathsFile || FASTPATHS_FILE;
  const fastpathsDoc = readJson(fastpathsFile);
  if (!Array.isArray(fastpathsDoc.fastpaths)) {
    throw new Error("DISPATCH-FASTPATHS.json must contain a fastpaths array");
  }

  const candidate = normalizeFastpathCandidate(autoRepair.candidate, { now });
  const blockers = getFastpathWriteBlockers({
    env,
    source: "dispatcher-health",
    candidate,
  });
  if (blockers.length > 0) {
    return { skippedReason: blockers.join(","), action, state: compactDispatcherHealthVersionState(state) };
  }
  const validation = validateFastpathCandidate(candidate, fastpathsDoc, options);
  if (!validation.ok) {
    action.status = "auto_repair_blocked";
    action.autoRepair = { ...autoRepair, validation };
    writeDispatcherHealthState(state, options);
    return { skippedReason: "candidate_validation_failed", validation, action, state: compactDispatcherHealthVersionState(state) };
  }

  fastpathsDoc.fastpaths.push(candidate);
  const writeResult = writeFastpathsWithSnapshot(fastpathsFile, fastpathsDoc, {
    ...options,
    now,
    env,
    source: "dispatcher-health",
    reason: `auto-repair:${action.id}`,
    candidate,
    requireDeterministicDataLookup: candidate.target_type === "data",
  });

  const applied = {
    id: `dispatcher-health-auto-repair-${safeSlug(action.id)}-${Date.parse(now) || Date.now()}`,
    actionId: action.id,
    patchType: autoRepair.patchType,
    target: fastpathsFile,
    createdAt: now,
    status: "applied",
    snapshotPath: writeResult.snapshotPath,
    previousChecksum: writeResult.previousChecksum,
    nextChecksum: writeResult.nextChecksum,
    auditWarningCount: writeResult.audit.warnings.length,
  };

  state.health.autoRepairs = [...(state.health.autoRepairs || []), applied].slice(-AUTO_REPAIR_LIMIT);
  state.health.repairActions = state.health.repairActions.map((entry) => entry.id === action.id
    ? {
        ...entry,
        status: "auto_applied",
        autoRepair: { ...autoRepair, validation },
        autoAppliedAt: now,
      }
    : entry);
  const metricUpdate = applyDispatcherHealthMetricEvent(state, {
    eventType: "auto_repair_applied",
    observed: true,
  }, { ...options, now, env });
  writeDispatcherHealthState(metricUpdate.state, options);

  return {
    applied,
    action: metricUpdate.state.health.repairActions.find((entry) => entry.id === action.id) || action,
    state: compactDispatcherHealthVersionState(metricUpdate.state),
  };
}

module.exports = {
  DEFAULT_STATE_FILE,
  AUTO_REPAIR_KINDS,
  classifyDispatcherHealthEvent,
  compactDispatcherHealth,
  applyDispatcherAutoRepair,
  buildAutoRepairPlan,
  buildDataLookupFastpathCandidate,
  healthKey,
  isDispatcherTargetQuarantined,
  recordDispatcherHealthEvent,
  validateFastpathCandidate,
};
