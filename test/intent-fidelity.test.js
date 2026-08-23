"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildIntentFidelityPolicy,
  classifyIntentFidelityHealthEvent,
  decideIntentFidelityAction,
} = require("../src/orchestration/intent-fidelity");

test("a correction with a safe next step executes without re-litigating the prior interpretation", () => {
  const policy = buildIntentFidelityPolicy({
    text: "No, I said use the existing design and finish it",
    trustClass: "interactive",
    taskClass: "default_automation",
  });
  const decision = decideIntentFidelityAction({
    policy,
    safeNextStepAvailable: true,
    reversibleAssumptionAvailable: true,
  });

  assert.deepEqual(decision, {
    action: "execute_now",
    reason: "latest_explicit_intent_has_safe_path",
    supersedesPriorInterpretation: true,
    shouldRelitigate: false,
  });
});

test("interactive fallback routes still receive Intent Fidelity without a task class", () => {
  const policy = buildIntentFidelityPolicy({
    text: "No, use the current design and finish it",
    trustClass: "interactive",
  });

  assert.equal(policy.enabled, true);
  assert.equal(policy.taskClass, null);
  assert.equal(policy.correctionDetected, true);
  assert.equal(policy.execution.corrections, "apply_latest_without_relitigation");
  assert.equal(policy.hardGateResponse.weakenGate, false);
});

test("an ordinary first-pass preference is not mislabeled as a correction", () => {
  const firstPass = buildIntentFidelityPolicy({
    text: "I want the logo bigger",
    trustClass: "interactive",
  });
  const correction = buildIntentFidelityPolicy({
    text: "No, I want the logo bigger instead",
    trustClass: "interactive",
  });

  assert.equal(firstPass.correctionDetected, false);
  assert.equal(correction.correctionDetected, true);
});

test("a real hard gate is named exactly after safe prework, without turning it into disagreement", () => {
  const policy = buildIntentFidelityPolicy({
    text: "Send the final email to the customer",
    trustClass: "interactive",
    taskClass: "default_automation",
    blockedBy: ["user_visible_send"],
  });
  const decision = decideIntentFidelityAction({
    policy,
    safePreworkAvailable: true,
    safeNextStepAvailable: true,
  });

  assert.deepEqual(decision, {
    action: "complete_safe_prework_then_stop",
    reason: "hard_gate",
    exactBlockers: ["user_visible_send"],
    needsUserInput: true,
    shouldRelitigate: false,
  });
});

test("soft ambiguity uses the smallest reversible assumption instead of asking permission", () => {
  const policy = buildIntentFidelityPolicy({
    text: "Make the logo larger and use the current design",
    trustClass: "interactive",
    taskClass: "default_automation",
  });
  const decision = decideIntentFidelityAction({
    policy,
    materialAmbiguity: true,
    reversibleAssumptionAvailable: true,
    safeNextStepAvailable: true,
  });

  assert.deepEqual(decision, {
    action: "execute_now",
    reason: "reversible_assumption_resolves_soft_ambiguity",
    assumptionRequired: true,
    supersedesPriorInterpretation: false,
    shouldRelitigate: false,
  });
});

test("only material ambiguity with no reversible path asks one minimum question", () => {
  const policy = buildIntentFidelityPolicy({
    text: "Replace the production database",
    trustClass: "interactive",
    taskClass: "default_automation",
  });
  const decision = decideIntentFidelityAction({
    policy,
    materialAmbiguity: true,
    reversibleAssumptionAvailable: false,
    safeNextStepAvailable: false,
  });

  assert.deepEqual(decision, {
    action: "ask_minimum_question",
    reason: "material_ambiguity_without_reversible_path",
    maximumQuestions: 1,
    shouldRelitigate: false,
  });
});

test("ignoring the latest explicit instruction emits an intent mismatch defect", () => {
  assert.deepEqual(classifyIntentFidelityHealthEvent({
    correctionDetected: true,
    latestExplicitIntentFollowed: false,
    priorInterpretationPreserved: true,
  }), {
    type: "intent_fidelity_intent_mismatch",
    severity: "error",
  });
});

test("re-litigating a settled instruction emits a needless resistance defect", () => {
  assert.deepEqual(classifyIntentFidelityHealthEvent({
    reLitigatedSettledInstruction: true,
  }), {
    type: "intent_fidelity_needless_resistance",
    severity: "error",
  });
});

test("asking for permission when a reversible default exists emits unnecessary clarification", () => {
  assert.deepEqual(classifyIntentFidelityHealthEvent({
    clarificationAsked: true,
    reversibleAssumptionAvailable: true,
  }), {
    type: "intent_fidelity_unnecessary_clarification",
    severity: "warning",
  });
});

test("reporting a recommendation instead of taking a safe next step emits deferred work", () => {
  assert.deepEqual(classifyIntentFidelityHealthEvent({
    recommendationOnly: true,
    safeNextStepAvailable: true,
  }), {
    type: "intent_fidelity_actionable_work_deferred",
    severity: "error",
  });
});
