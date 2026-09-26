"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-recipes-"));
process.env.HOME = root;
process.env.MYOS_HOME_ROOT = path.join(root, ".myos");
const workspace = path.join(process.env.MYOS_HOME_ROOT, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "DISPATCH-FASTPATHS.json"), JSON.stringify({
  fastpaths: [{ intent: "handoff", match_terms: ["handoff"], project_path: "projects/example" }],
}));
const { matchRecipes, resolveDispatchPlan } = require("../src/workspace-context");
const { formatDispatchContext } = require("../bin/myos-dispatch-hook");
const indexPath = path.join(root, "capabilities.json");
fs.writeFileSync(indexPath, JSON.stringify({ scan_dir: workspace, capabilities: [
  { id: "recipe:daily", type: "recipe", execution_lane: "recipe_dispatcher",
    aliases: ["daily handoff"], use_when: ["prepare daily handoff"], source_path: "agents/shared/recipes/daily.recipe.json" },
  { id: "recipe:handoff", type: "recipe", execution_lane: "recipe_dispatcher",
    phrases: ["handoff"], source_path: "agents/shared/recipes/handoff.recipe.json" },
] }));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("exact recipe precedes an overlapping fast path and survives shadow authority", () => {
  const plan = resolveDispatchPlan("Please PREPARE DAILY HANDOFF today", {
    indexPath, env: { ...process.env, MYOS_TYPED_EVIDENCE_SHADOW_VERSION: "v3" },
  });
  assert.equal(plan.fastpathMatches.length, 1);
  assert.equal(plan.branch, "recipe");
  assert.equal(plan.route.lane, "recipe_dispatcher");
  assert.equal(plan.route.reason, "recipe_exact_match");
  assert.equal(plan.stopAfterMatch, true);
  assert.equal(plan.allowBroadSearch, false);
  assert.equal(plan.projectRecipeFirst, true);
  assert.equal(plan.searchScope, path.join(workspace, "agents/shared/recipes/daily.recipe.json"));
  assert.deepEqual(plan.route.candidates[0], {
    capabilityId: "recipe:daily", phrase: "prepare daily handoff", score: 100,
    sourcePath: path.join(workspace, "agents/shared/recipes/daily.recipe.json"),
  });
  assert.equal(plan.shadowDispatch.plan.branch, "recipe");
  assert.equal(plan.shadowDispatch.comparison.same, true);
  const context = formatDispatchContext({ plan, surface: "codex", hookEventName: "UserPromptSubmit", text: "prepare daily handoff" });
  assert.match(context, /Branch: recipe/);
  assert.match(context, /Lane reason: recipe_exact_match/);
});

function withoutTiming(plan) {
  return JSON.parse(JSON.stringify(plan, (key, value) => key === "timingMs" ? undefined : value));
}

test("partial recipe words retain the existing route", () => {
  const prompt = "prepare daily";
  const plan = resolveDispatchPlan(prompt, { indexPath });
  assert.notEqual(plan.branch, "recipe");
  assert.deepEqual(withoutTiming(plan), withoutTiming(resolveDispatchPlan(prompt, { indexPath, recipesFirst: false })));
});

test("recipe boundaries match fast path boundaries", () => {
  const plan = resolveDispatchPlan("handoffs", { indexPath });
  assert.notEqual(plan.branch, "recipe");
  assert.equal(plan.fastpathMatches.length, 0);
  assert.equal(resolveDispatchPlan("handoff!", { indexPath }).branch, "recipe");
  assert.equal(resolveDispatchPlan("daily\t handoff", { indexPath }).branch, "recipe");
});

test("an index without recipes yields the same plan with recipesFirst disabled", () => {
  const emptyIndexPath = path.join(root, "empty.json");
  fs.writeFileSync(emptyIndexPath, JSON.stringify({ capabilities: [] }));
  const options = { indexPath: emptyIndexPath };
  assert.deepEqual(
    withoutTiming(resolveDispatchPlan("handoff", options)),
    withoutTiming(resolveDispatchPlan("handoff", { ...options, recipesFirst: false })),
  );
});

test("recipesFirst false preserves fast path precedence", () => {
  assert.equal(resolveDispatchPlan("prepare daily handoff", { indexPath, recipesFirst: false }).branch, "fastpath");
});

test("recipe matches are distinct capabilities, longest first, capped at three", () => {
  const rankedIndexPath = path.join(root, "ranked.json");
  fs.writeFileSync(rankedIndexPath, JSON.stringify({ capabilities: [
    ...["handoff", "daily handoff", "prepare daily handoff", "please prepare daily handoff"].map((phrase, i) => ({
      id: `recipe:${i}`, type: "recipe", execution_lane: "recipe_dispatcher",
      phrases: [phrase, "handoff"], source_path: `recipes/${i}.recipe.json`,
    })),
    { id: "worker", type: "skill", aliases: ["please prepare daily handoff now"] },
  ] }));
  const matches = matchRecipes("please prepare daily handoff now", { indexPath: rankedIndexPath });
  assert.deepEqual(matches.map((match) => match.capabilityId), ["recipe:3", "recipe:2", "recipe:1"]);
  assert.deepEqual(matches.map((match) => match.score), [100, 100, 100]);
});
