const test = require("node:test");
const assert = require("node:assert/strict");

const { inferGoalScale } = require("../src/goal-scale");

test("goal scale classifies direct status and lookup requests cheaply", () => {
  const status = inferGoalScale("what is the current status");

  assert.equal(status.goalScale, 1);
  assert.equal(status.goalMode, "direct");
  assert.equal(status.requiresPlan, false);
});

test("goal scale defaults ordinary implementation work to Ralph-style scale 3", () => {
  const goal = inferGoalScale("fix the failing dispatch test and verify it passes");

  assert.equal(goal.goalScale, 3);
  assert.equal(goal.goalMode, "ralph");
  assert.match(goal.goalReasons.join(","), /actionable_goal/);
});

test("goal scale treats manager handoffs and cleanup as actionable scale 3", () => {
  const handoff = inferGoalScale("give this to the trading agent");
  const cleanup = inferGoalScale("delete Zoom recordings for the organizers following organizer rules");

  assert.equal(handoff.goalScale, 3);
  assert.equal(handoff.goalMode, "ralph");
  assert.equal(cleanup.goalScale, 3);
  assert.equal(cleanup.goalMode, "ralph");
  assert.equal(cleanup.requiresApproval, true);
});

test("goal scale keeps manager lookup phrasing lightweight", () => {
  const agentStatus = inferGoalScale("tell me the status of the agent");
  const managerName = inferGoalScale("give me the project manager name");

  assert.equal(agentStatus.goalScale, 1);
  assert.equal(managerName.goalScale, 2);
});

test("goal scale infers scale 4 from route-enriched multi-system work without a keyword", () => {
  const goal = inferGoalScale(
    "Fix the db sync, add one-command reconciliation, audit current live sports exposure",
    {
      route: { lane: "workflow", candidates: [{ id: "db" }, { id: "audit" }] },
      candidates: [{ recipeId: "one" }, { recipeId: "two" }],
      actionType: "write",
    },
  );

  assert.equal(goal.goalScale, 4);
  assert.equal(goal.goalMode, "ultragoal");
  assert.equal(goal.requiresPlan, true);
  assert.match(goal.goalReasons.join(","), /multiple_systems_touched/);
});

test("goal scale counts manager handoffs as a scale-4 signal when the work is durable", () => {
  const goal = inferGoalScale("hand off the dispatch lane rebuild to the dispatch project manager and then verify the rollout policy");

  assert.equal(goal.goalScale, 4);
  assert.equal(goal.goalMode, "ultragoal");
  assert.match(goal.goalReasons.join(","), /manager_handoff/);
});

test("goal scale marks sensitive operations as approval-gated", () => {
  const goal = inferGoalScale("rotate the production key and update the runtime");

  assert.equal(goal.requiresApproval, true);
  assert.deepEqual(goal.blockedBy, ["approval_sensitive_operation"]);
});

test("goal scale can see significant background fanout before final posture", () => {
  const goal = inferGoalScale("implement the dispatch change and verify the runtime", {
    actionType: "write",
    route: { lane: "worker_skill" },
    parallelizationPlan: {
      mode: "read_only",
      blockedReasons: [],
      backgroundTasks: [
        { id: "context-map", kind: "source_index_scan" },
        { id: "verification-plan", kind: "verification_review" },
      ],
      joinPolicy: "optional_before_final",
    },
  });

  assert.equal(goal.goalScale, 4);
  assert.equal(goal.goalMode, "ultragoal");
  assert.match(goal.goalReasons.join(","), /parallel_background_work/);
});

test("planner-generated fanout does not independently promote simple actionable work to Goal Scale 4", () => {
  const goal = inferGoalScale("draft a bug report", {
    actionType: "write",
    parallelizationPlan: {
      mode: "read_only",
      blockedReasons: [],
      backgroundTasks: [
        { id: "context-map", kind: "source_index_scan" },
        { id: "verification-plan", kind: "verification_review" },
      ],
      joinPolicy: "require_before_final",
    },
  });

  assert.equal(goal.goalScale, 3);
  assert.equal(goal.goalMode, "ralph");
});

test("is everything ok is classified at most Scale 2", () => {
  const goal = inferGoalScale("is everything ok");
  assert.ok(goal.goalScale <= 2);
  assert.equal(goal.requiresPlan, false);
});
