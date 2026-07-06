"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getParallelizationStage,
  readVersionState,
  recordParallelizationRun,
} = require("../src/promotion/parallelization-version-policy");

function tempStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "parallel-version-")), "state.json");
}

function completedResult(runner = "codex") {
  return {
    taskId: `task-${runner}`,
    status: "completed",
    runner,
    summary: "ok",
  };
}

test("parallelization version policy defaults to writable sidecars v1", () => {
  const stateFile = tempStateFile();
  const stage = getParallelizationStage({ stateFile, env: {} });

  assert.equal(stage.id, "writable_sidecars_v1");
  assert.equal(stage.planVersion, "myos-parallelization-writable-v1");
  assert.equal(stage.nextStage, null);
  assert.equal(stage.autoPromote, false);
});

test("parallelization version policy auto-promotes after enough successful sidecar evidence", () => {
  const stateFile = tempStateFile();
  const plan = {
    version: "myos-parallelization-v2",
    promotion: { activeStage: "v2" },
  };
  const criteriaOverrides = {
    v2: {
      minSuccessfulRuns: 2,
      minCompletedTasks: 4,
      maxFailureRate: 0,
    },
  };

  const first = recordParallelizationRun(plan, [completedResult("codex"), completedResult("gemini")], {
    stateFile,
    criteriaOverrides,
    now: "2026-05-20T01:00:00.000Z",
    env: {},
  });
  const second = recordParallelizationRun(plan, [completedResult("codex"), completedResult("gemini")], {
    stateFile,
    criteriaOverrides,
    now: "2026-05-20T01:01:00.000Z",
    env: {},
  });

  assert.equal(first.promoted, null);
  assert.deepEqual(second.promoted && { from: second.promoted.from, to: second.promoted.to }, { from: "v2", to: "v3" });
  assert.equal(readVersionState({ stateFile }).activeStage, "v3");
  assert.equal(getParallelizationStage({ stateFile, env: {} }).id, "v3");
});

test("parallelization version policy does not promote after failed sidecar evidence", () => {
  const stateFile = tempStateFile();
  const plan = {
    version: "myos-parallelization-v2",
    promotion: { activeStage: "v2" },
  };

  const result = recordParallelizationRun(plan, [
    completedResult("codex"),
    { taskId: "failed", status: "failed", runner: "gemini", summary: "no" },
  ], {
    stateFile,
    criteriaOverrides: {
      v2: {
        minSuccessfulRuns: 1,
        minCompletedTasks: 1,
        maxFailureRate: 0,
      },
    },
    env: {},
  });

  assert.equal(result.promoted, null);
  // Runs recorded under a pinned stage must not move the global active stage.
  assert.equal(readVersionState({ stateFile }).activeStage, "writable_sidecars_v1");
});

test("parallelization version policy can promote on a clean post-failure streak", () => {
  const stateFile = tempStateFile();
  const plan = {
    version: "myos-parallelization-v2",
    promotion: { activeStage: "v2" },
  };
  const criteriaOverrides = {
    v2: {
      minSuccessfulRuns: 2,
      minCompletedTasks: 4,
      maxFailureRate: 0,
    },
  };

  const failed = {
    taskId: "failed",
    taskKind: "risk_review",
    status: "failed",
    runner: "codex",
    summary: "timeout",
  };
  recordParallelizationRun(plan, [failed], {
    stateFile,
    criteriaOverrides,
    now: "2026-05-20T01:00:00.000Z",
    env: {},
  });

  const first = recordParallelizationRun(plan, [completedResult("codex"), completedResult("gemini")], {
    stateFile,
    criteriaOverrides,
    now: "2026-05-20T01:01:00.000Z",
    env: {},
  });
  const second = recordParallelizationRun(plan, [completedResult("codex"), completedResult("gemini")], {
    stateFile,
    criteriaOverrides,
    now: "2026-05-20T01:02:00.000Z",
    env: {},
  });

  assert.equal(first.promoted, null);
  assert.deepEqual(second.promoted && { from: second.promoted.from, to: second.promoted.to }, { from: "v2", to: "v3" });
});

test("parallelization version policy requires capability evidence for later-stage promotion", () => {
  const stateFile = tempStateFile();
  const plan = {
    version: "myos-parallelization-v3",
    promotion: { activeStage: "v3" },
  };
  const criteriaOverrides = {
    v3: {
      minSuccessfulRuns: 1,
      minCompletedTasks: 1,
      minUsefulTasks: 1,
      maxFailureRate: 0,
      requiredCapability: "safeVerificationExecution",
    },
  };

  const missingCapability = recordParallelizationRun(plan, [completedResult("codex")], {
    stateFile,
    criteriaOverrides,
    env: {},
  });
  const withCapability = recordParallelizationRun(plan, [{
    ...completedResult("codex"),
    capabilityEvidence: "safeVerificationExecution",
    findings: [{ file: "agents/shared/bot-runtime.js", note: "verified" }],
  }], {
    stateFile,
    criteriaOverrides,
    env: {},
  });

  assert.equal(missingCapability.promoted, null);
  assert.deepEqual(withCapability.promoted && { from: withCapability.promoted.from, to: withCapability.promoted.to }, { from: "v3", to: "v4" });
});

test("parallelization version override pins the active stage without changing state", () => {
  const stateFile = tempStateFile();
  const stage = getParallelizationStage({
    stateFile,
    env: { MYOS_PARALLELIZATION_VERSION: "v4" },
  });

  assert.equal(stage.id, "v4");
  assert.equal(stage.source, "env");
  assert.equal(readVersionState({ stateFile }).activeStage, "writable_sidecars_v1");
});

test("parallelization version policy ignores planned-only background metadata", () => {
  const stateFile = tempStateFile();
  const result = recordParallelizationRun({
    version: "myos-parallelization-v2",
    promotion: { activeStage: "v2" },
  }, [
    { taskId: "context-map", status: "planned", runner: null },
  ], {
    stateFile,
    env: {},
  });

  assert.equal(result.promoted, null);
  assert.equal(result.skippedReason, "no_executed_background_tasks");
  assert.equal(readVersionState({ stateFile }).activeStage, "writable_sidecars_v1");
});

test("parallelization health loop quarantines repeated provider and task-kind failures", () => {
  const stateFile = tempStateFile();
  const plan = {
    version: "myos-parallelization-v2",
    promotion: { activeStage: "v2" },
  };
  const failedResult = {
    taskId: "impact-scan",
    taskKind: "risk_review",
    status: "failed",
    runner: "gemini",
    summary: "permission denied: unauthorized",
  };

  const first = recordParallelizationRun(plan, [failedResult], {
    stateFile,
    healthFailureThreshold: 2,
    env: {},
  });
  const second = recordParallelizationRun(plan, [failedResult], {
    stateFile,
    healthFailureThreshold: 2,
    env: {},
  });

  assert.equal(first.health.status, "healthy");
  assert.equal(second.health.status, "degraded");
  assert.ok(second.health.activeQuarantines.some((entry) => entry.type === "provider" && entry.value === "gemini"));
  assert.ok(second.health.activeQuarantines.some((entry) => entry.type === "taskKind" && entry.value === "risk_review"));
  assert.ok(second.repairActions.length >= 2);
});

test("parallelization health loop treats timeouts as budget problems: task-kind-only, higher threshold, 1h quarantine", () => {
  const stateFile = tempStateFile();
  const plan = {
    version: "myos-parallelization-v2",
    promotion: { activeStage: "v2" },
  };
  const timedOut = {
    taskId: "context-1",
    taskKind: "context",
    status: "failed",
    runner: "codex",
    summary: "Timed out after 180000ms",
  };

  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = recordParallelizationRun(plan, [timedOut], { stateFile, env: {}, now: `2026-06-11T0${i}:00:00.000Z` });
    assert.equal(last.health.status, "healthy", `no quarantine before the timeout threshold (run ${i + 1})`);
  }
  last = recordParallelizationRun(plan, [timedOut], { stateFile, env: {}, now: "2026-06-11T03:00:00.000Z" });

  assert.equal(last.health.status, "degraded");
  const quarantine = last.health.activeQuarantines.find((entry) => entry.type === "taskKind" && entry.value === "context");
  assert.ok(quarantine, "task kind must be quarantined after 4 timeouts");
  assert.equal(last.health.activeQuarantines.some((entry) => entry.type === "provider"), false,
    "timeouts must never quarantine a whole provider");
  const quarantineMs = Date.parse(quarantine.until) - Date.parse(quarantine.createdAt);
  assert.equal(quarantineMs, 60 * 60 * 1000);
});

test("parallelization health loop resolves open repair actions when the target completes cleanly", () => {
  const stateFile = tempStateFile();
  const plan = {
    version: "myos-parallelization-v2",
    promotion: { activeStage: "v2" },
  };
  const failing = {
    taskId: "scout-1",
    taskKind: "scout",
    status: "failed",
    runner: "codex",
    stderr: "command not found",
  };

  recordParallelizationRun(plan, [failing], { stateFile, healthFailureThreshold: 1, env: {} });
  const afterRecovery = recordParallelizationRun(plan, [{
    taskId: "scout-1",
    taskKind: "scout",
    status: "completed",
    runner: "codex",
    summary: "ok",
  }], { stateFile, env: {} });

  const stored = readVersionState({ stateFile });
  const open = stored.health.repairActions.filter((action) => action.status === "open" && action.value === "scout");
  assert.equal(open.length, 0, "repair actions for a recovered target must be resolved");
  assert.ok(stored.health.repairActions.some((action) => action.status === "resolved" && action.value === "scout"));
  assert.ok(afterRecovery);
});

test("parallelization health loop still records repair actions when auto-promotion is disabled", () => {
  const stateFile = tempStateFile();
  const plan = {
    version: "myos-parallelization-v2",
    promotion: { activeStage: "v2" },
  };
  const failedResult = {
    taskId: "context-map",
    taskKind: "source_index_scan",
    status: "failed",
    runner: "claude",
    stderr: "command not found",
  };

  const result = recordParallelizationRun(plan, [failedResult], {
    stateFile,
    healthFailureThreshold: 1,
    env: { MYOS_PARALLELIZATION_AUTO_PROMOTE: "0" },
  });

  assert.equal(result.skippedReason, "auto_promotion_disabled");
  assert.equal(result.health.status, "degraded");
  assert.ok(result.repairActions.some((action) => action.reason === "cli_unavailable"));
});
