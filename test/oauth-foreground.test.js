"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { myOSrunOauth, setCodexExecRunnerForTest, resetCodexExecRunnerForTest, resolveExecutionPlan } = require("../src/runtime/llm-call");
const { updateState, readState } = require("../src/runtime/oauth-state");
const { mergeDiscovery } = require("../src/runtime/oauth-registry");
const { flushUsageEventsSync } = require("../src/runtime/myos-usage-ledger");
const { executeCodexText } = require("../src/runtime/oauth-text");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-foreground-test-"));
  const previous = { ...process.env };
  t.after(() => {
    flushUsageEventsSync(); resetCodexExecRunnerForTest();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  Object.assign(process.env, {
    MYOS_OAUTH_RECOVERY: "1", MYOS_OAUTH_REGISTRY: path.join(root, "registry.json"),
    MYOS_LANE_STATE_PATH: path.join(root, "absent-lane.json"), MYOS_MODEL_CATALOG_LOCAL: path.join(root, "absent-catalog.json"),
    MYOS_PUBLIC_LOCAL_PROVIDER_CONFIG: path.join(root, "absent-local.json"),
    MYOS_SPEND_POLICY_PATH: path.join(root, "spend.json"), MYOS_USAGE_LEDGER_DIR: path.join(root, "usage"),
    MYOS_ACTIVITY_LEDGER_DIR: path.join(root, "activity"), MYOS_DISABLE_PROVIDER_ALERTS: "1", MYOS_DISPATCH_HEALTH_ENABLED: "0",
  });
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, "{}");
  updateState(process.env.MYOS_OAUTH_REGISTRY, () => ({
    ...mergeDiscovery(null, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"].map(model => ({
      provider: "codex", model, visible: true, auth: "subscription", observedAt: new Date().toISOString(),
    }))), scannedAt: new Date().toISOString(),
  }));
  return process.env.MYOS_OAUTH_REGISTRY;
}

test("foreground OAuth uses registry exact identities and falls back only after unsupported-model failure", async t => {
  const file = fixture(t);
  const calls = [];
  setCodexExecRunnerForTest(({ model }) => {
    calls.push(model);
    if (calls.length === 1) throw new Error("model is not supported with ChatGPT account");
    return '{"ok":true}';
  });
  const result = await myOSrunOauth({ taskClass: "cheap_routing", prompt: "classify", responseMode: "json", humanVisible: true, timeoutMs: 10000 });
  assert.deepEqual(calls, ["gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.equal(result.model, "gpt-5.6-terra");
  assert.equal(result.authMode, "oauth");
  assert.equal(readState(file).models[0].failureKind, "unsupported_model");
  assert.ok(readState(file).models.find(model => model.model === "gpt-5.6-terra").invokedAt);
});

test("foreground CLI uses exact model, bounded process runner and sanitized ChatGPT-only auth", async () => {
  let invocation;
  const result = await executeCodexText({ model: "gpt-5.6-sol", prompt: "test", effort: "medium", timeoutMs: 1234 }, {
    env: { PATH: process.env.PATH, HOME: os.homedir(), OPENAI_API_KEY: "fixture-secret", ANTHROPIC_API_KEY: "fixture-secret" },
    runCommand: async request => {
      invocation = request;
      return { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) };
    },
  });
  assert.equal(result.text, "ok");
  assert.equal(invocation.args[0], "exec");
  assert.equal(invocation.args[invocation.args.indexOf("-m") + 1], "gpt-5.6-sol");
  assert.ok(invocation.args.includes('forced_login_method="chatgpt"'));
  assert.ok(invocation.args.includes('model_reasoning_effort="medium"'));
  assert.equal(invocation.timeoutMs, 1234);
  assert.equal(invocation.env.OPENAI_API_KEY, undefined);
  assert.equal(invocation.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(invocation.env.MYOS_BACKGROUND_AGENTS_ENABLED, "0");
});

test("explicit OAuth model pins are terminal on failure", async t => {
  fixture(t);
  const calls = [];
  setCodexExecRunnerForTest(({ model }) => { calls.push(model); throw new Error("model is not supported"); });
  await assert.rejects(myOSrunOauth({ taskClass: "cheap_routing", model: "fixture-unknown", prompt: "test", humanVisible: true }), /not supported/);
  assert.deepEqual(calls, ["fixture-unknown"]);
});

test("OAuth auth and quota failures do not consume another model attempt", async t => {
  fixture(t);
  for (const failure of ["401 not authenticated", "429 quota exceeded"]) {
    let calls = 0;
    setCodexExecRunnerForTest(() => { calls++; throw new Error(failure); });
    await assert.rejects(myOSrunOauth({ taskClass: "cheap_routing", prompt: "test", humanVisible: true }));
    assert.equal(calls, 1);
  }
});

test("OAuth inventory and quarantine leave API execution plans identical", t => {
  const file = fixture(t);
  const options = { taskClass: "cheap_routing", complianceLane: "unattended_api", executionPolicy: "internal_automation", authMode: "api", responseMode: "json" };
  const baseline = resolveExecutionPlan(options);
  updateState(file, state => ({ ...state, revision: state.revision + 1, models: [] }));
  assert.deepEqual(resolveExecutionPlan(options), baseline);
});

test("OAuth registry preserves explicit lane model overrides", async t => {
  fixture(t);
  fs.writeFileSync(process.env.MYOS_LANE_STATE_PATH, JSON.stringify({ authMode: "oauth", routeOverrides: {
    cheap_routing: { interactive_oauth: { llmTargets: [{ type: "llm", provider: "openai", model: "gpt-5.5", profile: "cheap_routing", authMode: "oauth" }] } },
  } }));
  let actual;
  setCodexExecRunnerForTest(({model}) => { actual = model; return "ok"; });
  await myOSrunOauth({taskClass:"cheap_routing",prompt:"test",humanVisible:true});
  assert.equal(actual,"gpt-5.5");
});

test("OAuth rechecks fallback eligibility after a failure", async t => {
  const file = fixture(t);
  let calls = 0;
  setCodexExecRunnerForTest(() => {
    calls++;
    updateState(file, state => ({...state,revision:state.revision+1,models:state.models.map(model => ({...model,visible:false}))}));
    throw new Error("model is not supported");
  });
  await assert.rejects(myOSrunOauth({taskClass:"cheap_routing",prompt:"test",humanVisible:true}));
  assert.equal(calls,1);
});
