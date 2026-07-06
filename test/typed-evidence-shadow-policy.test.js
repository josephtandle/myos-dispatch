"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decideTypedEvidenceShadowAuthority,
  evaluateTypedEvidenceReplayCases,
  getTypedEvidenceShadowStage,
  readTypedEvidenceShadowState,
  recordTypedEvidenceReplayEvaluation,
  recordTypedEvidenceShadowLiveComparison,
} = require("../src/promotion/typed-evidence-shadow-policy");

function tempStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "typed-shadow-state-")), "state.json");
}

function completedComparison() {
  return {
    same: true,
    differences: [],
  };
}

test("typed-evidence shadow policy defaults to observe-only V1", () => {
  const stateFile = tempStateFile();
  const stage = getTypedEvidenceShadowStage({ stateFile, env: {} });

  assert.equal(stage.id, "v1");
  assert.equal(stage.nextStage, "v2");
  assert.equal(stage.capabilities.safeAuthoritative, false);
});

test("typed-evidence shadow replay evidence promotes V1 to safe authoritative V2", () => {
  const stateFile = tempStateFile();
  const cases = Array.from({ length: 20 }, (_, index) => ({
    id: `case-${index}`,
    prompt: `what is my data lookup ${index}`,
    expectedShadow: { branch: "data", lane: "data_lookup", actionType: "read" },
  }));
  const evaluation = evaluateTypedEvidenceReplayCases(cases, () => ({
    shadowDispatch: {
      plan: {
        branch: "data",
        route: { lane: "data_lookup" },
        actionType: "read",
        intentType: "directive",
        goalScale: 1,
      },
      comparison: completedComparison(),
    },
  }));
  const progression = recordTypedEvidenceReplayEvaluation(evaluation, {
    stateFile,
    env: {},
  });

  assert.equal(evaluation.replayPassedCases, 20);
  assert.equal(evaluation.safeCanaryCases, 20);
  assert.deepEqual(progression.promoted && { from: progression.promoted.from, to: progression.promoted.to }, { from: "v1", to: "v2" });
  assert.equal(readTypedEvidenceShadowState({ stateFile }).activeStage, "v2");
});

test("typed-evidence shadow replay does not promote with hard-gate failures", () => {
  const stateFile = tempStateFile();
  const cases = Array.from({ length: 20 }, (_, index) => ({
    id: `case-${index}`,
    prompt: index === 0 ? "notify Sam with the private link" : `what is my data lookup ${index}`,
    hardGate: index === 0,
    mustNotAuthorize: index === 0,
    expectedShadow: index === 0
      ? { branch: "data", lane: "data_lookup", actionType: "read" }
      : { branch: "data", lane: "data_lookup", actionType: "read" },
  }));
  const evaluation = evaluateTypedEvidenceReplayCases(cases, () => ({
    shadowDispatch: {
      plan: {
        branch: "data",
        route: { lane: "data_lookup" },
        actionType: "read",
        intentType: "directive",
        goalScale: 1,
      },
      comparison: completedComparison(),
    },
  }));
  const progression = recordTypedEvidenceReplayEvaluation(evaluation, {
    stateFile,
    env: {},
  });

  assert.equal(evaluation.dangerousMismatches, 1);
  assert.equal(progression.promoted, null);
  assert.equal(readTypedEvidenceShadowState({ stateFile }).activeStage, "v1");
});

test("typed-evidence authority only selects read-only safe routes in V2", () => {
  const safe = decideTypedEvidenceShadowAuthority({
    query: "what is my tax ID",
    legacyPlan: { branch: "fastpath", route: { lane: "worker_skill" } },
    shadowPlan: { branch: "data", route: { lane: "data_lookup" }, actionType: "read" },
    comparison: { same: false },
    stage: { id: "v2" },
  });
  const risky = decideTypedEvidenceShadowAuthority({
    query: "send the link to Sam on WhatsApp",
    legacyPlan: { branch: "project", route: { lane: "worker_skill" } },
    shadowPlan: { branch: "data", route: { lane: "data_lookup" }, actionType: "read" },
    comparison: { same: false },
    stage: { id: "v2" },
  });
  const write = decideTypedEvidenceShadowAuthority({
    query: "add the Wise payment link",
    legacyPlan: { branch: "data", route: { lane: "worker_skill" } },
    shadowPlan: { branch: "data", route: { lane: "data_lookup" }, actionType: "write" },
    comparison: { same: false },
    stage: { id: "v2" },
  });

  assert.equal(safe.useShadow, true);
  assert.equal(risky.useShadow, false);
  assert.equal(write.useShadow, false);
});

test("typed-evidence shadow V2 can self-promote after successful authoritative uses", () => {
  const stateFile = tempStateFile();
  fs.writeFileSync(stateFile, JSON.stringify({ activeStage: "v2" }), "utf8");

  let last = null;
  for (let index = 0; index < 20; index += 1) {
    last = recordTypedEvidenceShadowLiveComparison({
      comparison: { same: index % 2 === 0 },
      authorityDecision: { useShadow: true },
      outcomeStatus: "ok",
    }, {
      stateFile,
      criteriaOverrides: {
        v2: {
          minLiveComparisons: 20,
          minAuthoritativeUses: 20,
          minSuccessfulAuthoritativeUses: 20,
          maxAuthoritativeFailureRate: 0,
          maxDangerousMismatches: 0,
        },
      },
      env: {},
    });
  }

  assert.deepEqual(last.promoted && { from: last.promoted.from, to: last.promoted.to }, { from: "v2", to: "v3" });
  assert.equal(readTypedEvidenceShadowState({ stateFile }).activeStage, "v3");
});
