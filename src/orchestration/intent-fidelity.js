"use strict";

const CORRECTION_RE = /(?:\b(?:actually|instead|i said|correction|change that|undo that|not that)\b|(?:^|\s)no\b[\s,:-]*)/i;

function buildIntentFidelityPolicy(input = {}, options = {}) {
  const env = options.env || process.env;
  const taskClass = String(input.taskClass || "").trim();
  const trustClass = String(input.trustClass || "");
  const disabledByEnv = String(env.MYOS_INTENT_FIDELITY_ENABLED ?? "1") === "0";
  const enabled = !disabledByEnv && trustClass === "interactive";

  return {
    version: "intent-fidelity-v1",
    enabled,
    stopReason: disabledByEnv ? "kill_switch" : trustClass !== "interactive" ? "non_interactive" : null,
    taskClass: taskClass || null,
    correctionDetected: CORRECTION_RE.test(String(input.text || "")),
    blockedBy: Array.isArray(input.blockedBy) ? [...new Set(input.blockedBy)] : [],
    precedence: [
      "latest_explicit_instruction",
      "current_requested_outcome",
      "verified_project_facts",
      "inferred_defaults",
      "stale_session_context",
    ],
    defaultDecision: "execute_next_safe_step",
    execution: {
      corrections: "apply_latest_without_relitigation",
      softAmbiguity: "smallest_reversible_assumption",
      clarification: "one_question_only_for_material_ambiguity",
      reportTiming: "after_action_and_verification",
    },
    resistancePolicy: {
      defendPriorInterpretation: false,
      debateUserPreference: false,
      moralize: false,
      policyRecapInsteadOfAction: false,
    },
    hardGateResponse: {
      completeSafePrework: true,
      nameExactGate: true,
      requestMinimumUnblock: true,
      weakenGate: false,
    },
  };
}

function decideIntentFidelityAction(state = {}) {
  const policy = state.policy || {};
  if (!policy.enabled) {
    return {
      action: "stop",
      reason: policy.stopReason || "intent_fidelity_disabled",
      supersedesPriorInterpretation: false,
      shouldRelitigate: false,
    };
  }
  if (Array.isArray(policy.blockedBy) && policy.blockedBy.length > 0) {
    return {
      action: state.safePreworkAvailable ? "complete_safe_prework_then_stop" : "stop_for_gate",
      reason: "hard_gate",
      exactBlockers: [...policy.blockedBy],
      needsUserInput: true,
      shouldRelitigate: false,
    };
  }
  if (state.materialAmbiguity && state.reversibleAssumptionAvailable && state.safeNextStepAvailable) {
    return {
      action: "execute_now",
      reason: "reversible_assumption_resolves_soft_ambiguity",
      assumptionRequired: true,
      supersedesPriorInterpretation: Boolean(policy.correctionDetected),
      shouldRelitigate: false,
    };
  }
  if (state.materialAmbiguity && !state.reversibleAssumptionAvailable) {
    return {
      action: "ask_minimum_question",
      reason: "material_ambiguity_without_reversible_path",
      maximumQuestions: 1,
      shouldRelitigate: false,
    };
  }
  if (state.safeNextStepAvailable) {
    return {
      action: "execute_now",
      reason: "latest_explicit_intent_has_safe_path",
      supersedesPriorInterpretation: Boolean(policy.correctionDetected),
      shouldRelitigate: false,
    };
  }
  return {
    action: "answer_directly",
    reason: "no_action_required",
    supersedesPriorInterpretation: Boolean(policy.correctionDetected),
    shouldRelitigate: false,
  };
}

function classifyIntentFidelityHealthEvent(state = {}) {
  if (state.reLitigatedSettledInstruction) {
    return {
      type: "intent_fidelity_needless_resistance",
      severity: "error",
    };
  }
  if (state.clarificationAsked && state.reversibleAssumptionAvailable) {
    return {
      type: "intent_fidelity_unnecessary_clarification",
      severity: "warning",
    };
  }
  if (state.recommendationOnly && state.safeNextStepAvailable) {
    return {
      type: "intent_fidelity_actionable_work_deferred",
      severity: "error",
    };
  }
  if (
    state.correctionDetected
    && state.latestExplicitIntentFollowed === false
    && state.priorInterpretationPreserved
  ) {
    return {
      type: "intent_fidelity_intent_mismatch",
      severity: "error",
    };
  }
  return null;
}

module.exports = {
  buildIntentFidelityPolicy,
  classifyIntentFidelityHealthEvent,
  decideIntentFidelityAction,
};
