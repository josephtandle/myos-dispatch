"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  activeQuarantines,
  applyDispatcherHealthMetricEvent,
  compactDispatcherHealthVersionState,
  getDispatcherHealthStage,
  isEligibleForDispatcherHealthPromotion,
  readDispatcherHealthState,
  stageFor,
  writeDispatcherHealthState,
} = require("../src/promotion/dispatcher-health-version-policy");

function tempStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-health-version-")), "state.json");
}

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

function eligibleMetricEvent() {
  return {
    observedEvents: 20,
    repairActionCreated: 5,
    repairKind: "route_correction",
    validatedRepair: 3,
    eventType: "route_correction",
  };
}

test("dispatcher health version policy defaults to V1 with V2 as next stage", () => {
  const stateFile = tempStateFile();
  const stage = getDispatcherHealthStage({ stateFile, env: {} });

  assert.equal(stage.id, "v1");
  assert.equal(stage.planVersion, "myos-dispatcher-health-v1");
  assert.equal(stage.nextStage, "v2");
  assert.equal(stage.autoPromote, true);
  assert.equal(stage.capabilities.observe, true);
  assert.equal(stage.capabilities.safeQuarantine, true);
  assert.equal(stage.capabilities.lowRiskAutoRepair, false);
  assert.equal(stage.state.activeStage, "v1");
  assert.equal(stage.state.nextStage, "v2");
});

test("dispatcher health version override pins the stage without mutating state", () => {
  const stateFile = tempStateFile();
  const stage = getDispatcherHealthStage({
    stateFile,
    env: { MYOS_DISPATCH_HEALTH_VERSION: "myos-dispatcher-health-v2" },
  });

  assert.equal(stage.id, "v2");
  assert.equal(stage.source, "env");
  assert.equal(stage.capabilities.lowRiskAutoRepair, "allowlisted_only");
  assert.equal(readDispatcherHealthState({ stateFile }).activeStage, "v1");
});

test("dispatcher health metric evidence self-promotes from V1 to V2", () => {
  const result = applyDispatcherHealthMetricEvent({}, eligibleMetricEvent(), {
    now: "2026-05-20T01:00:00.000Z",
    env: {},
  });

  assert.deepEqual(result.promoted && { from: result.promoted.from, to: result.promoted.to }, { from: "v1", to: "v2" });
  assert.equal(result.skippedReason, null);
  assert.equal(result.state.activeStage, "v2");
  assert.equal(result.state.stages.v1.observedEvents, 20);
  assert.equal(result.state.stages.v1.repairActionsCreated, 5);
  assert.equal(result.state.stages.v1.validatedRepairs, 3);
  assert.equal(result.state.stages.v1.eventTypes.route_correction, 1);
  assert.equal(result.state.stages.v1.repairKinds.route_correction, 5);
});

test("dispatcher health auto-promotion can be disabled by env", () => {
  const result = applyDispatcherHealthMetricEvent({}, eligibleMetricEvent(), {
    now: "2026-05-20T01:00:00.000Z",
    env: { MYOS_DISPATCH_HEALTH_AUTO_PROMOTE: "0" },
  });

  assert.equal(result.promoted, null);
  assert.equal(result.skippedReason, "auto_promotion_disabled");
  assert.equal(result.state.activeStage, "v1");
});

test("dispatcher health metric evidence just below threshold does not self-promote", () => {
  const result = applyDispatcherHealthMetricEvent({}, {
    observedEvents: 19,
    repairActionCreated: 4,
    repairKind: "route_correction",
    validatedRepair: 2,
    eventType: "route_correction",
  }, {
    now: "2026-05-20T01:00:00.000Z",
    env: {},
  });

  assert.equal(result.promoted, null);
  assert.equal(result.skippedReason, null);
  assert.equal(result.state.activeStage, "v1");
  assert.equal(result.state.stages.v1.observedEvents, 19);
  assert.equal(result.state.stages.v1.repairActionsCreated, 4);
  assert.equal(result.state.stages.v1.validatedRepairs, 2);
});

test("unsafe quarantine incidents and rollback repairs block promotion eligibility", () => {
  const stage = stageFor("v1");
  const state = { health: { quarantines: {} } };
  const eligibleCounts = {
    observedEvents: 20,
    repairActionsCreated: 5,
    validatedRepairs: 3,
    unsafeQuarantineIncidents: 0,
    rollbackRequiredRepairs: 0,
  };

  assert.equal(
    isEligibleForDispatcherHealthPromotion(stage, {
      ...eligibleCounts,
      unsafeQuarantineIncidents: 1,
    }, state, { now: "2026-05-20T01:00:00.000Z" }),
    false,
  );
  assert.equal(
    isEligibleForDispatcherHealthPromotion(stage, {
      ...eligibleCounts,
      rollbackRequiredRepairs: 1,
    }, state, { now: "2026-05-20T01:00:00.000Z" }),
    false,
  );
});

test("eligible metric evidence does not auto-promote when active stage is V2", () => {
  const result = applyDispatcherHealthMetricEvent({ activeStage: "v2" }, eligibleMetricEvent(), {
    now: "2026-05-20T01:00:00.000Z",
    env: {},
  });

  assert.equal(stageFor("v2").autoPromote, false);
  assert.equal(result.promoted, null);
  assert.equal(result.skippedReason, null);
  assert.equal(result.state.activeStage, "v2");
  assert.equal(result.state.stages.v2.observedEvents, 20);
  assert.equal(result.state.stages.v2.repairActionsCreated, 5);
  assert.equal(result.state.stages.v2.validatedRepairs, 3);
});

test("dispatcher health state read/write/compact round-trip uses an isolated temp file", () => {
  const stateFile = tempStateFile();
  const state = applyDispatcherHealthMetricEvent({}, {
    observedEvents: 2,
    repairActionCreated: 1,
    repairKind: "verification_gap",
    eventType: "verification_gap",
  }, {
    now: "2026-05-20T02:00:00.000Z",
    env: {},
  }).state;

  state.health.repairActions = Array.from({ length: 105 }, (_, index) => ({
    id: `repair-${index}`,
    kind: "verification_gap",
  }));
  state.health.autoRepairs = Array.from({ length: 55 }, (_, index) => ({ id: `auto-${index}` }));
  state.health.unsafeIncidents = Array.from({ length: 55 }, (_, index) => ({ id: `unsafe-${index}` }));

  writeDispatcherHealthState(state, { stateFile });
  const roundTrip = readDispatcherHealthState({ stateFile });
  const compact = compactDispatcherHealthVersionState(roundTrip);

  assert.equal(roundTrip.activeStage, "v1");
  assert.equal(roundTrip.stages.v1.observedEvents, 2);
  assert.equal(roundTrip.health.repairActions.length, 100);
  assert.equal(roundTrip.health.repairActions[0].id, "repair-5");
  assert.equal(roundTrip.health.autoRepairs.length, 50);
  assert.equal(roundTrip.health.unsafeIncidents.length, 50);
  assert.equal(compact.activeStage, "v1");
  assert.equal(compact.activeVersion, "myos-dispatcher-health-v1");
  assert.equal(compact.evidence.repairActionsCreated, 1);
});

test("dispatcher health quarantine compaction tracks active, expired, and protected quarantines", () => {
  const state = {
    activeStage: "v1",
    health: {
      quarantines: {
        "route:safe": {
          type: "route",
          value: "safe",
          until: "2099-05-20T03:00:00.000Z",
          protected: false,
        },
        "route:expired": {
          type: "route",
          value: "expired",
          until: "2026-05-20T00:30:00.000Z",
          protected: false,
        },
        "browser:oauth": {
          type: "browser",
          value: "oauth",
          until: "2099-05-20T03:00:00.000Z",
          protected: true,
        },
      },
    },
  };
  const now = "2026-05-20T01:00:00.000Z";
  const active = activeQuarantines(state.health, now);

  assert.deepEqual(Object.keys(active).sort(), ["browser:oauth", "route:safe"]);
  assert.equal(Object.values(active).some((quarantine) => quarantine.protected), true);

  const compact = compactDispatcherHealthVersionState(state);
  assert.equal(compact.activeQuarantineCount, 2);
  assert.equal(compact.protectedActiveQuarantine, true);
});

test("MYOS_DISPATCH_HEALTH_STATE_FILE pins the state file without using the default path", async () => {
  const stateFile = tempStateFile();

  await withEnv({ MYOS_DISPATCH_HEALTH_STATE_FILE: stateFile }, () => {
    writeDispatcherHealthState({ activeStage: "v2" });

    const roundTrip = readDispatcherHealthState();
    const stage = getDispatcherHealthStage({ env: {} });

    assert.equal(roundTrip.activeStage, "v2");
    assert.equal(stage.id, "v2");
    assert.equal(fs.existsSync(stateFile), true);
  });
});

test("protected active quarantines block V1 promotion eligibility", () => {
  const state = {
    health: {
      quarantines: {
        "browser:oauth": {
          type: "browser",
          value: "oauth",
          until: "2026-05-20T03:00:00.000Z",
          protected: true,
        },
      },
    },
  };

  const result = applyDispatcherHealthMetricEvent(state, eligibleMetricEvent(), {
    now: "2026-05-20T01:00:00.000Z",
    env: {},
  });

  assert.equal(result.promoted, null);
  assert.equal(result.state.activeStage, "v1");
  assert.equal(
    Object.values(activeQuarantines(result.state.health, "2026-05-20T01:00:00.000Z")).some(
      (quarantine) => quarantine.protected,
    ),
    true,
  );
});

test("expired protected quarantines do not block V1 promotion eligibility", () => {
  const state = {
    health: {
      quarantines: {
        "browser:oauth": {
          type: "browser",
          value: "oauth",
          until: "2026-05-20T00:30:00.000Z",
          protected: true,
        },
      },
    },
  };

  const result = applyDispatcherHealthMetricEvent(state, eligibleMetricEvent(), {
    now: "2026-05-20T01:00:00.000Z",
    env: {},
  });

  assert.deepEqual(Object.keys(activeQuarantines(result.state.health, "2026-05-20T01:00:00.000Z")), []);
  assert.deepEqual(result.promoted && { from: result.promoted.from, to: result.promoted.to }, { from: "v1", to: "v2" });
  assert.equal(result.state.activeStage, "v2");
});
