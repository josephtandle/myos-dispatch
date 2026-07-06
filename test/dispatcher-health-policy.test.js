"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyDispatcherAutoRepair,
  isDispatcherTargetQuarantined,
  recordDispatcherHealthEvent,
} = require("../src/promotion/dispatcher-health-policy");
const { sha256 } = require("../src/fastpath-store");
const {
  getDispatcherHealthStage,
  readDispatcherHealthState,
  writeDispatcherHealthState,
} = require("../src/promotion/dispatcher-health-version-policy");

function tempStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-health-")), "state.json");
}

function iso(minutes) {
  return new Date(Date.parse("2026-05-20T00:00:00.000Z") + minutes * 60_000).toISOString();
}

test("dispatcher health defaults to V1 with V2 as the next stage", () => {
  const stateFile = tempStateFile();
  const stage = getDispatcherHealthStage({ stateFile, env: {} });

  assert.equal(stage.id, "v1");
  assert.equal(stage.planVersion, "myos-dispatcher-health-v1");
  assert.equal(stage.nextStage, "v2");
  assert.equal(stage.capabilities.safeQuarantine, true);
  assert.equal(stage.capabilities.lowRiskAutoRepair, false);
});

test("dispatcher health records repair actions and quarantines safe repeated recipe failures", () => {
  const stateFile = tempStateFile();
  const event = {
    source: "dispatcher",
    safeFallbackAvailable: true,
    outcome: {
      type: "error",
      recipeId: "agent/example/sync",
      errorCode: "RECIPE_TIMEOUT",
      errorMessage: "Timed out",
    },
  };

  const first = recordDispatcherHealthEvent(event, {
    stateFile,
    failureThreshold: 2,
    now: iso(1),
    env: {},
  });
  const second = recordDispatcherHealthEvent(event, {
    stateFile,
    failureThreshold: 2,
    now: iso(2),
    env: {},
  });

  assert.equal(first.health.status, "healthy");
  assert.equal(second.health.status, "degraded");
  assert.equal(second.repairActions.length, 1);
  assert.equal(second.quarantine.type, "recipe");
  assert.ok(isDispatcherTargetQuarantined("recipe", "agent/example/sync", { stateFile, now: iso(3) }));
});

test("dispatcher health creates repair actions but does not quarantine protected browser routes", () => {
  const stateFile = tempStateFile();
  const event = {
    source: "browser",
    result: "denied",
    intent: "auth_user_visible",
    lane: "user_visible",
    action: "refresh",
    denialReason: "unsafe_refresh",
    url: "https://platform.openai.com/usage",
  };

  const result = recordDispatcherHealthEvent(event, {
    stateFile,
    failureThreshold: 1,
    now: iso(4),
    env: {},
  });

  assert.equal(result.repairActions.length, 1);
  assert.equal(result.quarantine, null);
  assert.equal(result.health.status, "healthy");
  assert.equal(readDispatcherHealthState({ stateFile }).health.repairActions[0].protected, true);
});

test("dispatcher health records explicit verification gaps as repair actions", () => {
  const stateFile = tempStateFile();

  const result = recordDispatcherHealthEvent({
    type: "verification_gap",
    taskClass: "website_deploy",
    route: "recipe_dispatcher",
    immediateRepair: true,
    evidence: { expected: "deploy plus browser refresh" },
  }, {
    stateFile,
    now: iso(5),
    env: {},
  });

  assert.equal(result.repairActions.length, 1);
  assert.equal(result.repairActions[0].kind, "verification_gap");
  assert.match(result.repairActions[0].suggestedAction, /verification evidence/);
});

test("dispatcher health self-promotes from V1 to V2 after validated repair evidence", () => {
  const stateFile = tempStateFile();

  for (let i = 0; i < 5; i += 1) {
    recordDispatcherHealthEvent({
      source: "dispatcher",
      text: `log that mistake for project-${i}`,
      inferredProject: `project-${i}`,
      outcome: { type: "worker" },
    }, {
      stateFile,
      now: iso(10 + i),
      env: {},
    });
  }

  const actionIds = readDispatcherHealthState({ stateFile }).health.repairActions
    .slice(0, 3)
    .map((action) => action.id);

  for (const [index, repairActionId] of actionIds.entries()) {
    recordDispatcherHealthEvent({
      source: "health",
      type: "repair_validated",
      repairActionId,
      evidence: { validator: "test", recurrenceFreeHours: 72 },
    }, {
      stateFile,
      now: iso(20 + index),
      env: {},
    });
  }

  let last = null;
  for (let i = 0; i < 12; i += 1) {
    last = recordDispatcherHealthEvent({
      source: "dispatcher",
      outcome: { type: "worker", artifactCount: 0 },
    }, {
      stateFile,
      now: iso(30 + i),
      env: {},
    });
  }

  assert.deepEqual(last.promoted && { from: last.promoted.from, to: last.promoted.to }, { from: "v1", to: "v2" });
  assert.equal(readDispatcherHealthState({ stateFile }).activeStage, "v2");
  assert.equal(getDispatcherHealthStage({ stateFile, env: { MYOS_DISPATCH_HEALTH_VERSION: "v1" } }).id, "v1");
});

test("dispatcher health auto-promotion can be disabled", () => {
  const stateFile = tempStateFile();

  for (let i = 0; i < 20; i += 1) {
    recordDispatcherHealthEvent({
      source: "dispatcher",
      text: i < 5 ? `log that mistake disabled-${i}` : "",
      inferredProject: `disabled-${i}`,
      outcome: { type: "worker" },
    }, {
      stateFile,
      now: iso(60 + i),
      env: { MYOS_DISPATCH_HEALTH_AUTO_PROMOTE: "0" },
    });
  }

  const actionIds = readDispatcherHealthState({ stateFile }).health.repairActions.slice(0, 3).map((action) => action.id);
  for (const repairActionId of actionIds) {
    recordDispatcherHealthEvent({
      source: "health",
      type: "repair_validated",
      repairActionId,
    }, {
      stateFile,
      now: iso(90),
      env: { MYOS_DISPATCH_HEALTH_AUTO_PROMOTE: "0" },
    });
  }

  assert.equal(readDispatcherHealthState({ stateFile }).activeStage, "v1");
});

test("dispatcher health V2 applies allowlisted fastpath probation repairs only after promotion", () => {
  const stateFile = tempStateFile();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-health-ws-"));
  fs.writeFileSync(path.join(workspaceRoot, "CONTEXT-ROUTING.md"), "# Context Routing\n", "utf8");
  const fastpathsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-fastpaths-")), "fastpaths.json");
  const originalFastpathsText = `${JSON.stringify({ version: 1, fastpaths: [] }, null, 2)}\n`;
  fs.writeFileSync(fastpathsFile, originalFastpathsText);

  const state = readDispatcherHealthState({ stateFile });
  state.activeStage = "v2";
  state.health.repairActions.push({
    id: "repair-fastpath-1",
    status: "open",
    kind: "route_correction",
    targetType: "route",
    targetValue: "example",
    reason: "user_reported_dispatch_mistake",
    key: "route:example",
    evidence: {
      fastpathCandidate: {
        intent: "example dispatcher health route",
        match_terms: ["example dispatcher health route"],
        route_hint: "CONTEXT-ROUTING.md",
        stop_rule: "Use the example route only for this regression test.",
      },
    },
  });
  writeDispatcherHealthState(state, { stateFile });

  const result = applyDispatcherAutoRepair("repair-fastpath-1", {
    stateFile,
    fastpathsFile,
    workspaceRoot,
    now: iso(120),
    env: {},
  });
  const fastpathsDoc = JSON.parse(fs.readFileSync(fastpathsFile, "utf8"));

  assert.equal(result.applied.patchType, "fastpath_probation");
  assert.equal(result.applied.previousChecksum, sha256(originalFastpathsText));
  assert.equal(result.applied.nextChecksum.length, 64);
  assert.ok(fs.existsSync(result.applied.snapshotPath));
  assert.equal(fastpathsDoc.fastpaths.length, 1);
  assert.equal(fastpathsDoc.fastpaths[0].status, "probation");
  assert.equal(fastpathsDoc.fastpaths[0].intent, "example dispatcher health route");
});

test("dispatcher health V2 auto-repair honors global fastpath write kill switch", () => {
  const stateFile = tempStateFile();
  const fastpathsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-fastpaths-kill-")), "fastpaths.json");
  fs.writeFileSync(fastpathsFile, `${JSON.stringify({ version: 1, fastpaths: [] }, null, 2)}\n`);

  const state = readDispatcherHealthState({ stateFile });
  state.activeStage = "v2";
  state.health.repairActions.push({
    id: "repair-fastpath-kill",
    status: "open",
    kind: "route_correction",
    targetType: "route",
    targetValue: "example",
    reason: "user_reported_dispatch_mistake",
    key: "route:example",
    evidence: {
      fastpathCandidate: {
        intent: "blocked dispatcher health route",
        match_terms: ["blocked dispatcher health route"],
        route_hint: "CONTEXT-ROUTING.md",
        stop_rule: "Use the example route only for this regression test.",
      },
    },
  });
  writeDispatcherHealthState(state, { stateFile });

  const result = applyDispatcherAutoRepair("repair-fastpath-kill", {
    stateFile,
    fastpathsFile,
    now: iso(125),
    env: { MYOS_DISPATCH_FASTPATH_WRITES_ENABLED: "0" },
  });
  const fastpathsDoc = JSON.parse(fs.readFileSync(fastpathsFile, "utf8"));

  assert.match(result.skippedReason, /myos_dispatch_fastpath_writes_enabled_disabled/);
  assert.equal(fastpathsDoc.fastpaths.length, 0);
});

test("dispatcher health V2 can auto-repair single-source data lookup skips into probation data fastpaths", () => {
  const stateFile = tempStateFile();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-fastpaths-data-"));
  const fastpathsFile = path.join(tmpDir, "fastpaths.json");
  const dataSourcesConfig = path.join(tmpDir, "data-sources.json");
  const participantDb = path.join(tmpDir, "participants.db");
  fs.writeFileSync(fastpathsFile, `${JSON.stringify({ version: 1, fastpaths: [] }, null, 2)}\n`);
  fs.writeFileSync(participantDb, "", "utf8");
  fs.writeFileSync(
    dataSourcesConfig,
    JSON.stringify({
      version: 1,
      dataSources: [
        {
          id: "participants",
          label: "participants.db",
          mode: "sqlite",
          path: participantDb,
          fastpath: {
            intent: "participant signup lookup",
            matchTerms: ["how many participants signed up", "participant database", "signups", "signed up"],
            stopRule: "Use the configured participant database first for direct signup and participant count lookups."
          }
        }
      ]
    }),
    "utf8",
  );

  const state = readDispatcherHealthState({ stateFile });
  state.activeStage = "v2";
  state.health.repairActions.push({
    id: "repair-data-skip-1",
    status: "open",
    kind: "data_lookup_skipped",
    targetType: "dataLookup",
    targetValue: "participants",
    reason: "lane_not_data_lookup",
    key: "dataLookup:participants",
    evidence: {
      routeLane: "worker_skill",
      dataSources: ["participants"],
      text: "how many participants signed up?",
    },
  });
  writeDispatcherHealthState(state, { stateFile });

  const previousConfig = process.env.MYOS_DATA_SOURCES_CONFIG;
  process.env.MYOS_DATA_SOURCES_CONFIG = dataSourcesConfig;
  let result;
  try {
    result = applyDispatcherAutoRepair("repair-data-skip-1", {
      stateFile,
      fastpathsFile,
      now: iso(130),
      env: {},
    });
  } finally {
    if (previousConfig === undefined) delete process.env.MYOS_DATA_SOURCES_CONFIG;
    else process.env.MYOS_DATA_SOURCES_CONFIG = previousConfig;
  }
  const fastpathsDoc = JSON.parse(fs.readFileSync(fastpathsFile, "utf8"));

  assert.equal(result.applied.patchType, "fastpath_probation");
  assert.equal(fastpathsDoc.fastpaths.length, 1);
  assert.equal(fastpathsDoc.fastpaths[0].target_type, "data");
  assert.match(fastpathsDoc.fastpaths[0].data_path, /participants\.db$/);
  assert.equal(fastpathsDoc.fastpaths[0].status, "probation");
});

test("dispatcher health V2 refuses data lookup auto-repair for multi-source ambiguous cases", () => {
  const stateFile = tempStateFile();
  const fastpathsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-fastpaths-data-")), "fastpaths.json");
  fs.writeFileSync(fastpathsFile, `${JSON.stringify({ version: 1, fastpaths: [] }, null, 2)}\n`);

  const state = readDispatcherHealthState({ stateFile });
  state.activeStage = "v2";
  state.health.repairActions.push({
    id: "repair-data-skip-ambiguous",
    status: "open",
    kind: "data_lookup_skipped",
    targetType: "dataLookup",
    targetValue: "websites,participants",
    reason: "non_read_action",
    key: "dataLookup:websites,participants",
    evidence: {
      routeLane: "worker_skill",
      dataSources: ["websites", "participants"],
      text: "how many people signed up for the event website",
    },
  });
  writeDispatcherHealthState(state, { stateFile });

  const result = applyDispatcherAutoRepair("repair-data-skip-ambiguous", {
    stateFile,
    fastpathsFile,
    now: iso(140),
    env: {},
  });
  const fastpathsDoc = JSON.parse(fs.readFileSync(fastpathsFile, "utf8"));

  assert.equal(result.skippedReason, "data_lookup_requires_single_source");
  assert.equal(fastpathsDoc.fastpaths.length, 0);
});
