"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  readDispatcherHealthState,
  writeDispatcherHealthState,
} = require("../src/promotion/dispatcher-health-version-policy");
const {
  runDispatcherHealthPromotionCanary,
} = require("../src/promotion/dispatcher-health-canary");

function tempStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-health-canary-")), "state.json");
}

test("dispatcher health canary promotes a v1 state with sufficient baseline evidence", () => {
  const stateFile = tempStateFile();
  const state = readDispatcherHealthState({ stateFile });
  state.activeStage = "v1";
  state.stages = state.stages || {};
  state.stages.v1 = state.stages.v1 || {};
  state.stages.v1.observedEvents = 25;
  state.stages.v1.repairActionsCreated = 5;
  writeDispatcherHealthState(state, { stateFile });

  const result = runDispatcherHealthPromotionCanary({
    stateFile,
    env: {},
    runCheck: () => ({ ok: true, output: "ok" }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.promoted && { from: result.promoted.from, to: result.promoted.to }, { from: "v1", to: "v2" });
  assert.equal(readDispatcherHealthState({ stateFile }).activeStage, "v2");
  assert.equal(result.finalState.evidence.validatedRepairs, 0);
});

test("dispatcher health canary refuses to run once already promoted", () => {
  const stateFile = tempStateFile();
  const state = readDispatcherHealthState({ stateFile });
  state.activeStage = "v2";
  writeDispatcherHealthState(state, { stateFile });

  const result = runDispatcherHealthPromotionCanary({
    stateFile,
    env: {},
    runCheck: () => ({ ok: true, output: "ok" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.skippedReason, "already_promoted");
});

test("dispatcher health canary can seed a blank temp state for isolated backtests", () => {
  const stateFile = tempStateFile();

  const result = runDispatcherHealthPromotionCanary({
    stateFile,
    env: {},
    seedBaseline: true,
    runCheck: () => ({ ok: true, output: "ok" }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.seed.seeded, true);
  assert.deepEqual(result.promoted && { from: result.promoted.from, to: result.promoted.to }, { from: "v1", to: "v2" });
});
