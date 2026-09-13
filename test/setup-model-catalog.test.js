const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const setup = require("../scripts/setup-model-catalog");
const routing = require("../src/myos-routing");
const { resolveModelCatalogLocalPath } = require("../src/myos-compat");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeProbes({
  cli = [],
  login = "unknown",
  envKeys = [],
  ollama = false,
  ollamaModels = [],
  mlxWhisper = false,
  now = new Date("2026-07-21T00:00:00.000Z"),
} = {}) {
  const cliSet = new Set(cli);
  const envSet = new Set(envKeys);
  return {
    loginStatus() { return login; },
    cliAvailable(command) {
      if (command === "ollama") return ollama;
      return cliSet.has(command);
    },
    envHas(key) {
      return envSet.has(key);
    },
    ollamaModels() {
      return ollama ? ollamaModels : [];
    },
    mlxWhisperAvailable() {
      return mlxWhisper;
    },
    now() {
      return now;
    },
  };
}

test("detection covers oauth-only, api-only, both, nothing, and ollama-only", () => {
  const oauthOnly = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ cli: ["codex"], login: "oauth" }),
  });
  assert.deepEqual(oauthOnly.providers.openai, {
    oauthCli: "codex",
    installed: true,
    loginStatus: "oauth",
    oauth: true,
    apiKey: false,
  });
  assert.strictEqual(oauthOnly.providers.google, undefined);

  const apiOnly = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ envKeys: ["OPENAI_API_KEY"] }),
  });
  assert.deepEqual(apiOnly.providers.openai, {
    oauthCli: undefined,
    installed: false,
    loginStatus: "not_installed",
    oauth: false,
    apiKey: true,
  });

  const both = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ cli: ["codex"], login: "oauth", envKeys: ["OPENAI_API_KEY"] }),
  });
  assert.deepEqual(both.providers.openai, {
    oauthCli: "codex",
    installed: true,
    loginStatus: "oauth",
    oauth: true,
    apiKey: true,
  });

  const nothing = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes(),
  });
  assert.deepEqual(nothing.providers, {});
  assert.equal(nothing.local.ollama.available, false);
  assert.equal(nothing.local.mlxWhisper.available, false);

  const ollamaOnly = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ ollama: true, ollamaModels: ["llama3.2", "mistral"], mlxWhisper: true }),
  });
  assert.equal(ollamaOnly.local.ollama.available, true);
  assert.deepEqual(ollamaOnly.local.ollama.models, ["llama3.2", "mistral"]);
  assert.equal(ollamaOnly.local.mlxWhisper.available, true);
});

test("assignment prefers oauth lane before api lane when both exist", () => {
  const catalog = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ cli: ["codex"], login: "oauth", envKeys: ["OPENAI_API_KEY"] }),
  });

  assert.equal(catalog.assignments.cheap_routing.lane, "interactive_oauth");
  assert.equal(catalog.assignments.cheap_routing.authMode, "oauth");
  assert.equal(catalog.assignments.cheap_routing.provider, "openai");
  assert.equal(catalog.assignments.default_automation.lane, "interactive_oauth");
});

test("every canonical task class gets either an assignment or an unassigned hint", () => {
  const catalog = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes(),
  });

  for (const taskClass of routing.CANONICAL_TASK_CLASSES) {
    const entry = catalog.assignments[taskClass];
    assert.ok(entry, `missing assignment for ${taskClass}`);
    if (entry.unassigned) {
      assert.equal(typeof entry.reason, "string");
      assert.equal(typeof entry.enableWith, "string");
      assert.notEqual(entry.enableWith.trim(), "");
    } else {
      assert.equal(typeof entry.provider, "string");
      assert.equal(typeof entry.model, "string");
      assert.equal(typeof entry.profile, "string");
      assert.equal(typeof entry.authMode, "string");
      assert.equal(typeof entry.lane, "string");
      assert.equal(entry.source, "auto");
    }
  }
});

test("overrides are preserved verbatim across re-runs", () => {
  const homeRoot = tempDir("myos-catalog-home-");
  const targetPath = resolveModelCatalogLocalPath(homeRoot);
  const overrides = {
    planning: {
      llmTargets: [
        {
          type: "llm",
          provider: "openai",
          profile: "heavy_synthesis",
          model: "openai.gpt-5.4",
          authMode: "api",
        },
      ],
    },
  };

  const first = {
    version: 1,
    generatedAt: "2026-07-20T00:00:00.000Z",
    providers: {},
    local: {
      ollama: { available: false, models: [] },
      mlxWhisper: { available: false },
    },
    assignments: {},
    overrides,
  };

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(first, null, 2)}\n`, "utf8");

  const existing = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  const next = setup.buildModelCatalog({
    homeRoot,
    probes: fakeProbes({ cli: ["codex"], login: "oauth" }),
    existing,
  });
  assert.deepEqual(next.overrides, overrides);

  setup.writeModelCatalog(targetPath, next);
  const reread = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  assert.deepEqual(reread.overrides, overrides);
});

test("report contains the exact closing sentence and no em dash", () => {
  const catalog = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ cli: ["codex"], login: "oauth", envKeys: ["OPENAI_API_KEY"] }),
  });

  const report = setup.renderReport(catalog);
  const closing = "Here are the task classes. I've assigned them to these models. Let me know if you would like to change any of them.";

  assert.ok(report.includes(closing));
  assert.ok(report.includes("These are the provider installations and credentials detected on this machine:"));
  assert.ok(report.includes("I've made my best guess assigning the eight task classes to them:"));
  assert.ok(report.includes("- openai: codex CLI installed; login: oauth, plus an API key detected in your environment (not tested)"));
  assert.ok(!report.includes("—"));
});

test("report names local runtimes and handles the nothing-detected case", () => {
  const nothing = setup.renderReport(setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes(),
  }));
  assert.ok(nothing.includes("- none yet: no provider CLIs, API keys, or local runtimes were detected"));

  const localOnly = setup.renderReport(setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ ollama: true, ollamaModels: ["llama3.2"], mlxWhisper: true }),
  }));
  assert.ok(localOnly.includes("- local: ollama (llama3.2)"));
  assert.ok(localOnly.includes("- local: mlx_whisper for on-device transcription"));
});

test("routing honors overrides, ignores invalid overrides, and falls back when the file is absent or corrupt", () => {
  const homeRoot = tempDir("myos-routing-home-");
  const localPath = path.join(homeRoot, "catalog.json");
  const lanePath = path.join(homeRoot, "lane.json");
  const baseEnv = {
    MYOS_MODEL_CATALOG_LOCAL: localPath,
    MYOS_LANE_STATE_PATH: lanePath,
  };

  function resolvePlanning() {
    return routing.resolveExecutionPlan({
      taskClass: "planning",
      complianceLane: "unattended_api",
    });
  }

  routing.clearLocalAssignmentsCache();
  process.env.MYOS_MODEL_CATALOG_LOCAL = localPath;
  process.env.MYOS_LANE_STATE_PATH = baseEnv.MYOS_LANE_STATE_PATH;
  const expectedBase = resolvePlanning();

  const overrideFile = {
    version: 1,
    generatedAt: "2026-07-21T00:00:00.000Z",
    providers: {},
    local: { ollama: { available: false, models: [] }, mlxWhisper: { available: false } },
    assignments: {},
    overrides: {
      planning: {
        llmTargets: [
          {
            type: "llm",
            provider: "openai",
            profile: "heavy_synthesis",
            model: "openai.gpt-5.4",
            authMode: "api",
          },
        ],
      },
    },
  };
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, `${JSON.stringify(overrideFile, null, 2)}\n`, "utf8");
  routing.clearLocalAssignmentsCache();
  const overridePlan = resolvePlanning();
  assert.equal(overridePlan.candidates.length, 1);
  assert.equal(overridePlan.candidates[0].provider, "openai");
  assert.equal(overridePlan.candidates[0].profile, "heavy_synthesis");
  assert.equal(overridePlan.candidates[0].model, "openai.gpt-5.4");

  fs.writeFileSync(
    localPath,
    `${JSON.stringify({
      ...overrideFile,
      overrides: {
        planning: {
          llmTargets: [
            {
              type: "llm",
              provider: "not-a-provider",
              profile: "missing",
              model: "missing",
              authMode: "api",
            },
          ],
        },
      },
    }, null, 2)}\n`,
    "utf8"
  );
  routing.clearLocalAssignmentsCache();
  const invalidPlan = resolvePlanning();
  assert.deepEqual(invalidPlan.candidates, expectedBase.candidates);

  fs.rmSync(localPath);
  routing.clearLocalAssignmentsCache();
  const absentPlan = resolvePlanning();
  assert.deepEqual(absentPlan.candidates, expectedBase.candidates);

  fs.writeFileSync(localPath, "{ this is not valid json", "utf8");
  routing.clearLocalAssignmentsCache();
  const corruptPlan = resolvePlanning();
  assert.deepEqual(corruptPlan.candidates, expectedBase.candidates);

  routing.clearLocalAssignmentsCache();
  delete process.env.MYOS_MODEL_CATALOG_LOCAL;
  delete process.env.MYOS_LANE_STATE_PATH;
});

test("installed CLI without verified auth never creates OAuth assignments", () => {
  const catalog = setup.buildModelCatalog({ probes: fakeProbes({ cli: ["codex"] }) });
  assert.equal(catalog.providers.openai.oauth, false);
  assert.equal(catalog.providers.openai.installed, true);
  assert.equal(catalog.providers.openai.loginStatus, "unknown");
  assert.equal(catalog.assignments.planning.unassigned, true);
  assert.doesNotMatch(setup.renderReport(catalog), /signed in on this machine/);
});

test("report is read-only; setup preserves metadata and choices with backup and stable bytes", () => {
  const home = tempDir("catalog-safe-");
  const target = path.join(home, "config", "model-catalog.local.json");
  const { spawnSync } = require("node:child_process");
  const run = (...args) => spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/setup-model-catalog.js"), "--home", home, ...args], {
    encoding: "utf8", env: { HOME: home, PATH: "", MYOS_MODEL_CATALOG_LOCAL: target },
  });
  assert.equal(run("--report").status, 0);
  assert.equal(fs.existsSync(target), false);
  const original = { version: 1, generatedAt: "old", metadata: { owner: "user" }, models: [{ id: "custom" }], assignments: { planning: { unassigned: true, reason: "user choice" } }, overrides: { custom: { note: "keep" } } };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = JSON.stringify(original);
  fs.writeFileSync(target, bytes);
  assert.equal(run("--report", "--json").status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
  assert.equal(run().status, 0);
  const saved = fs.readFileSync(target, "utf8");
  const parsed = JSON.parse(saved);
  for (const key of ["metadata", "models", "overrides"]) assert.deepEqual(parsed[key], original[key]);
  assert.deepEqual(parsed.assignments.planning, original.assignments.planning);
  const backups = fs.readdirSync(path.dirname(target)).filter(x => x.includes(".bak-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(target), backups[0]), "utf8"), bytes);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), saved);
  fs.writeFileSync(target, "{broken");
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "{broken");
});

test("setup keeps custom provider and local metadata while refreshing detection", () => {
  const existing = { providers: { custom: { note: "keep" }, openai: { label: "my account", oauth: true } }, local: { note: "keep", ollama: { tags: ["mine"] } } };
  const next = setup.buildModelCatalog({ existing, probes: fakeProbes({ cli: ["codex"] }) });
  assert.deepEqual(next.providers.custom, existing.providers.custom);
  assert.equal(next.providers.openai.label, "my account");
  assert.equal(next.providers.openai.oauth, false);
  assert.equal(next.local.note, "keep");
  assert.deepEqual(next.local.ollama.tags, ["mine"]);
});

test("auth status parsing distinguishes OAuth, API login, logged out, error and unsupported CLI", () => {
  const run = (stdout, status = 0, stderr = "") => (_cmd, args) => {
    assert.ok(args.includes("status"));
    return { stdout, stderr, status };
  };
  assert.equal(setup.probeLoginStatus("codex", run("", 0, "Logged in using ChatGPT")), "oauth");
  assert.equal(setup.probeLoginStatus("codex", run("Logged in using an API key")), "api");
  assert.equal(setup.probeLoginStatus("codex", run("Not logged in", 1)), "unauthenticated");
  assert.equal(setup.probeLoginStatus("codex", run("Logged in using ChatGPT", 1)), "unknown");
  assert.equal(setup.probeLoginStatus("codex", run("unknown output")), "unknown");
  assert.equal(setup.probeLoginStatus("claude", run(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))), "oauth");
  assert.equal(setup.probeLoginStatus("claude", run(JSON.stringify({ loggedIn: false }))), "unauthenticated");
  assert.equal(setup.probeLoginStatus("claude", run("not JSON")), "unknown");
  assert.equal(setup.probeLoginStatus("gemini", () => assert.fail("unsupported CLI must not be invoked")), "unknown");
});

test("Claude subscription CLI schema enables OAuth only for a successful logged-in subscription", () => {
  for (const [status, body, expected] of [
    [0, { loggedIn: true, authMethod: "claude.ai" }, true],
    [0, { loggedIn: true, authMethod: "api_key" }, false],
    [0, { loggedIn: false, authMethod: "claude.ai" }, false],
    [1, { loggedIn: true, authMethod: "claude.ai" }, false],
    [0, { loggedIn: true, authMethod: "unknown" }, false],
  ]) {
    const login = setup.probeLoginStatus("claude", (command, args) => {
      assert.equal(command, "claude");
      assert.deepEqual(args, ["auth", "status", "--json"]);
      return { status, stdout: JSON.stringify(body) };
    });
    const providers = setup.normalizeProviderAvailability({ cliAvailable: cli => cli === "claude", loginStatus: () => login, envHas: () => false });
    assert.equal(providers.anthropic.oauth, expected);
  }
});

test("CLI detection does not source shell startup files during report", () => {
  const home = tempDir("report-no-startup-");
  const marker = path.join(home, "profile-ran");
  fs.writeFileSync(path.join(home, ".profile"), "printf x > \"$HOME/profile-ran\"\n");
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/setup-model-catalog.js"), "--home", home, "--report"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
});
