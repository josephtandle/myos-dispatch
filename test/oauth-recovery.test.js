"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readState, updateState } = require("../src/runtime/oauth-state");
const { discoverInventory } = require("../src/runtime/oauth-discovery");
const { refreshRegistry } = require("../src/runtime/oauth-doctor");
const { runBackgroundTask, buildBackgroundWorkerInvocation } = require("../src/background/background-agent-runner");
const { resolveCodexOauthModel } = require("../src/runtime/llm-call");
const { mergeDiscovery, selectModels, recordFailure } = require("../src/runtime/oauth-registry");

test("OAuth explicit model identity is never silently substituted", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-astra", "fixture-new-model"]) {
    assert.equal(resolveCodexOauthModel(model), model);
  }
});

test("fresh official model metadata supersedes a stale Codex cache", async () => {
  const result = await discoverInventory({ cache: { fetched_at: "2000-01-01", models: [{ slug: "old", visibility: "list" }] },
    codexInventory: [{ model: "fixture-new", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
    run: async command => ({ ok: command === "codex", stdout: command === "codex" ? "Logged in using ChatGPT" : "" }),
  });
  const models = result.models.filter(model => model.provider === "codex");
  assert.deepEqual(models.map(model => model.model), ["fixture-new"]);
  assert.equal(models[0].source, "codex-app-server");
});

test("injected transports cannot write live registry evidence without an explicit fixture path", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-isolation-test-"));
  const file = path.join(home, ".myos-dispatch", "oauth-models.json");
  updateState(file, () => mergeDiscovery(null, [{ provider: "codex", model: "gpt-5.6-luna", visible: true, auth: "subscription", observedAt: new Date().toISOString() }]));
  await runBackgroundTask({ id: "fixture", mode: "read_only", prompt: "test" }, {
    command: "codex", callerProvider: "codex", env: { HOME: home, MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0" },
    orchestratorContext: { orchestrator: "myos-dispatch", runId: "test", token: "test", parentTaskId: "root" },
    runCommand: async () => ({ code: 0, stdout: "fixture-output" }),
  });
  assert.equal(readState(file).revision, 1);
  assert.equal(readState(file).models[0].invokedAt, null);
});

test("exit-zero provider errors are not successful invocation evidence", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oauth-false-success-test-")), "state.json");
  updateState(file, () => mergeDiscovery(null, [{ provider: "codex", model: "gpt-5.6-luna", visible: true, auth: "subscription", observedAt: new Date().toISOString() }]));
  const result = await runBackgroundTask({ id: "false-success", model: "gpt-5.6-luna", mode: "read_only", prompt: "test" }, {
    command: "codex", callerProvider: "codex", env: { MYOS_OAUTH_REGISTRY: file, MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0" },
    orchestratorContext: { orchestrator: "myos-dispatch", runId: "test", token: "test", parentTaskId: "root" },
    runCommand: async () => ({ code: 0, stdout: JSON.stringify({ type: "error", message: "request rejected" }) }),
  });
  assert.equal(result.status, "failed");
  assert.equal(readState(file).models[0].invokedAt, null);
});

test("macOS registry recovers a lock left by a dead owner and does not steal a live lock", { skip: process.platform !== "darwin" }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oauth-lock-test-")), "state.json");
  const { execFileSync } = require("node:child_process");
  const deadPid = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  fs.writeFileSync(file + ".lock", deadPid);
  // Native shlock conservatively refuses very recent locks during PID checks.
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.doesNotThrow(() => updateState(file, () => mergeDiscovery(null, [])));
  fs.writeFileSync(file + ".lock", String(process.pid));
  assert.throws(() => updateState(file, state => ({ ...state, revision: 2 })), /lock/i);
  assert.equal(readState(file).revision, 1);
});

test("a coalesced doctor waiter respects its own deadline without cancelling the owner", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oauth-deadline-test-")), "state.json");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const owner = refreshRegistry(file, { discover: async () => { await gate; return { models: [], providers: [] }; } });
  const waiter = refreshRegistry(file, { timeoutMs: 10 });
  const result = await Promise.race([waiter.then(() => "bounded"), new Promise(resolve => setTimeout(() => resolve("unbounded"), 100))]);
  release();
  await owner;
  assert.equal(result, "bounded");
});

test("Codex sidecar starts with exec so the installed wrapper cannot mistake it for a TUI request", () => {
  const invocation = buildBackgroundWorkerInvocation({ model: "gpt-5.6-luna", effectiveMode: "read_only" }, {
    command: "codex", callerProvider: "codex", env: {},
  });
  assert.equal(invocation.args[0], "exec");
  assert.ok(invocation.args.includes('approval_policy="never"'));
});

test("successful complete discovery hides removed models but retains their history", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oauth-removed-test-")), "state.json");
  updateState(file, () => mergeDiscovery(null, [{ provider: "codex", model: "gpt-5.6-luna", visible: true, auth: "subscription", observedAt: new Date().toISOString() }]));
  await refreshRegistry(file, { discover: async () => ({ models: [], providers: [{ provider: "codex", auth: "subscription", completeInventory: true }] }) });
  assert.equal(readState(file).models.length, 1);
  assert.equal(readState(file).models[0].visible, false);
});

test("a present registry with no eligible models cannot fall through to legacy defaults", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oauth-empty-test-")), "state.json");
  updateState(file, () => mergeDiscovery(null, []));
  assert.throws(() => buildBackgroundWorkerInvocation({ mode: "read_only", taskClass: "cheap_routing" }, {
    command: "codex", callerProvider: "codex", env: { MYOS_OAUTH_REGISTRY: file },
  }), /No eligible OAuth/);
});

test("real sidecar entrypoint retries an unsupported unpinned OAuth model once within its task budget", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oauth-runner-test-")), "state.json");
  updateState(file, () => ({ ...mergeDiscovery(null, ["gpt-5.6-luna", "gpt-5.6-terra"].map(model => ({
    provider: "codex", model, visible: true, auth: "subscription", observedAt: new Date().toISOString(),
  }))), scannedAt: new Date().toISOString() }));
  const calls = [];
  const result = await runBackgroundTask({ id: "recover", prompt: "test", mode: "read_only", taskClass: "cheap_routing", timeoutMs: 10000 }, {
    command: "codex", callerProvider: "codex",
    env: { MYOS_OAUTH_REGISTRY: file, MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0" },
    orchestratorContext: { orchestrator: "myos-dispatch", runId: "test", token: "test", parentTaskId: "root" },
    runCommand: async ({ invocation, timeoutMs }) => {
      calls.push({ model: invocation.model, timeoutMs });
      return calls.length === 1 ? { code: 1, stderr: "model is not supported with ChatGPT account" } : { code: 0, stdout: "done" };
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map(x => x.model), ["gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.ok(calls[1].timeoutMs <= 10000);
  assert.equal(result.resolvedModel, "gpt-5.6-terra");
  assert.equal(readState(file).models[0].failureKind, "unsupported_model");
});

test("failure-triggered doctor coalesces concurrent scans and refreshes provider auth without dropping inventory", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oauth-doctor-test-")), "state.json");
  updateState(file, () => mergeDiscovery(null, [{ provider: "claude", model: "sonnet", auth: "subscription" }]));
  let calls = 0;
  const discover = async () => { calls++; return { models: [], providers: [{ provider: "claude", auth: "unavailable" }] }; };
  await Promise.all([refreshRegistry(file, { discover }), refreshRegistry(file, { discover })]);
  assert.equal(calls, 1);
  assert.equal(readState(file).models[0].auth, "unavailable");
  await refreshRegistry(file, { discover });
  assert.equal(calls, 1);
});

test("discovery inventories providers without promoting metadata to working credentials", async () => {
  const result = await discoverInventory({
    cache: { fetched_at: "2026-09-21T00:00:00Z", models: [{ slug: "gpt-5.6-sol", visibility: "list" }, { slug: "hidden", visibility: "hide" }] },
    run: async (command, args) => {
      if (command === "codex") return { ok: true, stdout: "Logged in using ChatGPT" };
      if (command === "claude") return { ok: true, stdout: args[0] === "auth" ? JSON.stringify({ loggedIn: false, authMethod: "none" }) : '--model <model> alias (e.g. fable or opus)' };
      if (command === "agy") return { ok: true, stdout: "gemini-fixture\tGemini Fixture\n" };
      return { ok: false, stdout: "" };
    },
  });
  assert.equal(result.models.find(x => x.model === "gpt-5.6-sol")?.auth, "subscription");
  assert.equal(result.models.find(x => x.model === "hidden")?.visible, false);
  assert.equal(result.models.find(x => x.model === "gemini-fixture")?.auth, "unknown");
  assert.equal(result.providers.find(x => x.provider === "claude")?.auth, "unavailable");
});

test("doctor includes offline local Qwen without loading it", async () => {
  let checks = 0;
  const result = await discoverInventory({ cache: {}, run: async () => ({ ok: false, stdout: "" }),
    localRegistration: { model: "mlx-community/Qwen3.5-35B-A3B-4bit" },
    validateSnapshot: () => { checks++; },
  });
  assert.equal(checks, 1);
  assert.equal(result.models.find(model => model.provider === "local")?.offlineReady, true);
  assert.equal(result.providers.find(provider => provider.provider === "local")?.auth, "local");
});

test("unsupported model quarantine is scoped, while quota and auth failures forbid same-provider retry", () => {
  const state = mergeDiscovery(null, ["gpt-5.6-luna", "gpt-5.6-terra"].map(model => ({ provider: "codex", model })));
  const failed = recordFailure(state, { provider: "codex", model: "gpt-5.6-luna", code: 1, stderr: "model is not supported with ChatGPT account", now: 1000 });
  assert.equal(failed.models[0].failureKind, "unsupported_model");
  assert.equal(failed.models[0].quarantineUntil, new Date(1000 + 3600000).toISOString());
  assert.equal(failed.models[1].quarantineUntil, null);
  assert.equal(failed.lastFailure.retryAllowed, true);
  for (const stderr of ["429 quota exceeded", "401 not authenticated", "task failed"]) {
    assert.equal(recordFailure(state, { provider: "codex", model: "gpt-5.6-luna", code: 1, stderr }).lastFailure.retryAllowed, false);
  }
});

test("registry updates persist atomically, reject stale revisions and retain last good state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-state-test-"));
  const file = path.join(directory, "state.json");
  const first = updateState(file, () => mergeDiscovery(null, []), 0);
  assert.equal(readState(file)?.revision, 1);
  assert.throws(() => updateState(file, state => ({ ...state, revision: 2 }), 0), /revision/);
  updateState(file, state => ({ ...state, revision: 2 }), first.revision);
  assert.equal(JSON.parse(fs.readFileSync(file + ".last-good", "utf8")).revision, 1);
  fs.writeFileSync(file, "broken", { mode: 0o600 });
  assert.equal(readState(file).revision, 1);
});

test("OAuth class selection uses available exact models and excludes quarantined candidates", () => {
  const state = mergeDiscovery(null, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"].map(model => ({
    provider: "codex", model, source: "fixture", visible: true, auth: "subscription", observedAt: new Date().toISOString(),
  })));
  assert.deepEqual(selectModels(state, { provider: "codex", taskClass: "cheap_routing" }).map(x => x.model), ["gpt-5.6-luna", "gpt-5.6-terra"]);
  state.models[0].quarantineUntil = new Date(Date.now() + 60000).toISOString();
  assert.deepEqual(selectModels(state, { provider: "codex", taskClass: "cheap_routing" }).map(x => x.model), ["gpt-5.6-terra"]);
  assert.deepEqual(selectModels(state, { provider: "codex", taskClass: "heavy_synthesis" }).map(x => x.model), ["gpt-5.6-sol", "gpt-6-astra"]);
});

test("discovery registers unfamiliar models without claiming invocation or quality", () => {
  const state = mergeDiscovery(null, [{ provider: "codex", model: "fixture-new", source: "fixture", observedAt: "2026-09-21T00:00:00Z" }]);
  assert.equal(state.models.length, 1);
  assert.equal(state.models[0].model, "fixture-new");
  assert.equal(state.models[0].invokedAt, null);
  assert.equal(state.models[0].qualityValidated, false);
});
