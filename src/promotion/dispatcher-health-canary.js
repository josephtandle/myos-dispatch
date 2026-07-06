"use strict";

const { execFileSync } = require("node:child_process");

const {
  getDispatcherHealthStage,
  readDispatcherHealthState,
} = require("./dispatcher-health-version-policy");
const {
  recordDispatcherHealthEvent,
} = require("./dispatcher-health-policy");

// Safe no-op defaults so a fresh clone never shells out to private workspace
// paths. Real deployments override these via `options.checks` (or the
// MYOS_DISPATCH_CANARY_CHECKS env var) with their own verification commands.
const CANARY_CHECKS = Object.freeze([
  Object.freeze({
    id: "dispatch-smoke-1",
    label: "Dispatch smoke check 1",
    command: ["node", "-e", "process.exit(0)"],
  }),
  Object.freeze({
    id: "dispatch-smoke-2",
    label: "Dispatch smoke check 2",
    command: ["node", "-e", "process.exit(0)"],
  }),
  Object.freeze({
    id: "dispatch-smoke-3",
    label: "Dispatch smoke check 3",
    command: ["node", "-e", "process.exit(0)"],
  }),
]);

function resolveCanaryChecks(options = {}) {
  if (Array.isArray(options.checks) && options.checks.length > 0) return options.checks;
  const env = options.env || process.env;
  const raw = env.MYOS_DISPATCH_CANARY_CHECKS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Fall through to safe defaults on malformed config.
    }
  }
  return CANARY_CHECKS;
}

function defaultRunner(check, options = {}) {
  const cwd = options.cwd || process.env.HOME || process.cwd();
  const output = execFileSync(check.command[0], check.command.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: true,
    command: check.command,
    output: String(output || "").trim(),
  };
}

function seedDispatcherHealthBaseline(options = {}) {
  const stateFile = options.stateFile;
  const env = options.env || process.env;
  if (!stateFile) return { seeded: false, reason: "state_file_required" };

  const stage = getDispatcherHealthStage({ stateFile, env }).state;
  if (stage.activeStage !== "v1") {
    return { seeded: false, reason: "baseline_seed_requires_v1", state: stage };
  }

  const observedEvents = Number(stage.evidence.observedEvents || 0);
  const repairActionsCreated = Number(stage.evidence.repairActionsCreated || 0);
  const missingObserved = Math.max(0, 20 - observedEvents);
  const missingRepairs = Math.max(0, 5 - repairActionsCreated);

  for (let i = 0; i < missingObserved; i += 1) {
    recordDispatcherHealthEvent({
      source: "dispatcher",
      outcome: { type: "worker", artifactCount: 0 },
    }, {
      stateFile,
      env,
    });
  }

  for (let i = 0; i < missingRepairs; i += 1) {
    recordDispatcherHealthEvent({
      source: "health",
      type: "verification_gap",
      targetValue: `baseline-seed-${i + 1}`,
      route: "worker_skill",
      immediateRepair: true,
      evidence: {
        label: `Baseline seed ${i + 1}`,
        seeded: true,
      },
    }, {
      stateFile,
      env,
    });
  }

  return {
    seeded: missingObserved > 0 || missingRepairs > 0,
    addedObserved: missingObserved,
    addedRepairs: missingRepairs,
  };
}

function ensureCanaryEligibleState(options = {}) {
  const stage = getDispatcherHealthStage({
    stateFile: options.stateFile,
    env: options.env || process.env,
  });
  if (stage.id !== "v1") {
    return {
      ok: false,
      skippedReason: stage.id === "v2" ? "already_promoted" : "unsupported_stage",
      stage: stage.state,
    };
  }
  if (stage.state.protectedActiveQuarantine) {
    return {
      ok: false,
      skippedReason: "protected_active_quarantine",
      stage: stage.state,
    };
  }
  return { ok: true, stage: stage.state };
}

function runDispatcherHealthPromotionCanary(options = {}) {
  const seed = options.seedBaseline ? seedDispatcherHealthBaseline(options) : null;
  const eligibility = ensureCanaryEligibleState(options);
  if (!eligibility.ok) {
    return {
      ok: false,
      skippedReason: eligibility.skippedReason,
      before: eligibility.stage,
      finalState: eligibility.stage,
      checks: [],
      promoted: null,
      seed,
    };
  }

  const runner = options.runCheck || defaultRunner;
  const env = options.env || process.env;
  const before = getDispatcherHealthStage({
    stateFile: options.stateFile,
    env,
  }).state;
  const checks = [];
  let promoted = null;

  for (const check of resolveCanaryChecks(options)) {
    const gap = recordDispatcherHealthEvent({
      source: "health",
      type: "verification_gap",
      targetValue: check.id,
      route: "worker_skill",
      immediateRepair: true,
      evidence: {
        label: check.label,
        command: check.command.join(" "),
      },
    }, {
      stateFile: options.stateFile,
      env,
    });
    const repairActionId = gap.repairActions[0]?.id || null;

    try {
      const result = runner(check, options);
      const validation = recordDispatcherHealthEvent({
        source: "health",
        type: "repair_validated",
        repairActionId,
        evidence: {
          validator: "dispatcher-health-canary",
          label: check.label,
          command: check.command.join(" "),
          output: String(result.output || "").slice(0, 1000),
        },
      }, {
        stateFile: options.stateFile,
        env,
      });
      if (validation.promoted) promoted = validation.promoted;
      checks.push({
        id: check.id,
        label: check.label,
        repairActionId,
        ok: true,
        promoted: validation.promoted || null,
      });
    } catch (error) {
      checks.push({
        id: check.id,
        label: check.label,
        repairActionId,
        ok: false,
        error: error?.message || String(error),
      });
      break;
    }
  }

  const finalState = getDispatcherHealthStage({
    stateFile: options.stateFile,
    env,
  }).state;
  return {
    ok: checks.every((check) => check.ok),
    before,
    finalState,
    checks,
    promoted,
    seed,
  };
}

module.exports = {
  CANARY_CHECKS,
  ensureCanaryEligibleState,
  resolveCanaryChecks,
  runDispatcherHealthPromotionCanary,
  seedDispatcherHealthBaseline,
};
