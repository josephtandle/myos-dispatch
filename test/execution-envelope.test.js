"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildExecutionEnvelope,
  buildGoalPolicy,
  hasExplicitGoalMutationIntent,
  roleProfileForTask,
} = require("../src/orchestration/execution-envelope");

test("gold envelope folds all five features behind independent safety controls", () => {
  const envelope = buildExecutionEnvelope(
    "Schedule a weekly reusable audit and propose a patch",
    { actionType: "write", goalScale: 3 },
    { env: { MYOS_INITIATOR: "human" } },
  );

  assert.equal(envelope.level, "gold");
  assert.equal(envelope.features.scheduledTasks.mode, "report_or_propose_only");
  assert.equal(envelope.features.scheduledTasks.mutationAllowed, false);
  assert.equal(envelope.features.customAgents.nativeThreadsReadOnlyOnly, true);
  assert.equal(envelope.features.skillsAndPlugins.routingAuthority, "myos_capability_index");
  assert.equal(envelope.features.worktrees.oneWriterPerOwnershipPath, true);
  assert.equal(envelope.artifactPolicy.hashRequired, true);
  assert.equal(envelope.rollbackPolicy.independentFeatureKillSwitches, true);
});

test("goal mutation authorization requires a positive explicit request", () => {
  assert.equal(hasExplicitGoalMutationIntent("Create a persisted goal for this"), true);
  assert.equal(hasExplicitGoalMutationIntent("Can you create a goal for this migration?"), true);
  assert.equal(hasExplicitGoalMutationIntent("Make this a persisted goal"), true);
  assert.equal(hasExplicitGoalMutationIntent("Do not create a goal"), false);
  assert.equal(hasExplicitGoalMutationIntent("What is goal mode?"), false);
  assert.equal(hasExplicitGoalMutationIntent("Explain how to create a goal"), false);
  assert.equal(hasExplicitGoalMutationIntent("Should I create a goal?"), false);
  assert.equal(buildGoalPolicy("Do not create a goal", { goalScale: 3 }).persistedGoalMutation, "forbidden");
});

test("persisted goals remain explicit-only and sidecars never mutate the root goal", () => {
  const ordinary = buildGoalPolicy("Fix this and keep going", { goalScale: 3 });
  const explicit = buildGoalPolicy("Create a persisted goal for this migration", { goalScale: 3 });

  assert.equal(ordinary.persistedGoalMutation, "forbidden");
  assert.equal(ordinary.continuationOwner, "myos_ralph");
  assert.equal(explicit.persistedGoalMutation, "explicit_only");
  assert.equal(explicit.continuationOwner, "codex");
  assert.equal(explicit.sidecarsMayMutateRootGoal, false);
  assert.equal(explicit.tokenBudgetSource, "user_explicit_only");
});

test("agent roles map to bounded custom profiles while writes stay runner-owned", () => {
  assert.equal(roleProfileForTask({ role: "context", mode: "read_only" }).id, "myos_code_mapper");
  assert.equal(roleProfileForTask({ role: "decompose", mode: "read_only" }).id, "myos_lane_lead");
  assert.equal(roleProfileForTask({ role: "verify", mode: "read_only" }).id, "myos_test_planner");
  assert.equal(roleProfileForTask({ role: "safety", mode: "read_only" }).id, "myos_impact_reviewer");
  assert.equal(roleProfileForTask({ role: "implement", mode: "workspace_write" }).id, "worker");
});

test("gold feature kill switches are enforced independently", () => {
  const envelope = buildExecutionEnvelope(
    "Schedule a reusable write",
    { actionType: "write" },
    {
      env: {
        MYOS_SCHEDULED_DISPATCH_ENABLED: "0",
        MYOS_BACKGROUND_AGENTS_ENABLED: "0",
        MYOS_CODEX_PLUGIN_ROUTING_ENABLED: "0",
        MYOS_WRITABLE_SIDECARS_ENABLED: "0",
      },
    },
  );
  assert.equal(envelope.features.scheduledTasks.selected, false);
  assert.equal(envelope.features.customAgents.selected, false);
  assert.equal(envelope.features.skillsAndPlugins.selected, false);
  assert.equal(envelope.features.worktrees.selected, false);
});

test("actionable interactive work carries the aggressive Intent Horizon contract", () => {
  const envelope = buildExecutionEnvelope(
    "Fix the dispatch failure and verify the result",
    {
      actionType: "write",
      goalScale: 3,
      goalMode: "ralph",
      blockedBy: [],
      taskClass: "coding_implementation",
    },
    { env: { MYOS_INITIATOR: "human" } },
  );

  assert.equal(envelope.features.intentHorizon.enabled, true);
  assert.equal(envelope.features.intentHorizon.sweep.maxCandidates, 4);
  assert.equal(envelope.features.intentHorizon.sweep.maxAutoApply, 2);
  assert.equal(envelope.features.intentHorizon.exploration.routedProjectOnly, true);
});

test("direct envelope construction fails closed without a declared task class", () => {
  const envelope = buildExecutionEnvelope("Implement and verify the fix", {
    goalScale: 3,
    actionType: "write",
  });

  assert.equal(envelope.features.intentHorizon.enabled, false);
  assert.equal(envelope.features.intentHorizon.stopReason, "missing_task_class");
});
