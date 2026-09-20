"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildParallelizationPlan } = require("../src/parallelization-planner");

test("sidecars without a provider credential quietly plan off", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-credential-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = buildParallelizationPlan("Investigate the runtime architecture and review the design", {
    actionType: "read", route: { lane: "worker_skill" },
  }, {
    env: { HOME: home, MYOS_HOME_ROOT: home },
    parallelizationStage: { capabilities: {}, state: { health: {} } },
    workspaceRoot: home,
  });
  assert.equal(plan.aggression, "off");
  assert.equal(plan.backgroundTasks.length, 0);
  assert.deepEqual(plan.blockedReasons, ["sidecars off: no openai credential"]);
});

test("customer opt-in is required while credentialed Studio planning keeps its default", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-policy-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = (extra = {}, signals = {}) => buildParallelizationPlan("Investigate the runtime architecture", {
    actionType: "read", route: { lane: "worker_skill" },
  }, {
    env: { HOME: home, MYOS_HOME_ROOT: home, OPENAI_API_KEY: "fixture", ...extra },
    parallelizationStage: { capabilities: {}, state: { health: {} } }, workspaceRoot: home, ...signals,
  });
  assert.equal(plan().aggression, "deep");
  assert.ok(plan().backgroundTasks.length > 0);
  assert.equal(plan({ MYOS_CUSTOMER_INSTALL: "1" }).aggression, "off");
  assert.equal(plan({ MYOS_CUSTOMER_INSTALL: "1", MYOS_PARALLELIZATION_AGGRESSION: "balanced" }).aggression, "balanced");
  assert.equal(plan({ MYOS_CUSTOMER_INSTALL: "1", MYOS_PARALLELIZATION_AGGRESSION: "deep", OPENAI_API_KEY: " " }).aggression, "off");
  fs.writeFileSync(path.join(home, ".all-sorted"), "");
  assert.equal(plan().aggression, "off");
  assert.equal(plan({ MYOS_PARALLELIZATION_AGGRESSION: "deep" }).aggression, "deep");
  assert.deepEqual(plan({}, { hookSurface: "claude" }).blockedReasons, ["sidecars off: no anthropic credential"]);
});

test("OAuth seats count only for their provider and foreground execution", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-oauth-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { sidecarOffReason } = require("../src/sidecar-policy");
  const env = { HOME: home, MYOS_HOME_ROOT: home };
  fs.mkdirSync(path.join(home, ".codex"));
  const auth = path.join(home, ".codex", "auth.json");
  fs.writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: "fixture" }));
  assert.equal(sidecarOffReason(env), "sidecars off: no openai credential");
  fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: "fixture-seat" } }));
  assert.equal(sidecarOffReason(env), "");
  assert.equal(sidecarOffReason({ ...env, MYOS_INITIATOR: "unattended" }), "sidecars off: no openai credential");
  assert.equal(sidecarOffReason({ ...env, MYOS_LLM_PROVIDER: "anthropic" }), "sidecars off: no anthropic credential");
  fs.writeFileSync(auth, "malformed");
  assert.equal(sidecarOffReason(env), "sidecars off: no openai credential");
});

test("the real hook renders one quiet credential line and no error block", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-hook-policy-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/myos-dispatch-hook"), "--render-route=1", "--surface=codex"], {
    input: "Investigate the runtime architecture and review the design", encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, MYOS_HOME_ROOT: home, MYOS_AUTO_FANOUT: "0", MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("sidecars off: no openai credential").length - 1, 1);
  assert.match(result.stdout, /aggression=off/);
  assert.match(result.stdout, /sidecars=0\//);
  assert.doesNotMatch(result.stdout, /Dispatch hook error|401|Lane assignments:/);
});

test("recipe children inherit home dotenv without overwriting caller values", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-dotenv-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".env"), [
    "# fixture only", "export FIXTURE_ADDED = 'from home'", "FIXTURE_EXISTING=wrong",
    "FIXTURE_EMPTY=wrong", "FIXTURE_OVERRIDE=wrong", 'FIXTURE_HASH="a # b"',
    "FIXTURE_COMMENT=value # comment", "invalid key=ignore", "FIXTURE_LITERAL=$(do-not-execute)",
  ].join("\r\n"));
  const recipes = path.join(home, "agents", "shared", "recipes");
  fs.mkdirSync(recipes, { recursive: true });
  fs.writeFileSync(path.join(recipes, "probe.recipe.json"), JSON.stringify({
    id: "core/probe", layer: "core", owner: "shared", title: "Probe", handler: "./probe.js",
    inputMode: "freeform", outputMode: "text",
  }));
  fs.writeFileSync(path.join(recipes, "probe.js"), `
    module.exports = async (input, {runProcess}) => {
      const result = await runProcess(process.execPath, ["-e", 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FIXTURE_")))))'], {env: {FIXTURE_OVERRIDE: "caller"}});
      return {reply: result.stdout};
    };
  `);
  const dispatcherPath = path.resolve(__dirname, "../src/task-dispatcher.js");
  const script = `
    const {refreshRecipeRegistry, runRecipe} = require(${JSON.stringify(dispatcherPath)});
    refreshRecipeRegistry();
    (async () => {
      for (let i = 0; i < 2; i++) {
        const result = await runRecipe("core/probe", {}, {outboxDir: process.env.MYOS_HOME_ROOT});
        console.log(result.reply);
      }
      if (process.env.FIXTURE_ADDED !== undefined) throw new Error("parent environment mutated");
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8", env: {
      PATH: process.env.PATH, HOME: home, MYOS_HOME_ROOT: home, MYOS_WORKSPACE: home,
      NODE_DEBUG: "myos-dispatch", FIXTURE_EXISTING: "shell", FIXTURE_EMPTY: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(row, {
    FIXTURE_EXISTING: "shell", FIXTURE_EMPTY: "", FIXTURE_OVERRIDE: "caller",
    FIXTURE_ADDED: "from home", FIXTURE_HASH: "a # b", FIXTURE_COMMENT: "value",
    FIXTURE_LITERAL: "$(do-not-execute)",
  });
  assert.equal(result.stderr.split(path.join(home, ".env")).length - 1, 1);
  assert.match(result.stderr, /4 keys/);
  assert.ok(!result.stderr.includes("from home"));
});
