"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildParallelizationPlan } = require("../src/parallelization-planner");
const { scoreCapabilityMatch } = require("../src/capability-router");
const { handleHookPayload } = require("../bin/myos-dispatch-hook");
const signals = {
  env: { OPENAI_API_KEY: "fixture-only" },
  parallelizationStage: { capabilities: {}, state: {} },
};
const base = { intentType: "exploratory", actionType: "read", route: { lane: "worker_skill" } };

test("lightweight questions, acknowledgments and corrections do not allocate teams", () => {
  for (const text of ["thanks", "yes", "What is Qwen?", "How does OAuth work?", "what's going on with dispatch fanout", "No, I meant OAuth, not the API", "Only launch agents when appropriate"]) {
    assert.equal(buildParallelizationPlan(text, base, signals).backgroundTasks.length, 0, text);
  }
});

test("independent audit work remains eligible for agents", () => {
  const plan = buildParallelizationPlan("Audit the dispatch routing, compare provider behavior, and review the test coverage", base, signals);
  assert.ok(plan.backgroundTasks.length > 0);
});

test("correction and question prefixes preserve explicit independent work", () => {
  for (const text of ["Actually, audit the router and verify the test coverage", "No, build the feature and review the rollout risk", "Do a comprehensive review of routing and verify test coverage"]) {
    assert.ok(buildParallelizationPlan(text, base, signals).backgroundTasks.length > 0, text);
  }
});

test("explicit no-delegation wins over independent work clauses", () => {
  for (const text of [
    "Do not launch agents. Review routing and verify tests yourself.",
    "Don't use subagents. Audit the routing and compare the providers.",
    "No sidecars. Build the feature and verify the behavior.",
    "Work solo. Review routing and verify tests.",
    "Do it yourself. Audit routing and compare providers.",
  ]) {
    assert.equal(buildParallelizationPlan(text, base, signals).backgroundTasks.length, 0, text);
  }
  assert.ok(buildParallelizationPlan("Do not change files. Audit routing and compare providers.", base, signals).backgroundTasks.length > 0);
});

test("full prompt context does not encourage teams for a lightweight turn", () => {
  const output = handleHookPayload({ hook_event_name: "UserPromptSubmit", prompt: "thanks" }, "codex", { contextMode: "full", rewrite: false });
  assert.doesNotMatch(output?.hookSpecificOutput?.additionalContext || "", /Fan out FIRST|widen the fanout|maximum safe fanout/);
});

test("shell source text cannot request agents or writable runners", () => {
  const plan = buildParallelizationPlan("node -e 'const fix = 1; const build = 2; console.log(fix, build)'", { ...base, actionType: "write" }, { ...signals, hookEventName: "PreToolUse" });
  assert.equal(plan.backgroundTasks.length, 0);
  for (const contextMode of ["full", "compact"]) {
    const output = handleHookPayload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sed -n '1,80p' src/build-and-test.js" } }, "codex", { contextMode, rewrite: false });
    const context = output?.hookSpecificOutput?.additionalContext || "";
    assert.doesNotMatch(context, /fanout|spawn|Intent Horizon|Goal persistence|Mandatory behavior/i);
  }
});

test("per-tool safety evidence remains visible", () => {
  const output = handleHookPayload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /example/fixture" } }, "codex", { contextMode: "compact", rewrite: false });
  assert.match(output?.hookSpecificOutput?.additionalContext || "", /destructive_or_approval_sensitive/);
});

test("generic API vocabulary cannot select an unrelated palette capability", () => {
  const capability = { id: "agent:color-palette", aliases: ["Color Palette", "color-palette", "media", "api"], description: "External/product-only color extraction and theme generation API. Do not run as an always-on local MyOS service", priority: 50 };
  assert.ok(scoreCapabilityMatch(capability, "MYOS-DISPATCH Qwen OAuth API").evidenceScore < 10);
  assert.ok(scoreCapabilityMatch(capability, "generate a color palette").evidenceScore >= 10);
});

test("Qwen residency follow-up cannot route generic memory vocabulary to Supabase", () => {
  const text = "And we did some serious work on when to launch Qwen, when to load it into memory, and when to keep it on the external drive. So, look into the memory on that too.";
  const capability = { id: "agent:supabase", aliases: ["Supabase", "supabase", "database", "memory"], description: "General-purpose Supabase interface. Table CRUD (select, insert, update, upsert, delete) and a shared agent_memory store so any agent can persist memory", priority: 50 };
  assert.ok(scoreCapabilityMatch(capability, text).evidenceScore < 10);
  assert.ok(scoreCapabilityMatch(capability, "query the Supabase database").evidenceScore >= 10);
});

test("actual Qwen task-class request cannot route to a palette capability", () => {
  const text = "Also look at MYOS-DISPATCH.md. We need to work on that and make sure the local Qwen model is also getting called for OAuth and for the API whenever possible. For the right task class. Let's do a deep analysis of the task classes for OAuth, and also for the API after we do OAuth.";
  const capability = { id: "agent:color-palette", aliases: ["Color Palette", "color-palette", "media", "api"], description: "External/product-only color extraction and theme generation API. Do not run as an always-on local MyOS service unless explicitly working on…", priority: 50 };
  assert.ok(scoreCapabilityMatch(capability, text).evidenceScore < 10);
});
