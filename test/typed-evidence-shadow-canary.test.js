"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { readTypedEvidenceShadowState } = require("../src/promotion/typed-evidence-shadow-policy");
const {
  SAFE_AUTHORITATIVE_PROMPTS,
  resolveCanaryPlan,
  runTypedEvidenceShadowCanary,
} = require("../src/promotion/typed-evidence-shadow-canary");

function tempStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "typed-shadow-canary-")), "state.json");
}

test("typed-evidence shadow canary corpus stays in safe authoritative data lookup", () => {
  for (const prompt of SAFE_AUTHORITATIVE_PROMPTS) {
    const plan = resolveCanaryPlan(prompt);
    assert.equal(plan.shadowDispatch?.authoritative, true, prompt);
    assert.equal(plan.shadowDispatch?.authorityDecision?.useShadow, true, prompt);
    assert.equal(plan.shadowDispatch?.authorityDecision?.safeAuthoritativeEligible, true, prompt);
    assert.equal(plan.shadowDispatch?.plan?.branch, "data", prompt);
    assert.equal(plan.shadowDispatch?.plan?.route?.lane || plan.shadowDispatch?.plan?.executionLane, "data_lookup", prompt);
    assert.equal(plan.shadowDispatch?.plan?.actionType, "read", prompt);
  }
});

test("typed-evidence shadow canary can promote a cold v2 state with two cycles", () => {
  const stateFile = tempStateFile();
  fs.writeFileSync(stateFile, JSON.stringify({ activeStage: "v2" }), "utf8");

  const result = runTypedEvidenceShadowCanary({
    cycles: 2,
    stateFile,
    env: {},
  });

  assert.deepEqual(result.promoted && { from: result.promoted.from, to: result.promoted.to }, { from: "v2", to: "v3" });
  assert.equal(readTypedEvidenceShadowState({ stateFile }).activeStage, "v3");
});
