"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createStagedPromotionPolicy } = require("./staged-promotion-policy");
const { resolveWorkspacePath } = require("../myos-compat");

const POLICY_VERSION = "myos-typed-evidence-shadow-self-promotion-v1";
const DEFAULT_STAGE = "v1";
const DEFAULT_REPLAY_CORPUS_FILE = path.join(
  __dirname,
  "replay-corpora",
  "typed-evidence-shadow-corpus.json",
);

const VERSION_STAGES = Object.freeze([
  Object.freeze({
    id: "v1",
    planVersion: "typed-evidence-shadow-v1",
    label: "observe and replay-gated comparison",
    nextStage: "v2",
    autoPromote: true,
    capabilities: Object.freeze({
      observe: true,
      safeAuthoritative: false,
      expandedAuthoritative: false,
    }),
    promotionCriteria: Object.freeze({
      minReplayCases: 20,
      minReplayPassRate: 1,
      minHardGatePassRate: 1,
      minSafeCanaryCases: 5,
      maxDangerousMismatches: 0,
    }),
  }),
  Object.freeze({
    id: "v2",
    planVersion: "typed-evidence-shadow-v2",
    label: "safe read-only data/reference authoritative canary",
    nextStage: "v3",
    autoPromote: true,
    capabilities: Object.freeze({
      observe: true,
      safeAuthoritative: "data_reference_read_only",
      expandedAuthoritative: false,
    }),
    promotionCriteria: Object.freeze({
      minLiveComparisons: 50,
      minAuthoritativeUses: 20,
      minSuccessfulAuthoritativeUses: 18,
      maxAuthoritativeFailureRate: 0.1,
      maxDangerousMismatches: 0,
    }),
  }),
  Object.freeze({
    id: "v3",
    planVersion: "typed-evidence-shadow-v3",
    label: "expanded read-only project/capability canary",
    nextStage: null,
    autoPromote: false,
    capabilities: Object.freeze({
      observe: true,
      safeAuthoritative: "data_reference_read_only",
      expandedAuthoritative: "read_only_project_capability",
    }),
    promotionCriteria: null,
  }),
]);

const RISKY_AUTHORITATIVE_PROMPT_RE =
  /\b(send|message|text|email|whatsapp|telegram|gmail|dm|open|refresh|screenshot|click|type|control|browser|chrome|stripe|checkout|payment|billing|bank|wise|paypal|invoice|charge|refund|auth|oauth|login|password|passkey|token|secret|api key|credential|delete|destroy|drop database|rm -rf|wipe|revoke|deploy|commit|push)\b/i;

function defaultStateFile() {
  return resolveWorkspacePath("agents", "shared", "data", "typed-evidence-shadow-state.json");
}

function resolveStateFile(options = {}) {
  return options.stateFile || process.env.MYOS_TYPED_EVIDENCE_SHADOW_STATE_FILE || defaultStateFile();
}

function rate(numerator, denominator) {
  const bottom = Number(denominator || 0);
  if (bottom <= 0) return 0;
  return Number(numerator || 0) / bottom;
}

function defaultMetricState() {
  return {
    replayRuns: 0,
    replayCases: 0,
    replayPassedCases: 0,
    replayFailedCases: 0,
    replayPassRate: 0,
    hardGateCases: 0,
    hardGatePassedCases: 0,
    hardGatePassRate: 0,
    safeCanaryCases: 0,
    dangerousMismatches: 0,
    liveComparisons: 0,
    liveAgreements: 0,
    liveMismatches: 0,
    liveAgreementRate: 0,
    authoritativeUses: 0,
    successfulAuthoritativeUses: 0,
    failedAuthoritativeUses: 0,
    authoritativeFailureRate: 0,
    firstEvidenceAt: null,
    lastEvidenceAt: null,
  };
}

function defaultState() {
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    activeStage: DEFAULT_STAGE,
    stages: {},
    promotions: [],
    lastReplayEvaluation: null,
    updatedAt: null,
  };
}

function normalizeMetricState(metrics = {}) {
  const authoritativeUses = Number(metrics.authoritativeUses || 0);
  const failedAuthoritativeUses = Number(metrics.failedAuthoritativeUses || 0);
  const liveComparisons = Number(metrics.liveComparisons || 0);
  const liveAgreements = Number(metrics.liveAgreements || 0);
  const replayCases = Number(metrics.replayCases || 0);
  const replayPassedCases = Number(metrics.replayPassedCases || 0);
  const hardGateCases = Number(metrics.hardGateCases || 0);
  const hardGatePassedCases = Number(metrics.hardGatePassedCases || 0);

  return {
    replayRuns: Number(metrics.replayRuns || 0),
    replayCases,
    replayPassedCases,
    replayFailedCases: Number(metrics.replayFailedCases || 0),
    replayPassRate: rate(replayPassedCases, replayCases),
    hardGateCases,
    hardGatePassedCases,
    hardGatePassRate: rate(hardGatePassedCases, hardGateCases),
    safeCanaryCases: Number(metrics.safeCanaryCases || 0),
    dangerousMismatches: Number(metrics.dangerousMismatches || 0),
    liveComparisons,
    liveAgreements,
    liveMismatches: Number(metrics.liveMismatches || 0),
    liveAgreementRate: rate(liveAgreements, liveComparisons),
    authoritativeUses,
    successfulAuthoritativeUses: Number(metrics.successfulAuthoritativeUses || 0),
    failedAuthoritativeUses,
    authoritativeFailureRate: rate(failedAuthoritativeUses, authoritativeUses),
    firstEvidenceAt: metrics.firstEvidenceAt || null,
    lastEvidenceAt: metrics.lastEvidenceAt || null,
  };
}

function normalizeTypedEvidenceShadowState(value = {}) {
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
    promotions: Array.isArray(value.promotions) ? value.promotions.slice(-25) : [],
    lastReplayEvaluation: value.lastReplayEvaluation || null,
    updatedAt: value.updatedAt || null,
  };
}

function getCriteria(stage, options = {}) {
  return {
    ...(stage.promotionCriteria || {}),
    ...(options.criteriaOverrides?.[stage.id] || {}),
  };
}

function isEligibleForPromotion(stage, metrics, options = {}) {
  if (!stage?.nextStage || !stage.autoPromote) return false;
  const criteria = getCriteria(stage, options);
  if (stage.id === "v1") {
    return (
      metrics.replayCases >= Number(criteria.minReplayCases || 0) &&
      metrics.replayPassRate >= Number(criteria.minReplayPassRate || 0) &&
      metrics.hardGatePassRate >= Number(criteria.minHardGatePassRate || 0) &&
      metrics.safeCanaryCases >= Number(criteria.minSafeCanaryCases || 0) &&
      metrics.dangerousMismatches <= Number(criteria.maxDangerousMismatches || 0)
    );
  }
  if (stage.id === "v2") {
    return (
      metrics.liveComparisons >= Number(criteria.minLiveComparisons || 0) &&
      metrics.authoritativeUses >= Number(criteria.minAuthoritativeUses || 0) &&
      metrics.successfulAuthoritativeUses >= Number(criteria.minSuccessfulAuthoritativeUses || 0) &&
      metrics.authoritativeFailureRate <= Number(criteria.maxAuthoritativeFailureRate || 0) &&
      metrics.dangerousMismatches <= Number(criteria.maxDangerousMismatches || 0)
    );
  }
  return false;
}

function routeSnapshot(plan = {}) {
  const lane = plan.route?.lane || plan.executionLane || null;
  return {
    branch: plan.branch || null,
    projectSlug: plan.projectSlug || null,
    lane,
    intentType: plan.intentType || null,
    actionType: plan.actionType || null,
    goalScale: plan.goalScale || null,
  };
}

function compareExpected(actual = {}, expected = {}) {
  const mismatches = [];
  for (const [field, expectedValue] of Object.entries(expected || {})) {
    if (expectedValue === undefined) continue;
    const actualValue = actual[field] === undefined ? null : actual[field];
    if (actualValue !== expectedValue) {
      mismatches.push({ field, expected: expectedValue, actual: actualValue });
    }
  }
  return mismatches;
}

function isRiskyAuthoritativePrompt(query = "") {
  return RISKY_AUTHORITATIVE_PROMPT_RE.test(String(query || ""));
}

function isSafeAuthoritativeShadow({ query, shadowPlan = {}, stage } = {}) {
  const currentStage = stageFor(stage?.id || stage);
  const lane = shadowPlan.route?.lane || shadowPlan.executionLane || "";
  if (!currentStage.capabilities.safeAuthoritative) return false;
  if (isRiskyAuthoritativePrompt(query)) return false;
  if (shadowPlan.actionType !== "read") return false;

  if (shadowPlan.branch === "data" && lane === "data_lookup") return true;
  if (shadowPlan.branch === "capability" && lane === "reference_lookup") return true;

  return Boolean(
    currentStage.capabilities.expandedAuthoritative &&
    ["project", "capability"].includes(shadowPlan.branch) &&
    ["worker_skill", "reference_lookup"].includes(lane) &&
    shadowPlan.intentType === "directive",
  );
}

function decideTypedEvidenceShadowAuthority({ query, legacyPlan, shadowPlan, comparison, stage, options = {} } = {}) {
  const currentStage = stageFor(stage?.id || stage);
  if (options.disableAuthority) {
    return {
      useShadow: false,
      reason: "disabled_by_call",
      activeStage: currentStage.id,
      activeVersion: currentStage.planVersion,
      safeAuthoritativeEligible: false,
    };
  }
  const safeAuthoritativeEligible = isSafeAuthoritativeShadow({ query, shadowPlan, stage: currentStage });
  const useShadow = Boolean(safeAuthoritativeEligible);
  return {
    useShadow,
    reason: useShadow ? "safe_authoritative_shadow_route" : "observe_only_or_not_safe",
    activeStage: currentStage.id,
    activeVersion: currentStage.planVersion,
    safeAuthoritativeEligible,
    legacy: routeSnapshot(legacyPlan),
    shadow: routeSnapshot(shadowPlan),
    comparisonSame: Boolean(comparison?.same),
  };
}

function evaluateTypedEvidenceReplayCases(cases = [], resolver, options = {}) {
  const results = [];
  for (const testCase of cases) {
    const plan = resolver(testCase.prompt, testCase);
    const shadowPlan = plan.shadowDispatch?.plan || plan;
    const comparison = plan.shadowDispatch?.comparison || null;
    const stage = stageFor(options.stage || "v2");
    const authorityDecision = decideTypedEvidenceShadowAuthority({
      query: testCase.prompt,
      legacyPlan: plan,
      shadowPlan,
      comparison,
      stage,
    });
    const actualShadow = routeSnapshot(shadowPlan);
    const expectedShadow = testCase.expectedShadow || testCase.expected || {};
    const mismatches = compareExpected(actualShadow, expectedShadow);
    const hardGate = Boolean(testCase.hardGate);
    const dangerousMismatch = Boolean(
      testCase.mustNotAuthorize &&
      authorityDecision.safeAuthoritativeEligible,
    );
    const passed = mismatches.length === 0 && !dangerousMismatch;
    results.push({
      id: testCase.id || testCase.prompt,
      prompt: testCase.prompt,
      category: testCase.category || "routing",
      hardGate,
      safeCanaryEligible: authorityDecision.safeAuthoritativeEligible,
      dangerousMismatch,
      passed,
      expectedShadow,
      actualShadow,
      mismatches,
    });
  }

  const replayCases = results.length;
  const replayPassedCases = results.filter((result) => result.passed).length;
  const hardGateCases = results.filter((result) => result.hardGate).length;
  const hardGatePassedCases = results.filter((result) => result.hardGate && result.passed).length;
  return {
    policyVersion: POLICY_VERSION,
    evaluatedAt: options.now || new Date().toISOString(),
    replayCases,
    replayPassedCases,
    replayFailedCases: replayCases - replayPassedCases,
    replayPassRate: rate(replayPassedCases, replayCases),
    hardGateCases,
    hardGatePassedCases,
    hardGatePassRate: hardGateCases ? rate(hardGatePassedCases, hardGateCases) : 1,
    safeCanaryCases: results.filter((result) => result.safeCanaryEligible).length,
    dangerousMismatches: results.filter((result) => result.dangerousMismatch).length,
    failed: results.filter((result) => !result.passed),
    results,
  };
}

function recordTypedEvidenceReplayEvaluation(evaluation = {}, options = {}) {
  const now = options.now || evaluation.evaluatedAt || new Date().toISOString();
  const state = normalizeTypedEvidenceShadowState(readTypedEvidenceShadowState(options));
  const stage = stageFor(state.activeStage);
  const metrics = normalizeMetricState(state.stages[stage.id]);

  metrics.replayRuns += 1;
  metrics.replayCases = Number(evaluation.replayCases || 0);
  metrics.replayPassedCases = Number(evaluation.replayPassedCases || 0);
  metrics.replayFailedCases = Number(evaluation.replayFailedCases || 0);
  metrics.replayPassRate = rate(metrics.replayPassedCases, metrics.replayCases);
  metrics.hardGateCases = Number(evaluation.hardGateCases || 0);
  metrics.hardGatePassedCases = Number(evaluation.hardGatePassedCases || 0);
  metrics.hardGatePassRate = metrics.hardGateCases ? rate(metrics.hardGatePassedCases, metrics.hardGateCases) : 1;
  metrics.safeCanaryCases = Number(evaluation.safeCanaryCases || 0);
  metrics.dangerousMismatches = Number(evaluation.dangerousMismatches || 0);
  metrics.firstEvidenceAt = metrics.firstEvidenceAt || now;
  metrics.lastEvidenceAt = now;

  state.stages[stage.id] = metrics;
  state.lastReplayEvaluation = {
    evaluatedAt: now,
    replayCases: metrics.replayCases,
    replayPassedCases: metrics.replayPassedCases,
    replayFailedCases: metrics.replayFailedCases,
    replayPassRate: metrics.replayPassRate,
    hardGatePassRate: metrics.hardGatePassRate,
    safeCanaryCases: metrics.safeCanaryCases,
    dangerousMismatches: metrics.dangerousMismatches,
    failed: Array.isArray(evaluation.failed)
      ? evaluation.failed.map((entry) => ({
          id: entry.id,
          prompt: entry.prompt,
          mismatches: entry.mismatches,
          dangerousMismatch: entry.dangerousMismatch,
        })).slice(0, 20)
      : [],
  };
  state.updatedAt = now;

  const promoted = applyPromotionIfEligible(state, stage, metrics, { ...options, now });
  writeTypedEvidenceShadowState(state, options);
  return {
    state: compactTypedEvidenceShadowState(state),
    promoted,
    replay: state.lastReplayEvaluation,
  };
}

function recordTypedEvidenceShadowLiveComparison(event = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const state = normalizeTypedEvidenceShadowState(readTypedEvidenceShadowState(options));
  const stage = stageFor(state.activeStage);
  const metrics = normalizeMetricState(state.stages[stage.id]);
  const comparison = event.comparison || {};
  const authorityDecision = event.authorityDecision || {};

  metrics.liveComparisons += 1;
  if (comparison.same) metrics.liveAgreements += 1;
  else metrics.liveMismatches += 1;
  metrics.liveAgreementRate = rate(metrics.liveAgreements, metrics.liveComparisons);

  if (authorityDecision.dangerousMismatch) metrics.dangerousMismatches += 1;
  if (authorityDecision.useShadow) {
    metrics.authoritativeUses += 1;
    if (String(event.outcomeStatus || "").toLowerCase() === "ok") {
      metrics.successfulAuthoritativeUses += 1;
    } else {
      metrics.failedAuthoritativeUses += 1;
    }
    metrics.authoritativeFailureRate = rate(metrics.failedAuthoritativeUses, metrics.authoritativeUses);
  }

  metrics.firstEvidenceAt = metrics.firstEvidenceAt || now;
  metrics.lastEvidenceAt = now;
  state.stages[stage.id] = metrics;
  state.updatedAt = now;

  const promoted = applyPromotionIfEligible(state, stage, metrics, { ...options, now });
  writeTypedEvidenceShadowState(state, options);
  return {
    state: compactTypedEvidenceShadowState(state),
    promoted,
  };
}

function compactTypedEvidenceShadowState(state = {}) {
  const normalized = normalizeTypedEvidenceShadowState(state);
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
    lastReplayEvaluation: normalized.lastReplayEvaluation,
    lastPromotion: normalized.promotions.at(-1) || null,
  };
}

const stagedPromotionPolicy = createStagedPromotionPolicy({
  policyVersion: POLICY_VERSION,
  stages: VERSION_STAGES,
  defaultStage: DEFAULT_STAGE,
  resolveStateFile,
  defaultStateFile,
  stateFileEnvVar: "MYOS_TYPED_EVIDENCE_SHADOW_STATE_FILE",
  stageOverrideEnvVar: "MYOS_TYPED_EVIDENCE_SHADOW_VERSION",
  autoPromoteEnvVar: "MYOS_TYPED_EVIDENCE_SHADOW_AUTO_PROMOTE",
  defaultState,
  normalizeState: normalizeTypedEvidenceShadowState,
  compactState: compactTypedEvidenceShadowState,
  isEligibleForPromotion: (stage, metrics, _state, options) => isEligibleForPromotion(stage, metrics, options),
  buildPromotionEvidence: (metrics) => ({
    replayCases: metrics.replayCases,
    replayPassRate: metrics.replayPassRate,
    hardGatePassRate: metrics.hardGatePassRate,
    safeCanaryCases: metrics.safeCanaryCases,
    liveComparisons: metrics.liveComparisons,
    authoritativeUses: metrics.authoritativeUses,
    successfulAuthoritativeUses: metrics.successfulAuthoritativeUses,
    authoritativeFailureRate: metrics.authoritativeFailureRate,
    dangerousMismatches: metrics.dangerousMismatches,
  }),
});

function normalizeStageId(value) {
  return stagedPromotionPolicy.normalizeStageId(value);
}

function stageFor(value) {
  return stagedPromotionPolicy.stageFor(value);
}

function readTypedEvidenceShadowState(options = {}) {
  return stagedPromotionPolicy.readState(options);
}

function writeTypedEvidenceShadowState(state, options = {}) {
  return stagedPromotionPolicy.writeState(state, options);
}

function getTypedEvidenceShadowStage(options = {}) {
  return stagedPromotionPolicy.getStage(options);
}

function applyPromotionIfEligible(state, stage, metrics, options = {}) {
  return stagedPromotionPolicy.applyPromotionIfEligible(state, stage, metrics, options);
}

function loadTypedEvidenceReplayCorpus(filePath = DEFAULT_REPLAY_CORPUS_FILE) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(parsed.cases) ? parsed.cases : [];
}

module.exports = {
  DEFAULT_REPLAY_CORPUS_FILE,
  POLICY_VERSION,
  VERSION_STAGES,
  compactTypedEvidenceShadowState,
  decideTypedEvidenceShadowAuthority,
  evaluateTypedEvidenceReplayCases,
  getTypedEvidenceShadowStage,
  isRiskyAuthoritativePrompt,
  isSafeAuthoritativeShadow,
  loadTypedEvidenceReplayCorpus,
  normalizeStageId,
  readTypedEvidenceShadowState,
  recordTypedEvidenceReplayEvaluation,
  recordTypedEvidenceShadowLiveComparison,
  routeSnapshot,
  stageFor,
  writeTypedEvidenceShadowState,
};
